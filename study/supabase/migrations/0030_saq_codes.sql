-- 0030_saq_codes.sql
--
-- SAQ grading follows the same access rules as Ask. The owner asked on 2026-09-17 that every AI
-- feature be for them and the people they give a code to, and nobody else. SAQ grading (0010)
-- predates access codes: in "Open with caps" anyone could use it, and in "Owner only" a code
-- holder could not. From here:
--
--   * ai_begin accepts a live code that carries 'saq' (switched on for the code, or the code has
--     everything the owner has) and checks it exactly as ai_begin2 does since 0026: the code's own
--     money, daily cap and per minute limit, under the same lock, never the owner's caps. Its
--     ledger rows now carry the feature and the code.
--   * _ai_pass_may, admin_pass_set and _ai_pass_feats know 'saq', which has no row in
--     study_ai_features (its settings are the global ones, 0010), the way they know 'textbook'.
--   * ai_status(material, token): the page's question gets a per caller answer, may and why, the
--     way ai_status2 answers for Ask, so a visitor is never shown a grade button that refuses.
--     The one argument form stays for pages not yet republished.
--   * SAQ grading is set to owner only, the owner's choice. The panel can open it again.
--
-- Safe to run twice.

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
           when p_feature = 'saq' then coalesce(p.all_features, false) or 'saq' = any (coalesce(p.features, '{}'))
           when coalesce(p.all_features, false) then exists (select 1 from public.study_ai_features f where f.id = p_feature)
           else p_feature = any (coalesce(p.features, '{}'))
         end;
$$;

create or replace function public._ai_pass_feats(p_in jsonb)
returns text[]
language sql
stable
set search_path = pg_catalog, public
as $$
  select array_agg(x) from jsonb_array_elements_text(p_in) x
   where x in (select id from public.study_ai_features) or x in ('textbook', 'saq');
$$;

create or replace function public.admin_pass_set(p_token text, p_pass jsonb)

returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_when text; v_feats text[]; v_exp timestamptz; v_hours numeric;
        v_name text; v_on boolean; v_from timestamptz;
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

  if p_pass ? 'feature' then
    v_name := left(trim(coalesce(p_pass ->> 'feature', '')), 21);
    if v_name = '' or not (v_name in ('textbook', 'saq') or exists (select 1 from public.study_ai_features f where f.id = v_name)) then
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

  if coalesce((p_pass ->> 'revive')::boolean, false) then
    v_when := lower(trim(coalesce(p_pass ->> 'when', '')));
    if v_when not in ('morning', 'hours', 'at', 'local') then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'when');
    end if;
    p.revoked_at := null;
    p.enabled := true;
  end if;

  /* Add to the end it already has. A code that has lapsed counts from now; a code with no end is
     left alone, because "never" plus an hour is not an extension. */
  if jsonb_typeof(p_pass -> 'extend_hours') = 'number' then
    if p.expires_at is null then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'extend_hours');
    end if;
    v_hours := greatest(-720, least((p_pass ->> 'extend_hours')::numeric, 720));
    v_from := greatest(p.expires_at, now());
    p.expires_at := v_from + (v_hours * interval '1 hour');
  end if;

  if p_pass ? 'when' then
    v_when := lower(trim(coalesce(p_pass ->> 'when', '')));
    if v_when = 'morning' then p.expires_at := public._ai_pass_morning();
    elsif v_when = 'hours' then
      v_hours := greatest(0.25, least(coalesce((p_pass ->> 'hours')::numeric, 3), 720));
      p.expires_at := now() + (v_hours * interval '1 hour');
    elsif v_when = 'local' then
      /* A wall clock time the owner typed, read in their own zone. The browser's clock plays no
         part: only the characters they typed cross the wire. */
      begin
        p.expires_at := (left(trim(coalesce(p_pass ->> 'local', '')), 19)::timestamp at time zone 'America/Detroit');
      exception when others then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'local');
      end;
      if p.expires_at is null then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'local');
      end if;
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

create or replace function public.ai_begin(p_material text, p_install text, p_ip text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s          public.study_ai_settings%rowtype;
  m          public.study_ai_models%rowtype;
  v_material text := left(trim(coalesce(p_material, '')), 120);
  v_install  text := left(trim(coalesce(p_install, '')), 64);
  v_ip       text;
  v_owner    boolean;
  pass       public.study_ai_passes;
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

  if v_material = '' or not exists (
       select 1 from public.study_items i
        where i.id = v_material and 'ai' = any (i.tags)
     ) then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end if;

  v_owner := coalesce(public._auth_role(p_token), '') = 'admin';
  if not v_owner then
    pass := public._auth_pass(p_token);
    if pass.id is not null and public._ai_pass_may(pass, 'saq') then
      v_pass_id := pass.id;
    elsif s.mode = 'owner' then
      if pass.id is not null then return jsonb_build_object('ok', false, 'error', 'pass_feature'); end if;
      pass := public._auth_pass_any(p_token);
      return jsonb_build_object('ok', false, 'error', case when pass.id is not null then 'pass_expired' else 'owner_only' end);
    end if;
  end if;

  select * into m from public.study_ai_models where id = s.model;
  if not found or not m.enabled then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  v_reserve := public._ai_cost(m.id, 2000, 400);
  if v_reserve is null then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  perform pg_advisory_xact_lock(4801001);

  if v_pass_id is null then
    select coalesce(sum(c.cost_microcents), 0) into v_spent
      from public.study_ai_calls c
     where c.created_at >= public._ai_month_start() and c.pass_id is null;
    if v_spent + v_reserve > s.monthly_cents::bigint * 1000000 then
      return jsonb_build_object('ok', false, 'error', 'monthly_cap');
    end if;

    select coalesce(sum(c.cost_microcents), 0) into v_spent
      from public.study_ai_calls c
     where c.created_at >= public._ai_day_start() and c.pass_id is null;
    if v_spent + v_reserve > s.daily_cents::bigint * 1000000 then
      return jsonb_build_object('ok', false, 'error', 'daily_cap');
    end if;
  end if;

  if v_pass_id is not null then
    /* The code's own limits, read again under the lock, as ai_begin2 does (0026). */
    select * into pass from public.study_ai_passes where id = v_pass_id;
    if not found or not public._ai_pass_live(pass) or not public._ai_pass_may(pass, 'saq') then
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
  elsif s.mode = 'open' and not v_owner then
    if length(v_install) < 8 then
      return jsonb_build_object('ok', false, 'error', 'bad_install');
    end if;
    select count(*) into v_count
      from public.study_ai_calls c
     where c.install = v_install
       and c.status in ('ok', 'pending')
       and c.created_at >= public._ai_day_start();
    if v_count >= s.per_install_daily then
      return jsonb_build_object('ok', false, 'error', 'device_cap');
    end if;
    select count(*) into v_count
      from public.study_ai_calls c
     where c.ip = v_ip
       and c.created_at > now() - interval '1 minute';
    if v_count >= s.per_ip_minute then
      return jsonb_build_object('ok', false, 'error', 'slow_down');
    end if;
  end if;

  insert into public.study_ai_calls (material, install, ip, model, status, cost_microcents, feature, pass_id, who)
  values (v_material, nullif(v_install, ''), v_ip, m.id, 'pending', v_reserve, 'saq', v_pass_id,
          case when v_owner then 'owner' when v_pass_id is not null then 'pass' else 'open' end)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort, 'max_chars', s.max_chars);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

create or replace function public.ai_status(p_material text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s        public.study_ai_settings%rowtype;
  p        public.study_ai_passes;
  v_tagged boolean;
  v_out    jsonb;
  v_left   bigint;
begin
  select * into s from public.study_ai_settings where id = 1;
  if not found then
    return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'model', null, 'tagged', false,
                              'available', false, 'may', false, 'why', 'off');
  end if;
  select exists (select 1 from public.study_items i
                  where i.id = left(trim(coalesce(p_material, '')), 120) and 'ai' = any (i.tags)) into v_tagged;
  v_out := jsonb_build_object('ok', true, 'enabled', s.enabled, 'mode', s.mode, 'model', s.model,
                              'tagged', v_tagged, 'available', s.enabled and v_tagged);
  if not s.enabled then return v_out || jsonb_build_object('may', false, 'why', 'off'); end if;
  if not v_tagged then return v_out || jsonb_build_object('may', false, 'why', 'unavailable'); end if;
  if coalesce(public._auth_role(p_token), '') = 'admin' then
    return v_out || jsonb_build_object('may', true, 'why', 'owner');
  end if;
  p := public._auth_pass(p_token);
  if p.id is not null and public._ai_pass_may(p, 'saq') then
    v_left := p.budget_microcents - public._ai_pass_spent(p.id);
    return v_out || jsonb_build_object('may', v_left > 0, 'why', case when v_left > 0 then 'pass' else 'pass_spent' end);
  end if;
  if s.mode = 'open' then return v_out || jsonb_build_object('may', true, 'why', 'open'); end if;
  return v_out || jsonb_build_object('may', false, 'why', 'owner_only');
exception when others then
  return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'model', null, 'tagged', false,
                            'available', false, 'may', false, 'why', 'rejected');
end $$;

revoke all on function public.ai_status(text, text) from public;
grant execute on function public.ai_status(text, text) to anon;
revoke all on function public.admin_pass_set(text, jsonb) from public;
grant execute on function public.admin_pass_set(text, jsonb) to anon;

update public.study_ai_settings set mode = 'owner', updated_at = now() where id = 1 and mode <> 'owner';

notify pgrst, 'reload schema';
