-- 0021_pass_features.sql
--
-- Three things the owner asked for on 2026-09-17, after using the codes:
--
--   * A code may be set to "everything the owner has", so a feature added later reaches it without
--     the owner reissuing anything, and each feature can still be switched off for that one code.
--     So a code carries a mode (all or a list) and a list of features switched off for it.
--   * Morning means 06:00, not 07:00, and the zone is America/Detroit, because the owner is in
--     Michigan. Detroit keeps the same clock as New York, including daylight saving, but naming
--     the owner's own zone means the code says what it means rather than being right by accident.
--   * A code that has ended can be brought back for a while, rather than only being replaced.
--     Reviving clears the end, switches it on, and sets a new end in the same breath, so a revived
--     code is never accidentally permanent. A deleted code stays deleted.
--
-- Safe to run twice.

alter table public.study_ai_passes add column if not exists all_features boolean not null default false;
alter table public.study_ai_passes add column if not exists denied text[] not null default '{}';

-- The next 06:00 in the owner's zone. Before six that is this morning, after six it is tomorrow.
create or replace function public._ai_pass_morning()
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select ((date_trunc('day', (now() at time zone 'America/Detroit'))
           + interval '6 hours'
           + case when (now() at time zone 'America/Detroit')::time >= time '06:00'
                  then interval '1 day' else interval '0' end)
          at time zone 'America/Detroit');
$$;

-- What one code may actually use, right now: either everything the hub has, or the list it was
-- given, in both cases minus whatever the owner switched off for it. 'textbook' is a grant on top
-- rather than a feature of its own, and it is never included by "everything" unless it was ticked.
create or replace function public._ai_pass_may(p public.study_ai_passes, p_feature text)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
           when p.id is null or p_feature is null then false
           when p_feature = any (coalesce(p.denied, '{}')) then false
           when p_feature = 'textbook' then 'textbook' = any (coalesce(p.features, '{}'))
           when coalesce(p.all_features, false) then exists (select 1 from public.study_ai_features f where f.id = p_feature)
           else p_feature = any (coalesce(p.features, '{}'))
         end;
$$;

create or replace function public.ai_begin2(p_feature text, p_material text, p_install text, p_ip text, p_token text, p_in int, p_out int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s          public.study_ai_settings%rowtype;
  f          public.study_ai_features%rowtype;
  m          public.study_ai_models%rowtype;
  pass       public.study_ai_passes;
  v_material text := left(trim(coalesce(p_material, '')), 120);
  v_install  text := left(trim(coalesce(p_install, '')), 64);
  v_ip       text;
  v_role     text;
  v_owner    boolean := false;
  v_book     boolean := false;
  v_pass_id  bigint;
  v_reserve  bigint;
  v_spent    bigint;
  v_count    int;
  v_id       bigint;
begin
  v_ip := left(coalesce(nullif(trim(coalesce(p_ip, '')), ''), public._auth_ip()), 64);

  select * into s from public.study_ai_settings where id = 1;
  if not found or not s.enabled then
    return jsonb_build_object('ok', false, 'error', 'off');
  end if;

  select * into f from public.study_ai_features where id = left(trim(coalesce(p_feature, '')), 21);
  if not found or not f.enabled then
    return jsonb_build_object('ok', false, 'error', 'off');
  end if;

  if v_material = '' or not exists (
       select 1 from public.study_items i
        where i.id = v_material and f.tag = any (i.tags)
     ) then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end if;

  v_role := public._auth_role(p_token);
  v_owner := coalesce(v_role, '') = 'admin';
  v_book := v_owner;
  if not v_owner then
    pass := public._auth_pass(p_token);
    if pass.id is not null and public._ai_pass_may(pass, f.id) then
      v_pass_id := pass.id;
      v_book := public._ai_pass_may(pass, 'textbook');
    elsif f.mode = 'owner' then
      if pass.id is not null then return jsonb_build_object('ok', false, 'error', 'pass_feature'); end if;
      pass := public._auth_pass_any(p_token);
      return jsonb_build_object('ok', false, 'error', case when pass.id is not null then 'pass_expired' else 'owner_only' end);
    end if;
  end if;

  select * into m from public.study_ai_models where id = f.model;
  if not found or not m.enabled then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  v_reserve := public._ai_cost(m.id, least(greatest(coalesce(p_in, 0), 3000), 60000), least(greatest(coalesce(p_out, 0), 200), 4000));
  if v_reserve is null then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  perform pg_advisory_xact_lock(4801001);

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c where c.created_at >= public._ai_month_start();
  if v_spent + v_reserve > s.monthly_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'monthly_cap');
  end if;

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c where c.created_at >= public._ai_day_start();
  if v_spent + v_reserve > public._ai_day_cap(s.daily_cents, s.bonus_cents, s.bonus_at) * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'daily_cap');
  end if;

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c where c.feature = f.id and c.created_at >= public._ai_day_start();
  if v_spent + v_reserve > public._ai_day_cap(f.daily_cents, f.bonus_cents, f.bonus_at) * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'feature_cap');
  end if;

  if v_pass_id is not null then
    select * into pass from public.study_ai_passes where id = v_pass_id;
    if not found or not public._ai_pass_live(pass) or not public._ai_pass_may(pass, f.id) then
      return jsonb_build_object('ok', false, 'error', case when found and public._ai_pass_live(pass) then 'pass_feature' else 'pass_expired' end);
    end if;
    if public._ai_pass_spent(pass.id) + v_reserve > pass.budget_microcents then
      return jsonb_build_object('ok', false, 'error', 'pass_spent');
    end if;
    if pass.daily_cents is not null then
      select coalesce(sum(c.cost_microcents), 0) into v_spent
        from public.study_ai_calls c where c.pass_id = pass.id and c.created_at >= public._ai_day_start();
      if v_spent + v_reserve > pass.daily_cents::bigint * 1000000 then
        return jsonb_build_object('ok', false, 'error', 'pass_day');
      end if;
    end if;
    select count(*) into v_count from public.study_ai_calls c
     where c.pass_id = pass.id and c.created_at > now() - interval '1 minute';
    if v_count >= pass.per_minute then
      return jsonb_build_object('ok', false, 'error', 'slow_down');
    end if;
  elsif not v_owner and f.mode = 'open' then
    if length(v_install) < 8 then
      return jsonb_build_object('ok', false, 'error', 'bad_install');
    end if;
    select count(*) into v_count from public.study_ai_calls c
     where c.install = v_install and c.status in ('ok', 'pending') and c.created_at >= public._ai_day_start();
    if v_count >= s.per_install_daily then
      return jsonb_build_object('ok', false, 'error', 'device_cap');
    end if;
    select count(*) into v_count from public.study_ai_calls c
     where c.ip = v_ip and c.created_at > now() - interval '1 minute';
    if v_count >= s.per_ip_minute then
      return jsonb_build_object('ok', false, 'error', 'slow_down');
    end if;
  end if;

  insert into public.study_ai_calls (material, install, ip, model, status, cost_microcents, feature, pass_id)
  values (v_material, nullif(v_install, ''), v_ip, m.id, 'pending', v_reserve, f.id, v_pass_id)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort,
                            'beyond', f.beyond, 'textbook', v_book);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

create or replace function public.ai_status2(p_material text, p_feature text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s public.study_ai_settings%rowtype;
  f public.study_ai_features%rowtype;
  p public.study_ai_passes;
  v_tagged boolean := false; v_role text; v_left bigint; v_out jsonb;
begin
  select * into s from public.study_ai_settings where id = 1;
  select * into f from public.study_ai_features where id = left(trim(coalesce(p_feature, '')), 21);
  if f.id is null then
    return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'tagged', false,
                              'available', false, 'beta', true, 'may', false, 'why', 'unavailable');
  end if;
  select exists (select 1 from public.study_items i
                  where i.id = left(trim(coalesce(p_material, '')), 120) and f.tag = any (i.tags)) into v_tagged;

  v_out := jsonb_build_object(
    'ok', true,
    'enabled', coalesce(s.enabled, false) and f.enabled,
    'mode', f.mode,
    'tagged', v_tagged,
    'available', coalesce(s.enabled, false) and f.enabled and v_tagged,
    'beta', f.beta);

  if not (coalesce(s.enabled, false) and f.enabled) then
    return v_out || jsonb_build_object('may', false, 'why', 'off');
  end if;
  if not v_tagged then
    return v_out || jsonb_build_object('may', false, 'why', 'unavailable');
  end if;

  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') = 'admin' then
    return v_out || jsonb_build_object('may', true, 'why', 'owner');
  end if;

  p := public._auth_pass(p_token);
  if p.id is not null and public._ai_pass_may(p, f.id) then
    v_left := p.budget_microcents - public._ai_pass_spent(p.id);
    return v_out || jsonb_build_object('may', v_left > 0, 'why', case when v_left > 0 then 'pass' else 'pass_spent' end,
      'pass', jsonb_build_object('label', p.label, 'expires_at', p.expires_at,
        'left_cents', round(greatest(v_left, 0)::numeric / 1000000, 2)));
  end if;

  if f.mode = 'open' then
    return v_out || jsonb_build_object('may', true, 'why', 'open');
  end if;
  if p.id is not null then
    return v_out || jsonb_build_object('may', false, 'why', 'pass_feature');
  end if;
  p := public._auth_pass_any(p_token);
  if p.id is not null then
    return v_out || jsonb_build_object('may', false, 'why', 'pass_expired',
      'pass', jsonb_build_object('label', p.label, 'expires_at', p.expires_at, 'left_cents', 0));
  end if;
  return v_out || jsonb_build_object('may', false, 'why', 'owner_only');
exception when others then
  return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'tagged', false,
                            'available', false, 'beta', true, 'may', false, 'why', 'rejected');
end $$;

-- The panel reads the mode, the list and what is switched off, and every feature the hub has, so
-- it can draw one switch per feature for each code.
create or replace function public.admin_passes(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb; v_feats jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'enabled', f.enabled) order by f.id), '[]'::jsonb)
    into v_feats from public.study_ai_features f;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'label', p.label, 'enabled', p.enabled,
           'features', to_jsonb(p.features), 'all_features', p.all_features, 'denied', to_jsonb(p.denied),
           'expires_at', p.expires_at, 'created_at', p.created_at,
           'last_used_at', p.last_used_at, 'revoked_at', p.revoked_at, 'note', p.note,
           'daily_cents', p.daily_cents, 'per_minute', p.per_minute,
           'live', public._ai_pass_live(p.*),
           'may_ask', public._ai_pass_may(p.*, 'ask'),
           'may_book', public._ai_pass_may(p.*, 'textbook'),
           'budget_cents', round(p.budget_microcents::numeric / 1000000, 2),
           'spent_cents',  round(public._ai_pass_spent(p.id)::numeric / 1000000, 2),
           'left_cents',   round(greatest(p.budget_microcents - public._ai_pass_spent(p.id), 0)::numeric / 1000000, 2),
           'calls', (select count(*) from public.study_ai_calls c where c.pass_id = p.id),
           'sessions', (select count(*) from public.study_sessions x where x.pass_id = p.id and not x.revoked and x.expires_at > now())
         ) order by p.id desc), '[]'::jsonb)
    into v_out
    from public.study_ai_passes p;

  return jsonb_build_object('ok', true, 'passes', v_out, 'features', v_feats, 'now', now(), 'zone', 'America/Detroit');
end $$;

-- One code's settings. New here: all_features, one feature switched on or off by name, and
-- revive, which brings a revoked or ended code back and must say for how long.
create or replace function public.admin_pass_set(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_when text; v_feats text[]; v_exp timestamptz; v_hours numeric;
        v_name text; v_on boolean;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_pass is null or jsonb_typeof(p_pass) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_pass');
  end if;

  select * into p from public.study_ai_passes where id = (p_pass ->> 'id')::bigint for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_pass ? 'enabled' then
    if jsonb_typeof(p_pass -> 'enabled') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'enabled');
    end if;
    p.enabled := (p_pass ->> 'enabled')::boolean;
  end if;

  if p_pass ? 'all_features' then
    if jsonb_typeof(p_pass -> 'all_features') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'all_features');
    end if;
    p.all_features := (p_pass ->> 'all_features')::boolean;
  end if;

  /* One switch, by name: { feature: 'ask', on: false }. Off is recorded as a denial so it keeps
     holding when the code is set to everything the owner has. */
  if p_pass ? 'feature' then
    v_name := left(trim(coalesce(p_pass ->> 'feature', '')), 21);
    if v_name = '' or not (v_name = 'textbook' or exists (select 1 from public.study_ai_features f where f.id = v_name)) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'feature');
    end if;
    v_on := coalesce((p_pass ->> 'on')::boolean, false);
    if v_on then
      p.denied := array_remove(coalesce(p.denied, '{}'), v_name);
      if not (v_name = any (coalesce(p.features, '{}'))) then
        p.features := coalesce(p.features, '{}') || v_name;
      end if;
    else
      if not (v_name = any (coalesce(p.denied, '{}'))) then
        p.denied := coalesce(p.denied, '{}') || v_name;
      end if;
      p.features := array_remove(coalesce(p.features, '{}'), v_name);
    end if;
  end if;

  if p_pass ? 'label' then p.label := left(trim(coalesce(p_pass ->> 'label', p.label)), 60); end if;
  if p_pass ? 'note'  then p.note  := left(trim(coalesce(p_pass ->> 'note', '')), 200); end if;

  if jsonb_typeof(p_pass -> 'add_cents') = 'number' then
    p.budget_microcents := greatest(0, least(
      p.budget_microcents + ((p_pass ->> 'add_cents')::numeric * 1000000)::bigint,
      10000::bigint * 1000000));
  end if;
  if jsonb_typeof(p_pass -> 'budget_cents') = 'number' then
    p.budget_microcents := (greatest(0, least((p_pass ->> 'budget_cents')::numeric, 10000)) * 1000000)::bigint;
  end if;

  if p_pass ? 'daily_cents' then
    if jsonb_typeof(p_pass -> 'daily_cents') = 'null' then p.daily_cents := null;
    elsif jsonb_typeof(p_pass -> 'daily_cents') = 'number' then
      p.daily_cents := greatest(0, least((p_pass ->> 'daily_cents')::int, 10000));
    else return jsonb_build_object('ok', false, 'error', 'range', 'field', 'daily_cents'); end if;
  end if;

  if jsonb_typeof(p_pass -> 'per_minute') = 'number' then
    p.per_minute := greatest(1, least((p_pass ->> 'per_minute')::int, 60));
  end if;

  if jsonb_typeof(p_pass -> 'features') = 'array' then
    v_feats := public._ai_pass_feats(p_pass -> 'features');
    if v_feats is null or array_length(v_feats, 1) is null then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'features');
    end if;
    p.features := v_feats;
    p.denied := '{}';
  end if;

  /* Revive: a code that was ended or revoked comes back, and must be told for how long, so a
     revived code can never be permanent by accident. */
  if coalesce((p_pass ->> 'revive')::boolean, false) then
    v_when := lower(trim(coalesce(p_pass ->> 'when', '')));
    if v_when not in ('morning', 'hours', 'at') then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'when');
    end if;
    p.revoked_at := null;
    p.enabled := true;
  end if;

  if p_pass ? 'when' then
    v_when := lower(trim(coalesce(p_pass ->> 'when', '')));
    if v_when = 'morning' then p.expires_at := public._ai_pass_morning();
    elsif v_when = 'hours' then
      v_hours := greatest(0.25, least(coalesce((p_pass ->> 'hours')::numeric, 3), 720));
      p.expires_at := now() + (v_hours * interval '1 hour');
    elsif v_when = 'none' then p.expires_at := null;
    elsif v_when = 'now' then p.expires_at := now();
    else
      if not (p_pass ? 'expires_at') then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'when');
      end if;
      v_exp := (p_pass ->> 'expires_at')::timestamptz;
      if v_exp is null then return jsonb_build_object('ok', false, 'error', 'range', 'field', 'expires_at'); end if;
      p.expires_at := v_exp;
    end if;
  end if;

  if coalesce((p_pass ->> 'revoke')::boolean, false) then
    p.revoked_at := now();
    p.enabled := false;
  end if;

  update public.study_ai_passes
     set label = p.label, note = p.note, enabled = p.enabled, features = p.features, denied = p.denied,
         all_features = p.all_features, budget_microcents = p.budget_microcents, daily_cents = p.daily_cents,
         per_minute = p.per_minute, expires_at = p.expires_at, revoked_at = p.revoked_at
   where id = p.id;

  if p.revoked_at is not null then
    update public.study_sessions set revoked = true where pass_id = p.id and not revoked;
  end if;

  select * into p from public.study_ai_passes where id = p.id;
  return jsonb_build_object('ok', true, 'pass', jsonb_build_object(
    'id', p.id, 'label', p.label, 'enabled', p.enabled, 'live', public._ai_pass_live(p.*),
    'features', to_jsonb(p.features), 'denied', to_jsonb(p.denied), 'all_features', p.all_features,
    'may_ask', public._ai_pass_may(p.*, 'ask'), 'may_book', public._ai_pass_may(p.*, 'textbook'),
    'expires_at', p.expires_at, 'revoked_at', p.revoked_at,
    'daily_cents', p.daily_cents, 'per_minute', p.per_minute,
    'budget_cents', round(p.budget_microcents::numeric / 1000000, 2),
    'spent_cents', round(public._ai_pass_spent(p.id)::numeric / 1000000, 2),
    'left_cents', round(greatest(p.budget_microcents - public._ai_pass_spent(p.id), 0)::numeric / 1000000, 2)),
    'now', now());
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- create also takes the mode, so a code can start as everything the owner has.
create or replace function public.admin_pass_create(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role text; v_code text := ''; v_alpha text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_label text; v_feats text[]; v_budget bigint; v_expires timestamptz; v_daily int; v_id bigint; i int;
  v_when text; v_hours numeric; v_all boolean := false;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_pass is null or jsonb_typeof(p_pass) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_pass');
  end if;

  v_label := left(trim(coalesce(p_pass ->> 'label', '')), 60);
  if v_label = '' then return jsonb_build_object('ok', false, 'error', 'range', 'field', 'label'); end if;

  if jsonb_typeof(p_pass -> 'all_features') = 'boolean' then v_all := (p_pass ->> 'all_features')::boolean; end if;
  if jsonb_typeof(p_pass -> 'features') = 'array' then v_feats := public._ai_pass_feats(p_pass -> 'features'); end if;
  if v_feats is null or array_length(v_feats, 1) is null then
    v_feats := case when v_all then '{}'::text[] else array['ask'] end;
  end if;

  v_budget := (greatest(0, least(coalesce((p_pass ->> 'budget_cents')::numeric, 0), 10000)) * 1000000)::bigint;

  v_when := lower(trim(coalesce(p_pass ->> 'when', 'none')));
  if v_when = 'morning' then v_expires := public._ai_pass_morning();
  elsif v_when = 'hours' then
    v_hours := greatest(0.25, least(coalesce((p_pass ->> 'hours')::numeric, 3), 720));
    v_expires := now() + (v_hours * interval '1 hour');
  elsif v_when = 'none' or v_when = '' then v_expires := null;
  else
    if not (p_pass ? 'expires_at') then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'when');
    end if;
    v_expires := (p_pass ->> 'expires_at')::timestamptz;
    if v_expires is null or v_expires <= now() then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'expires_at');
    end if;
  end if;

  if jsonb_typeof(p_pass -> 'daily_cents') = 'number' then
    v_daily := greatest(0, least((p_pass ->> 'daily_cents')::int, 10000));
  end if;

  for i in 1..12 loop
    v_code := v_code || substr(v_alpha, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
  end loop;

  insert into public.study_ai_passes (label, code_hash, code_tail, code_fp, features, all_features,
                                      budget_microcents, daily_cents, expires_at, note)
  values (v_label, crypt(v_code, gen_salt('bf', 12)), '', public._ai_pass_fp(v_code), v_feats, v_all,
          v_budget, v_daily, v_expires, left(trim(coalesce(p_pass ->> 'note', '')), 200))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'expires_at', v_expires,
                            'features', to_jsonb(v_feats), 'all_features', v_all, 'daily_cents', v_daily,
                            'budget_cents', round(v_budget::numeric / 1000000, 2), 'zone', 'America/Detroit');
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- Where the money went, in the owner's own zone.
create or replace function public.admin_pass_spend(p_token text, p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_mat jsonb; v_day jsonb; v_recent jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(t order by t.cents desc), '[]'::jsonb) into v_mat from (
    select c.material, c.feature, count(*) as calls, round(sum(c.cost_microcents)::numeric / 1000000, 4) as cents
      from public.study_ai_calls c where c.pass_id = p_id group by c.material, c.feature) t;

  select coalesce(jsonb_agg(t order by t.day desc), '[]'::jsonb) into v_day from (
    select (c.created_at at time zone 'America/Detroit')::date as day, count(*) as calls,
           round(sum(c.cost_microcents)::numeric / 1000000, 4) as cents
      from public.study_ai_calls c where c.pass_id = p_id group by 1) t;

  select coalesce(jsonb_agg(t order by t.id desc), '[]'::jsonb) into v_recent from (
    select c.id, c.created_at, c.material, c.feature, c.status,
           round(c.cost_microcents::numeric / 1000000, 4) as cents
      from public.study_ai_calls c where c.pass_id = p_id order by c.id desc limit 20) t;

  return jsonb_build_object('ok', true, 'by_material', v_mat, 'by_day', v_day, 'recent', v_recent, 'zone', 'America/Detroit');
end $$;

revoke all on function public._ai_pass_may(public.study_ai_passes, text) from public, anon, authenticated;
revoke all on function public.ai_begin2(text, text, text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.ai_begin2(text, text, text, text, text, int, int) to service_role;
revoke all on function public.ai_status2(text, text, text) from public;
grant execute on function public.ai_status2(text, text, text) to anon;
revoke all on function public.admin_passes(text) from public;
grant execute on function public.admin_passes(text) to anon;
revoke all on function public.admin_pass_set(text, jsonb) from public;
grant execute on function public.admin_pass_set(text, jsonb) to anon;
revoke all on function public.admin_pass_create(text, jsonb) from public;
grant execute on function public.admin_pass_create(text, jsonb) to anon;
revoke all on function public.admin_pass_spend(text, bigint) from public;
grant execute on function public.admin_pass_spend(text, bigint) to anon;
