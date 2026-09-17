-- 0019_ai_passes_fixes.sql
--
-- What an adversarial review of 0017 found, fixed. In order of how much it mattered:
--
--   * A pass could pull the private textbook. The corpus (0013) is the owner's alone, and the
--     Edge Function decided from a flag the page sent. ai_begin2 now says whether a call may use
--     it, true only for the owner, and the function reads that instead of the request.
--   * A pass holder was refused a feature that was open to strangers, because the pass's own list
--     was the only thing consulted. An open feature is open to them too.
--   * Every failed login ran one bcrypt per live pass, so a few dozen passes would have made
--     signing in slow enough to fail for everyone, the owner included. A short fingerprint of the
--     code narrows the loop to one row before any bcrypt runs. The fingerprint replaces the last
--     four characters, which were stored in the clear and, next to the sync table's unsalted hash
--     of the same code, cut a stolen database's work from 2^60 to 2^40.
--   * A call that never closed held its reserve against a pass's money for ever, because a pass
--     budget has no day boundary to lapse at. A pending row older than ten minutes stops counting.
--   * Ending a pass signed the person out of the hub and would not let them back in. Now it takes
--     away the AI and nothing else: they keep the hub, their materials and their saved progress,
--     and the code still signs them in. Deleting a pass is what ends a session.
--   * A pass holder's thumbs up did nothing, because rating was owner only. They may rate the
--     answers they were given.
--   * admin_pass_set threw where it meant to refuse, and could deadlock against a question being
--     asked at the same moment; it now refuses in the house form and takes its locks in the same
--     order as ai_begin2.
--   * The panel offered a pass "short answer grading", which the grader's own gate (0010) never
--     honoured. The offer is gone until ai_begin gets the same pass branch.
--
-- Safe to run twice.

alter table public.study_ai_passes add column if not exists code_fp text;

-- "In the morning" means the next 07:00 in New York, which before 07:00 is today. 0017 added a
-- day unconditionally, so a code made at one in the morning ran for thirty hours rather than six.
create or replace function public._ai_pass_morning()
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select ((date_trunc('day', (now() at time zone 'America/New_York'))
           + interval '7 hours'
           + case when (now() at time zone 'America/New_York')::time >= time '07:00'
                  then interval '1 day' else interval '0' end)
          at time zone 'America/New_York');
$$;

-- The pass a session came from, live or not, so a refusal can say "your code has ended" rather
-- than "owner only", which is both false and unactionable.
create or replace function public._auth_pass_any(p_token text)
returns public.study_ai_passes
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_hash text; v_pass_id bigint; p public.study_ai_passes;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  select pass_id into v_pass_id from public.study_sessions
   where token_hash = v_hash and not revoked and expires_at > now();
  if v_pass_id is null then return null; end if;
  select * into p from public.study_ai_passes where id = v_pass_id;
  return p;
end $$;

-- The first eight hex of the code's SHA-256. It narrows a login to one row without revealing any
-- of the code itself; the other 224 bits stay behind bcrypt.
create or replace function public._ai_pass_fp(p_code text)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions
as $$
  select substr(encode(digest(coalesce(p_code, ''), 'sha256'), 'hex'), 1, 8);
$$;

update public.study_ai_passes set code_fp = null where false;  -- no back fill is possible: see below
create index if not exists study_ai_passes_fp on public.study_ai_passes (code_fp);

-- Rows minted before this migration have no fingerprint. They are still found by the old full
-- loop, which is kept as a fall back for exactly those rows, so nothing already handed out breaks.

create or replace function public._ai_pass_live(p public.study_ai_passes)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(p.enabled, false)
     and p.revoked_at is null
     and (p.expires_at is null or p.expires_at > now());
$$;

-- A pass's money: its own ledger rows, open ones counted at their reserve, except a reserve that
-- has been open longer than any call can run, which belongs to a worker that died.
create or replace function public._ai_pass_spent(p_id bigint)
returns bigint
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(c.cost_microcents), 0)::bigint
    from public.study_ai_calls c
   where c.pass_id = p_id
     and not (c.status = 'pending' and c.created_at < now() - interval '10 minutes');
$$;

-- The pass behind a token, or null when it is not live. A session is left alone: losing the AI
-- must not lose someone the hub, their materials or their saved work. Deleting a pass is what
-- takes its sessions with it (admin_pass_delete).
create or replace function public._auth_pass(p_token text)
returns public.study_ai_passes
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_hash text; v_pass_id bigint; v_exp timestamptz; v_revoked boolean; p public.study_ai_passes;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  select pass_id, expires_at, revoked into v_pass_id, v_exp, v_revoked
    from public.study_sessions where token_hash = v_hash;
  if not found or v_revoked or v_exp < now() or v_pass_id is null then return null; end if;

  select * into p from public.study_ai_passes where id = v_pass_id;
  if not found or not public._ai_pass_live(p) then return null; end if;

  update public.study_ai_passes set last_used_at = now() where id = p.id;
  return p;
end $$;

-- ---------------------------------------------------------------- login
-- The fingerprint picks the candidate row, so one bcrypt runs however many passes exist. A pass
-- that has ended still signs in: it is their sync code and their way into the hub, and the AI
-- checks liveness separately on every call.
create or replace function public.auth_login(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_ip      text := public._auth_ip();
  v_role    text;
  v_pass_id bigint;
  v_token   text;
  v_exp     timestamptz;
  r         record;
begin
  perform public._auth_rate_check(v_ip);

  if p_code is null or length(p_code) < 4 then
    perform public._auth_rate_fail(v_ip);
    return jsonb_build_object('ok', false);
  end if;

  for r in select role, code_hash from public.study_codes order by role loop
    if r.code_hash = crypt(p_code, r.code_hash) then
      v_role := r.role;
    end if;
  end loop;

  if v_role is null then
    for r in select id, code_hash from public.study_ai_passes
              where revoked_at is null
                and (code_fp = public._ai_pass_fp(p_code) or code_fp is null)
              order by id loop
      if r.code_hash = crypt(p_code, r.code_hash) then
        v_role := 'viewer';
        v_pass_id := r.id;
        /* Fingerprint an older row the first time its code is seen again, so the next login is
           one bcrypt rather than a sweep. */
        update public.study_ai_passes set code_fp = public._ai_pass_fp(p_code)
         where id = r.id and code_fp is null;
      end if;
    end loop;
  end if;

  if v_role is null then
    perform public._auth_rate_fail(v_ip);
    return jsonb_build_object('ok', false);
  end if;

  v_token := encode(gen_random_bytes(32), 'base64');
  v_exp   := now() + interval '180 days';
  insert into public.study_sessions (token_hash, role, expires_at, pass_id)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_role, v_exp, v_pass_id);

  return jsonb_build_object('ok', true, 'token', v_token, 'role', v_role, 'expires_at', v_exp,
                            'pass', v_pass_id is not null);
end $$;

-- ---------------------------------------------------------------- may this session ask
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
  if p.id is not null and f.id = any (p.features) then
    v_left := p.budget_microcents - public._ai_pass_spent(p.id);
    return v_out || jsonb_build_object('may', v_left > 0, 'why', case when v_left > 0 then 'pass' else 'pass_spent' end,
      'pass', jsonb_build_object('label', p.label, 'expires_at', p.expires_at,
        'left_cents', round(greatest(v_left, 0)::numeric / 1000000, 2)));
  end if;

  /* An open feature is open to everyone, a pass holder included: paying must never get less. */
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

-- ---------------------------------------------------------------- ai_begin2
-- As 0017, with three changes: an open feature is open to a pass holder as well, the reply says
-- whether this call may read the private textbook (the owner only), and the input reserve has a
-- floor that a forged body cannot duck under.
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
  if not v_owner then
    pass := public._auth_pass(p_token);
    if pass.id is not null and f.id = any (pass.features) then
      v_pass_id := pass.id;
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
    if not found or not public._ai_pass_live(pass) then
      return jsonb_build_object('ok', false, 'error', 'pass_expired');
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

  /* textbook: the private corpus (0013) is the owner's own copy of their course book. Only the
     owner's own calls may draw on it, whoever else may use the feature. */
  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort,
                            'beyond', f.beyond, 'textbook', v_owner);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- rating
-- The owner rates any answer; a pass holder rates the answers they were given.
create or replace function public.ai_chat_rate(p_token text, p_chat_id bigint, p_rating int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_ok boolean := false;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') = 'admin' then v_ok := true;
  else
    p := public._auth_pass(p_token);
    if p.id is not null then
      v_ok := exists (select 1 from public.study_ai_chats c
                        join public.study_ai_calls l on l.id = c.call_id
                       where c.id = p_chat_id and l.pass_id = p.id);
    end if;
  end if;
  if not v_ok then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_rating is not null and p_rating not in (-1, 1) then
    return jsonb_build_object('ok', false, 'error', 'range');
  end if;
  update public.study_ai_chats set rating = p_rating, rated_at = case when p_rating is null then null else now() end
   where id = p_chat_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- the owner's controls
-- create: 'hours' is worked out here, not on a device whose clock may be wrong. saq is not
-- offered, because the grader's own gate does not honour a pass.
create or replace function public.admin_pass_create(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role text; v_code text := ''; v_alpha text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_label text; v_feats text[]; v_budget bigint; v_expires timestamptz; v_daily int; v_id bigint; i int;
  v_when text; v_hours numeric;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_pass is null or jsonb_typeof(p_pass) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_pass');
  end if;

  v_label := left(trim(coalesce(p_pass ->> 'label', '')), 60);
  if v_label = '' then return jsonb_build_object('ok', false, 'error', 'range', 'field', 'label'); end if;

  if jsonb_typeof(p_pass -> 'features') = 'array' then
    select array_agg(x) into v_feats from jsonb_array_elements_text(p_pass -> 'features') x
     where x in (select id from public.study_ai_features);
  end if;
  if v_feats is null or array_length(v_feats, 1) is null then v_feats := array['ask']; end if;

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

  insert into public.study_ai_passes (label, code_hash, code_tail, code_fp, features, budget_microcents, daily_cents, expires_at, note)
  values (v_label, crypt(v_code, gen_salt('bf', 12)), '', public._ai_pass_fp(v_code), v_feats, v_budget, v_daily, v_expires,
          left(trim(coalesce(p_pass ->> 'note', '')), 200))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'expires_at', v_expires,
                            'features', to_jsonb(v_feats), 'daily_cents', v_daily,
                            'budget_cents', round(v_budget::numeric / 1000000, 2), 'zone', 'America/New_York');
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

create or replace function public.admin_pass_set(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_when text; v_feats text[]; v_exp timestamptz; v_hours numeric;
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

  if p_pass ? 'label' then p.label := left(trim(coalesce(p_pass ->> 'label', p.label)), 60); end if;
  if p_pass ? 'note'  then p.note  := left(trim(coalesce(p_pass ->> 'note', '')), 200); end if;

  /* Money is clamped on the total, not only on one step, so a row of small additions cannot walk
     a pass past the ceiling one dollar at a time. */
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
    select array_agg(x) into v_feats from jsonb_array_elements_text(p_pass -> 'features') x
     where x in (select id from public.study_ai_features);
    if v_feats is null or array_length(v_feats, 1) is null then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'features');
    end if;
    p.features := v_feats;
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
     set label = p.label, note = p.note, enabled = p.enabled, features = p.features,
         budget_microcents = p.budget_microcents, daily_cents = p.daily_cents,
         per_minute = p.per_minute, expires_at = p.expires_at, revoked_at = p.revoked_at
   where id = p.id;

  /* Only a revoked pass takes its sessions with it. An ended or switched off pass leaves the
     person signed in: they lose the AI, not the hub. */
  if p.revoked_at is not null then
    update public.study_sessions set revoked = true where pass_id = p.id and not revoked;
  end if;

  select * into p from public.study_ai_passes where id = p.id;
  return jsonb_build_object('ok', true, 'pass', jsonb_build_object(
    'id', p.id, 'label', p.label, 'enabled', p.enabled, 'live', public._ai_pass_live(p.*),
    'features', to_jsonb(p.features), 'expires_at', p.expires_at, 'revoked_at', p.revoked_at,
    'daily_cents', p.daily_cents, 'per_minute', p.per_minute,
    'budget_cents', round(p.budget_microcents::numeric / 1000000, 2),
    'spent_cents', round(public._ai_pass_spent(p.id)::numeric / 1000000, 2),
    'left_cents', round(greatest(p.budget_microcents - public._ai_pass_spent(p.id), 0)::numeric / 1000000, 2)),
    'now', now());
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- auth_session answered from a role it read before it looked at the pass. Read both, then answer.
create or replace function public.auth_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_spent bigint;
begin
  p := public._auth_pass(p_token);
  v_role := public._auth_role(p_token);
  if v_role is null then return jsonb_build_object('ok', false); end if;
  if p.id is null then return jsonb_build_object('ok', true, 'role', v_role); end if;
  v_spent := public._ai_pass_spent(p.id);
  return jsonb_build_object('ok', true, 'role', v_role, 'pass', jsonb_build_object(
    'label', p.label, 'features', to_jsonb(p.features), 'expires_at', p.expires_at,
    'left_cents', round(greatest(p.budget_microcents - v_spent, 0)::numeric / 1000000, 2),
    'budget_cents', round(p.budget_microcents::numeric / 1000000, 2)));
end $$;

-- The panel must not work the caps' day out from a device clock: admin_ai_settings now says what
-- the bonus is worth today and when today began, both from the server.
create or replace function public.admin_ai_settings(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; s public.study_ai_settings%rowtype;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select * into s from public.study_ai_settings where id = 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'settings', to_jsonb(s)
    || jsonb_build_object(
         'bonus_today_cents', case when s.bonus_at is not null and s.bonus_at >= public._ai_day_start()
                                   then s.bonus_cents else 0 end,
         'day_start', public._ai_day_start(),
         'now', now()));
end $$;

revoke all on function public._ai_pass_fp(text) from public, anon, authenticated;
revoke all on function public._auth_pass_any(text) from public, anon, authenticated;
revoke all on function public.admin_ai_settings(text) from public;
grant execute on function public.admin_ai_settings(text) to anon;
revoke all on function public.auth_session(text) from public;
grant execute on function public.auth_session(text) to anon;
revoke all on function public.ai_begin2(text, text, text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.ai_begin2(text, text, text, text, text, int, int) to service_role;
revoke all on function public.ai_status2(text, text, text) from public;
grant execute on function public.ai_status2(text, text, text) to anon;
revoke all on function public.ai_chat_rate(text, bigint, int) from public;
grant execute on function public.ai_chat_rate(text, bigint, int) to anon;
revoke all on function public.auth_login(text) from public;
grant execute on function public.auth_login(text) to anon;
