-- 0017_ai_passes.sql
--
-- Access passes: a code the owner hands to one person that both saves their progress and lets
-- them use the AI features, with its own money, its own switch and its own expiry. Asked for on
-- 2026-09-17, alongside "make sure it works and think through the time zone".
--
-- Shape
--   * study_ai_passes: one row per code. The code itself is stored only as a bcrypt hash, the way
--     the admin and viewer codes are (0002). Its last four characters are kept in the clear so the
--     panel can tell two passes apart; four characters of a 60 bit code are not a way in.
--   * A pass code is minted in the pairing code alphabet (Crockford base32, 12 symbols), so the
--     same string the person types to unlock the AI is also a valid sync code: one code, their
--     progress and their AI.
--   * Signing in with a pass makes an ordinary viewer session (0002) with pass_id set. It carries
--     no owner rights: the owner panel, the ledger and every admin RPC stay closed to it.
--   * Money: budget_microcents is what the owner has loaded, all time. What is spent is not a
--     second number to keep in step, it is the sum of that pass's own rows in study_ai_calls, so
--     the ledger cannot disagree with the balance. A call that is still open holds its reserve, so
--     two devices on one pass cannot both spend the last cent.
--   * The owner's global and per feature daily caps still apply on top: the passes spend the
--     owner's API key, and the ceiling that cannot be talked around stays the ceiling.
--
-- Time, and the thing that is easy to get wrong
--   * expires_at is timestamptz: an absolute instant, stored in UTC, compared with now(). No
--     local date arithmetic happens at read time, so a device with a wrong clock (this Mac was
--     twelve hours out on 2026-09-17) cannot make a pass live again or kill it early.
--   * "Expires in the morning" is computed here, once, in the owner's zone
--     (_ai_pass_morning, America/New_York), because "morning" is a wall clock idea and the server
--     runs in UTC. Daylight saving is handled by the zone name, never by adding four or five hours.
--   * The daily caps in 0010 and 0011 are a different clock (a UTC day, which starts at 20:00 in
--     New York during daylight time). A pass expiry has nothing to do with that boundary, and the
--     panel says so in words.
--   * Every check is done at call time against now(): a pass that expires mid session stops
--     working on the next question, not at the next login.
--
-- Safe to run twice.

create table if not exists public.study_ai_passes (
  id                bigserial primary key,
  label             text not null,
  code_hash         text not null,
  code_tail         text not null,
  enabled           boolean not null default true,
  features          text[] not null default array['ask'],
  budget_microcents bigint not null default 0 check (budget_microcents >= 0),
  daily_cents       int,
  per_minute        int not null default 6 check (per_minute between 1 and 60),
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  note              text
);
alter table public.study_ai_passes enable row level security;
revoke all on table public.study_ai_passes from anon, authenticated;
revoke all on sequence public.study_ai_passes_id_seq from anon, authenticated;

alter table public.study_sessions  add column if not exists pass_id bigint;
alter table public.study_ai_calls  add column if not exists pass_id bigint;
create index if not exists study_ai_calls_pass on public.study_ai_calls (pass_id, created_at desc);
create index if not exists study_sessions_pass on public.study_sessions (pass_id);

-- study_sessions.role is checked against ('admin','viewer'); a pass session is a viewer session.

-- ---------------------------------------------------------------- helpers

-- A pass is live when it is switched on, not revoked, and not past its instant.
create or replace function public._ai_pass_live(p public.study_ai_passes)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(p.enabled, false)
     and p.revoked_at is null
     and (p.expires_at is null or p.expires_at > now());
$$;

-- What a pass has spent: its own ledger rows, open ones included at their reserve.
create or replace function public._ai_pass_spent(p_id bigint)
returns bigint
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce(sum(c.cost_microcents), 0)::bigint
    from public.study_ai_calls c
   where c.pass_id = p_id;
$$;

-- The next 07:00 in the owner's own zone, as an instant. Called when a pass is created or
-- changed, never when it is read, so daylight saving is applied once and correctly.
create or replace function public._ai_pass_morning()
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select ((date_trunc('day', (now() at time zone 'America/New_York'))
           + interval '1 day' + interval '7 hours') at time zone 'America/New_York');
$$;

-- The pass behind a token, or null. A session whose pass has died is revoked here, so the
-- device falls back to being an ordinary visitor at its next call rather than at its next login.
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
  if not found or not public._ai_pass_live(p) then
    update public.study_sessions set revoked = true where token_hash = v_hash;
    return null;
  end if;

  update public.study_ai_passes set last_used_at = now() where id = p.id;
  return p;
end $$;

-- ---------------------------------------------------------------- login with a pass
-- The 0002 login, extended: after the two house codes, every live pass is tried. A pass login is
-- a viewer session that remembers which pass it came from.
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
              where enabled and revoked_at is null and (expires_at is null or expires_at > now())
              order by id loop
      if r.code_hash = crypt(p_code, r.code_hash) then
        v_role := 'viewer';
        v_pass_id := r.id;
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

-- What a session is, now including the pass it came from, so the page can show what is left.
create or replace function public.auth_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_spent bigint;
begin
  v_role := public._auth_role(p_token);
  if v_role is null then return jsonb_build_object('ok', false); end if;
  p := public._auth_pass(p_token);
  if p.id is null then return jsonb_build_object('ok', true, 'role', v_role); end if;
  v_spent := public._ai_pass_spent(p.id);
  return jsonb_build_object('ok', true, 'role', v_role, 'pass', jsonb_build_object(
    'label', p.label, 'features', to_jsonb(p.features), 'expires_at', p.expires_at,
    'left_cents', round(greatest(p.budget_microcents - v_spent, 0)::numeric / 1000000, 2),
    'budget_cents', round(p.budget_microcents::numeric / 1000000, 2)));
end $$;

-- ---------------------------------------------------------------- may this session ask
-- The page asks this before it draws anything. It answers for the caller in hand: the owner, a
-- pass, or nobody. 'may' is the only thing the page acts on, and the server checks it again.
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
  v_tagged boolean := false; v_role text; v_may boolean := false; v_why text := 'owner_only';
  v_left bigint; v_out jsonb;
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
  if p.id is not null then
    if not (f.id = any (p.features)) then
      v_why := 'pass_feature';
    else
      v_left := p.budget_microcents - public._ai_pass_spent(p.id);
      if v_left <= 0 then v_why := 'pass_spent';
      else
        v_may := true; v_why := 'pass';
      end if;
    end if;
    return v_out || jsonb_build_object('may', v_may, 'why', v_why,
      'pass', jsonb_build_object('label', p.label, 'expires_at', p.expires_at,
        'left_cents', round(greatest(coalesce(v_left, p.budget_microcents - public._ai_pass_spent(p.id)), 0)::numeric / 1000000, 2)));
  end if;

  if f.mode = 'open' then
    return v_out || jsonb_build_object('may', true, 'why', 'open');
  end if;
  return v_out || jsonb_build_object('may', false, 'why', 'owner_only');
exception when others then
  return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'tagged', false,
                            'available', false, 'beta', true, 'may', false, 'why', 'rejected');
end $$;

-- ---------------------------------------------------------------- ai_begin2, with passes
-- The 0016 body, plus: a session holding a live pass may use the features that pass names, out of
-- that pass's own money, inside its own limits, and the owner's ceilings still apply above it.
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
  if coalesce(v_role, '') <> 'admin' then
    pass := public._auth_pass(p_token);
    if pass.id is not null then
      if not (f.id = any (pass.features)) then
        return jsonb_build_object('ok', false, 'error', 'pass_feature');
      end if;
      v_pass_id := pass.id;
    elsif f.mode = 'owner' then
      return jsonb_build_object('ok', false, 'error', 'owner_only');
    end if;
  end if;

  select * into m from public.study_ai_models where id = f.model;
  if not found or not m.enabled then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  v_reserve := public._ai_cost(m.id, least(greatest(coalesce(p_in, 0), 500), 60000), least(greatest(coalesce(p_out, 0), 200), 4000));
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
    /* The pass is re-read inside the lock, so a revoke or an expiry that landed a moment ago
       counts, and its money is checked with every open call of its own still holding a reserve. */
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
  elsif coalesce(v_role, '') <> 'admin' and f.mode = 'open' then
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

  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort, 'beyond', f.beyond);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- the owner's controls

-- Every pass, with what it has spent and what is left. now is returned too, because the panel
-- must not work out "expires in three hours" from a device clock that may be wrong.
create or replace function public.admin_passes(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'label', p.label, 'tail', p.code_tail, 'enabled', p.enabled,
           'features', to_jsonb(p.features), 'expires_at', p.expires_at, 'created_at', p.created_at,
           'last_used_at', p.last_used_at, 'revoked_at', p.revoked_at, 'note', p.note,
           'daily_cents', p.daily_cents, 'per_minute', p.per_minute,
           'live', public._ai_pass_live(p.*),
           'budget_cents', round(p.budget_microcents::numeric / 1000000, 2),
           'spent_cents',  round(public._ai_pass_spent(p.id)::numeric / 1000000, 2),
           'left_cents',   round(greatest(p.budget_microcents - public._ai_pass_spent(p.id), 0)::numeric / 1000000, 2),
           'calls', (select count(*) from public.study_ai_calls c where c.pass_id = p.id),
           'sessions', (select count(*) from public.study_sessions x where x.pass_id = p.id and not x.revoked and x.expires_at > now())
         ) order by p.id desc), '[]'::jsonb)
    into v_out
    from public.study_ai_passes p;

  return jsonb_build_object('ok', true, 'passes', v_out, 'now', now(), 'zone', 'America/New_York');
end $$;

-- Where one pass's money went: by material, by day, and its last calls.
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
    select (c.created_at at time zone 'America/New_York')::date as day, count(*) as calls,
           round(sum(c.cost_microcents)::numeric / 1000000, 4) as cents
      from public.study_ai_calls c where c.pass_id = p_id group by 1) t;

  select coalesce(jsonb_agg(t order by t.id desc), '[]'::jsonb) into v_recent from (
    select c.id, c.created_at, c.material, c.feature, c.status,
           round(c.cost_microcents::numeric / 1000000, 4) as cents
      from public.study_ai_calls c where c.pass_id = p_id order by c.id desc limit 20) t;

  return jsonb_build_object('ok', true, 'by_material', v_mat, 'by_day', v_day, 'recent', v_recent, 'zone', 'America/New_York');
end $$;

-- Mints a pass and returns the code once. The code is made here, from the database's own random
-- source, in the pairing alphabet, so it is also a sync code. It is never stored in the clear.
create or replace function public.admin_pass_create(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role text; v_code text := ''; v_alpha text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_label text; v_feats text[]; v_budget bigint; v_expires timestamptz; v_daily int; v_id bigint; i int;
  v_when text;
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
     where x in (select id from public.study_ai_features) or x = 'saq';
  end if;
  if v_feats is null or array_length(v_feats, 1) is null then v_feats := array['ask']; end if;

  v_budget := greatest(0, least(coalesce((p_pass ->> 'budget_cents')::numeric, 0), 10000))::bigint * 1000000;

  /* when: 'morning' (the next 07:00 in the owner's zone), 'none', or an instant the panel sends
     as ISO 8601 with its offset. Nothing here reads a local date from the caller. */
  v_when := lower(trim(coalesce(p_pass ->> 'when', 'none')));
  if v_when = 'morning' then v_expires := public._ai_pass_morning();
  elsif v_when = 'none' or v_when = '' then v_expires := null;
  else
    begin
      v_expires := (p_pass ->> 'expires_at')::timestamptz;
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'expires_at');
    end;
    if v_expires is not null and v_expires <= now() then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'expires_at');
    end if;
  end if;

  if p_pass ? 'daily_cents' and jsonb_typeof(p_pass -> 'daily_cents') = 'number' then
    v_daily := greatest(0, least((p_pass ->> 'daily_cents')::int, 10000));
  end if;

  for i in 1..12 loop
    v_code := v_code || substr(v_alpha, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
  end loop;

  insert into public.study_ai_passes (label, code_hash, code_tail, features, budget_microcents, daily_cents, expires_at, note)
  values (v_label, crypt(v_code, gen_salt('bf', 12)), right(v_code, 4), v_feats, v_budget, v_daily, v_expires,
          left(trim(coalesce(p_pass ->> 'note', '')), 200))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'expires_at', v_expires,
                            'features', to_jsonb(v_feats),
                            'budget_cents', round(v_budget::numeric / 1000000, 2), 'zone', 'America/New_York');
end $$;

-- Changes one pass: its switch, its label, more money, a new expiry, its features and limits.
-- add_cents adds to the money already loaded; budget_cents sets it outright.
create or replace function public.admin_pass_set(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_when text; v_feats text[]; v_exp timestamptz;
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

  if p_pass ? 'add_cents' then
    p.budget_microcents := greatest(0, p.budget_microcents +
      (greatest(-10000, least(coalesce((p_pass ->> 'add_cents')::numeric, 0), 10000)) * 1000000)::bigint);
  end if;
  if p_pass ? 'budget_cents' then
    p.budget_microcents := (greatest(0, least(coalesce((p_pass ->> 'budget_cents')::numeric, 0), 10000)) * 1000000)::bigint;
  end if;

  if p_pass ? 'daily_cents' then
    if jsonb_typeof(p_pass -> 'daily_cents') = 'null' then p.daily_cents := null;
    else p.daily_cents := greatest(0, least((p_pass ->> 'daily_cents')::int, 10000)); end if;
  end if;

  if p_pass ? 'per_minute' then
    p.per_minute := greatest(1, least(coalesce((p_pass ->> 'per_minute')::int, 6), 60));
  end if;

  if jsonb_typeof(p_pass -> 'features') = 'array' then
    select array_agg(x) into v_feats from jsonb_array_elements_text(p_pass -> 'features') x
     where x in (select id from public.study_ai_features) or x = 'saq';
    if v_feats is null or array_length(v_feats, 1) is null then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'features');
    end if;
    p.features := v_feats;
  end if;

  if p_pass ? 'when' then
    v_when := lower(trim(coalesce(p_pass ->> 'when', '')));
    if v_when = 'morning' then p.expires_at := public._ai_pass_morning();
    elsif v_when = 'none' then p.expires_at := null;
    elsif v_when = 'now' then p.expires_at := now();
    else
      begin
        v_exp := (p_pass ->> 'expires_at')::timestamptz;
      exception when others then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'expires_at');
      end;
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

  /* A pass that is no longer live takes its sessions with it: the device becomes an ordinary
     visitor at once, rather than keeping a session that only fails later. */
  if not public._ai_pass_live(p) then
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
end $$;

-- Deletes a pass outright. Its ledger rows stay, with pass_id cleared, so the spend history and
-- the month's totals are unchanged. Their own saved progress is not here and is untouched.
create or replace function public.admin_pass_delete(p_token text, p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_n int;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  update public.study_sessions set revoked = true where pass_id = p_id and not revoked;
  update public.study_ai_calls set pass_id = null where pass_id = p_id;
  delete from public.study_ai_passes where id = p_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public._ai_pass_live(public.study_ai_passes)   from public, anon, authenticated;
revoke all on function public._ai_pass_spent(bigint)                  from public, anon, authenticated;
revoke all on function public._ai_pass_morning()                      from public, anon, authenticated;
revoke all on function public._auth_pass(text)                        from public, anon, authenticated;
revoke all on function public.ai_status2(text, text, text)            from public;
revoke all on function public.admin_passes(text)                      from public;
revoke all on function public.admin_pass_spend(text, bigint)          from public;
revoke all on function public.admin_pass_create(text, jsonb)          from public;
revoke all on function public.admin_pass_set(text, jsonb)             from public;
revoke all on function public.admin_pass_delete(text, bigint)         from public;

grant execute on function public.ai_status2(text, text, text)         to anon;
grant execute on function public.admin_passes(text)                   to anon;
grant execute on function public.admin_pass_spend(text, bigint)       to anon;
grant execute on function public.admin_pass_create(text, jsonb)       to anon;
grant execute on function public.admin_pass_set(text, jsonb)          to anon;
grant execute on function public.admin_pass_delete(text, bigint)      to anon;
