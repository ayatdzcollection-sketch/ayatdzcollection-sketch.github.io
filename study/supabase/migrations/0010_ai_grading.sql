-- AI grading of the APUSH short answer, with the owner holding the purse strings.
--
-- Run this in the Supabase dashboard SQL editor, after 0001 through 0009.
--
-- Why this exists
--   A short answer cannot be marked by comparing strings. The material already shows the
--   model answer and the rubric line and asks the student to mark themselves, which works
--   only if the student is honest and already knows what a point looks like. An Edge
--   Function can send the three answers to Claude and get a per part judgement back. That
--   costs real money per press, so the money has to be governed here, in the one place a
--   browser cannot edit: the feature is off until the owner turns it on, every call is
--   counted before it is made, and the ceilings are checked inside one transaction.
--
-- What is stored, and what is not
--   * Stored: one ledger row per grade attempt with the material id, the install id, the
--     caller's address, the model, the status, token counts, the cost and the latency.
--   * NEVER stored: the student's typed answer, the prompt, the model's reply, or any
--     other text the student wrote. There is no column for it in study_ai_calls and no
--     function here takes one. The Edge Function holds that text for the length of one
--     request and then drops it.
--   * The Anthropic API key is not here either. It lives only as an Edge Function secret.
--
-- The unit: microcents
--   Costs are integers so that comparing them to a ceiling is exact.
--     1 cent       = 1,000,000 microcents
--     1 US dollar  = 100 cents = 100,000,000 microcents
--   Model prices are quoted the way Anthropic quotes them, in dollars per million tokens.
--   Converting is then one multiplication:
--     microcents = tokens * dollars_per_million_tokens * 100
--   (tokens / 1e6 million-tokens, times dollars, times 1e8 microcents per dollar.)
--   Worked example: 2000 input tokens on a model priced at $2 per million tokens is
--   2000 * 2 * 100 = 400,000 microcents, that is 0.4 cents, that is $0.004. Correct.
--   The owner's caps are set in whole cents; the comparison multiplies them by 1,000,000.
--
-- The reserve
--   A grade's real cost is known only after the API answers, but the ceiling has to hold
--   while the call is in flight. So ai_begin writes a pending row that already carries an
--   estimate of what the call will cost (2000 input and 400 output tokens at that model's
--   prices), and the ceiling sums ok and pending rows together. Ten calls fired at once
--   therefore see each other's reserves. ai_end then replaces the reserve with the real
--   cost from the real token counts. A pending row that never ends (a crashed function)
--   keeps counting against the cap, which is the safe direction to fail.
--   ai_begin takes a transaction advisory lock before it counts, so two calls racing each
--   other cannot both read the spend before either has written its reserve.
--
-- The off state guarantee
--   study_ai_settings starts with enabled false and mode owner, and study_items carries
--   no 'ai' tag until the owner sets one. In that state ai_status tells the material the
--   feature is unavailable, the material draws exactly what it drew before this migration
--   existed, and ai_begin refuses every call with 'off' before looking at anything else.
--   Nothing here can spend a cent until the owner deliberately turns it on.
--
-- Security model
--   * RLS is on for the three tables with no policies anywhere, the house pattern. Neither
--     anon nor authenticated may touch them directly; every path is a definer function.
--   * ai_begin and ai_end are the spending functions and are granted to service_role only,
--     so they are reachable from the Edge Function's service key and from nothing a
--     browser holds. The anon key cannot call them at all.
--   * The anon surface is ai_status (three settings fields and one boolean) and the admin
--     RPCs, each guarded with coalesce(v_role, '') <> 'admin', the lesson of 0006: a bare
--     v_role <> 'admin' is null for an unknown token, plpgsql reads null as false, and the
--     refusal is skipped. Never write the bare form.
--   * Every refusal is a {ok:false, error:code} payload, never an exception, so a caller
--     cannot tell a cap from a bug by watching for a 500.
--   * Ranges are validated here, not in the panel, and the first violation comes back as
--     {ok:false, error:'range', field:'...'}.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

-- One row, id 1. Everything the owner controls lives in it.
create table if not exists public.study_ai_settings (
  id                int primary key default 1 check (id = 1),
  enabled           boolean not null default false,
  mode              text not null default 'owner' check (mode in ('open', 'owner')),
  model             text not null default 'claude-sonnet-5',
  effort            text not null default 'low' check (effort in ('low', 'medium', 'high')),
  daily_cents       int not null default 50  check (daily_cents       between 0 and 10000),
  monthly_cents     int not null default 500 check (monthly_cents     between 0 and 10000),
  per_install_daily int not null default 20  check (per_install_daily between 0 and 500),
  per_ip_minute     int not null default 4   check (per_ip_minute     between 1 and 60),
  max_chars         int not null default 2000 check (max_chars        between 200 and 6000),
  updated_at        timestamptz not null default now()
);
alter table public.study_ai_settings enable row level security;

insert into public.study_ai_settings (id) values (1) on conflict (id) do nothing;

-- The candidates the eval measures. Prices are dollars per million tokens, as quoted.
-- The eval_* columns stay null until study/src/tools/ai_eval/run_eval.mjs has run and the
-- owner has saved its numbers through admin_ai_models_set; the panel shows them as the
-- reason for picking one model over another.
create table if not exists public.study_ai_models (
  id                   text primary key,
  name                 text not null,
  in_per_mtok          numeric not null default 0 check (in_per_mtok  >= 0),
  out_per_mtok         numeric not null default 0 check (out_per_mtok >= 0),
  eval_agreement       numeric,                       -- share of parts matching the key, 0 to 1
  eval_false_points    numeric,                       -- share of parts given a point the key withholds
  eval_latency_ms      int,
  eval_cost_microcents bigint,                        -- measured cost of one three part grade
  effort               text check (effort is null or effort in ('low', 'medium', 'high')),
  enabled              boolean not null default true,
  note                 text,
  updated_at           timestamptz not null default now()
);
alter table public.study_ai_models enable row level security;

insert into public.study_ai_models (id, name, in_per_mtok, out_per_mtok, note) values
  ('claude-sonnet-5',   'Claude Sonnet 5',    2,  10, null),
  ('claude-sonnet-4-6', 'Claude Sonnet 4.6',  3,  15, null),
  ('claude-opus-5',     'Claude Opus 5',      5,  25, null),
  ('claude-opus-4-8',   'Claude Opus 4.8',    5,  25, null),
  ('claude-haiku-4-5',  'Claude Haiku 4.5',   1,   5, 'No adaptive thinking; the effort field is ignored for this model.')
on conflict (id) do nothing;

-- The ledger. One row per grade attempt. No student text, ever: there is nowhere to put it.
create table if not exists public.study_ai_calls (
  id             bigserial primary key,
  material       text,
  install        text,
  ip             text,
  model          text,
  status         text not null default 'pending'
                 check (status in ('pending', 'ok', 'error', 'refused')),
  input_tokens   int,
  output_tokens  int,
  cost_microcents bigint not null default 0,   -- the reserve while pending, the real cost after
  latency_ms     int,
  created_at     timestamptz not null default now()
);
alter table public.study_ai_calls enable row level security;
create index if not exists study_ai_calls_created  on public.study_ai_calls (created_at);
create index if not exists study_ai_calls_install  on public.study_ai_calls (install, created_at);
create index if not exists study_ai_calls_ip       on public.study_ai_calls (ip, created_at);

revoke all on public.study_ai_settings from anon, authenticated;
revoke all on public.study_ai_models   from anon, authenticated;
revoke all on public.study_ai_calls    from anon, authenticated;

-- ---------------------------------------------------------------- helpers
-- Not granted to anyone; reachable only from the definer functions below.

-- Cost of p_in input and p_out output tokens on p_model, in microcents. Null when the
-- model is not in the table, which every caller treats as a refusal rather than as free.
create or replace function public._ai_cost(p_model text, p_in int, p_out int)
returns bigint
language sql
stable
set search_path = pg_catalog, public
as $$
  select round((greatest(coalesce(p_in, 0), 0)::numeric  * m.in_per_mtok
              + greatest(coalesce(p_out, 0), 0)::numeric * m.out_per_mtok) * 100)::bigint
    from public.study_ai_models m
   where m.id = p_model;
$$;

-- Start of the current UTC day and month, as timestamptz, for the two ceilings.
create or replace function public._ai_day_start()
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select date_trunc('day', (now() at time zone 'utc')) at time zone 'utc';
$$;

create or replace function public._ai_month_start()
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select date_trunc('month', (now() at time zone 'utc')) at time zone 'utc';
$$;

-- Reads one integer out of a settings or model patch. Returns:
--   found false           the key is absent or json null, leave the column alone
--   found true, ok false  the key is present but is not an integer, a range violation
-- Nothing is cast until it has matched the pattern, so a junk value cannot raise.
create or replace function public._ai_int(p_obj jsonb, p_key text, out v_found boolean, out v_ok boolean, out v_val int)
returns record
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare v_txt text;
begin
  v_found := false; v_ok := false; v_val := null;
  if p_obj is null or not (p_obj ? p_key) or jsonb_typeof(p_obj -> p_key) = 'null' then
    return;
  end if;
  v_found := true;
  v_txt := trim(p_obj ->> p_key);
  if v_txt !~ '^-?[0-9]{1,9}$' then return; end if;
  v_ok := true;
  v_val := v_txt::int;
end $$;

-- The same, for a price or an eval score, which may carry decimals.
create or replace function public._ai_num(p_obj jsonb, p_key text, out v_found boolean, out v_ok boolean, out v_val numeric)
returns record
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare v_txt text;
begin
  v_found := false; v_ok := false; v_val := null;
  if p_obj is null or not (p_obj ? p_key) or jsonb_typeof(p_obj -> p_key) = 'null' then
    return;
  end if;
  v_found := true;
  v_txt := trim(p_obj ->> p_key);
  if v_txt !~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$' then return; end if;
  v_ok := true;
  v_val := v_txt::numeric;
end $$;

-- ---------------------------------------------------------------- the student path
-- ai_begin and ai_end are granted to service_role and to nothing else. They are called by
-- the saq-grade Edge Function with the service key, which no browser ever sees. The anon
-- key gets a permission error, not a refusal payload.

-- Order of the checks matters, and it is the order of the refusal codes:
--   off          the owner has not turned the feature on
--   unavailable  no such material, or the material does not carry the 'ai' tag
--   owner_only   mode is owner and the caller did not present an admin session token
--   no_model     the configured model is missing from study_ai_models or is disabled
--   monthly_cap  this call's reserve would push the month past the ceiling
--   daily_cap    the same for today
--   device_cap   this install has had its grades for today
--   slow_down    this address has called too often in the last minute
-- In owner mode the install and address counters are skipped entirely: the only caller is
-- the owner, holding a token that was checked one step earlier.
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

  if s.mode = 'owner' and coalesce(public._auth_role(p_token), '') <> 'admin' then
    return jsonb_build_object('ok', false, 'error', 'owner_only');
  end if;

  select * into m from public.study_ai_models where id = s.model;
  if not found or not m.enabled then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  /* A typical grade sends the prompt, the three rubric lines, the three model answers and
     the student's three answers, and gets back three short judgements. 2000 in and 400 out
     is the generous end of that, so the reserve over estimates rather than under. */
  v_reserve := public._ai_cost(m.id, 2000, 400);
  if v_reserve is null then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  /* One transaction advisory lock, held to commit, so that two calls arriving together
     cannot both read the spend before either has written its reserve. A lock table ...
     in share row exclusive mode would do the same job but would also block ai_end, which
     has no reason to wait; this key blocks ai_begin against ai_begin and nothing else. */
  perform pg_advisory_xact_lock(4801001);

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c
   where c.created_at >= public._ai_month_start();   /* every row: refused and errored calls bill tokens too */
  if v_spent + v_reserve > s.monthly_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'monthly_cap');
  end if;

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c
   where c.created_at >= public._ai_day_start();
  if v_spent + v_reserve > s.daily_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'daily_cap');
  end if;

  if s.mode = 'open' then
    if length(v_install) < 8 then
      return jsonb_build_object('ok', false, 'error', 'bad_install');
    end if;

    /* A call that errored does not burn the student's allowance for the day. */
    select count(*) into v_count
      from public.study_ai_calls c
     where c.install = v_install
       and c.status in ('ok', 'pending')
       and c.created_at >= public._ai_day_start();
    if v_count >= s.per_install_daily then
      return jsonb_build_object('ok', false, 'error', 'device_cap');
    end if;

    /* The per address counter is abuse protection, so every status counts here. */
    select count(*) into v_count
      from public.study_ai_calls c
     where c.ip = v_ip
       and c.created_at > now() - interval '1 minute';
    if v_count >= s.per_ip_minute then
      return jsonb_build_object('ok', false, 'error', 'slow_down');
    end if;
  end if;

  insert into public.study_ai_calls (material, install, ip, model, status, cost_microcents)
  values (v_material, nullif(v_install, ''), v_ip, m.id, 'pending', v_reserve)
  returning id into v_id;

  return jsonb_build_object(
    'ok', true,
    'call_id', v_id,
    'model', m.id,
    'effort', s.effort,
    'max_chars', s.max_chars
  );
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- Closes the ledger row the call opened, replacing the reserve with the real cost. Called
-- in a finally block, so it must tolerate being handed an error status with no tokens at
-- all: that row then costs nothing, which is what the API billed. A row can only be closed
-- once, so a retry cannot rewrite history.
create or replace function public.ai_end(p_call_id bigint, p_status text, p_in int, p_out int, p_latency int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_model  text;
  v_status text;
  v_cost   bigint;
begin
  if p_status is null or p_status not in ('ok', 'error', 'refused') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;

  select c.model, c.status into v_model, v_status
    from public.study_ai_calls c
   where c.id = p_call_id
     for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'already_ended');
  end if;

  v_cost := coalesce(public._ai_cost(v_model, p_in, p_out), 0);

  update public.study_ai_calls
     set status          = p_status,
         input_tokens    = greatest(coalesce(p_in, 0), 0),
         output_tokens   = greatest(coalesce(p_out, 0), 0),
         cost_microcents = v_cost,
         latency_ms      = greatest(coalesce(p_latency, 0), 0)
   where id = p_call_id;

  return jsonb_build_object('ok', true, 'cost_microcents', v_cost,
                            'cost_cents', round(v_cost::numeric / 1000000, 4));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- What the material asks before it decides whether to draw the button. Anon callable, and
-- deliberately thin: whether the feature is on, which mode it is in, which model is
-- configured, and whether this material carries the 'ai' tag. No caps, no spend, no
-- ledger, nothing about anyone else. `available` is the one line the client needs.
create or replace function public.ai_status(p_material text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s        public.study_ai_settings%rowtype;
  v_tagged boolean;
begin
  select * into s from public.study_ai_settings where id = 1;
  if not found then
    return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner',
                              'model', null, 'tagged', false, 'available', false);
  end if;

  select exists (
    select 1 from public.study_items i
     where i.id = left(trim(coalesce(p_material, '')), 120)
       and 'ai' = any (i.tags)
  ) into v_tagged;

  return jsonb_build_object(
    'ok', true,
    'enabled', s.enabled,
    'mode', s.mode,
    'model', s.model,
    'tagged', v_tagged,
    'available', s.enabled and v_tagged
  );
exception when others then
  return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner',
                            'model', null, 'tagged', false, 'available', false);
end $$;

-- ---------------------------------------------------------------- owner panel
-- Anon callable and token guarded, like every other admin RPC in this database. Each one
-- opens with the coalesce form from 0006; _auth_role also slides the session's expiry
-- forward, so using the panel keeps the owner's device signed in.

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

  return jsonb_build_object('ok', true, 'settings', to_jsonb(s));
end $$;

-- Applies only the keys the patch carries, so the panel can save one field. The ranges are
-- the plan's: cents 0 to 10000, per install 0 to 500, per address 1 to 60, chars 200 to
-- 6000. The first violation stops the whole update and names its field, so nothing is half
-- applied and the panel can mark the offending input.
create or replace function public.admin_ai_set(p_token text, p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role  text;
  s       public.study_ai_settings%rowtype;
  v_txt   text;
  r       record;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_settings');
  end if;

  select * into s from public.study_ai_settings where id = 1 for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_settings ? 'enabled' then
    if jsonb_typeof(p_settings -> 'enabled') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'enabled');
    end if;
    s.enabled := (p_settings ->> 'enabled')::boolean;
  end if;

  if p_settings ? 'mode' then
    v_txt := trim(coalesce(p_settings ->> 'mode', ''));
    if v_txt not in ('open', 'owner') then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'mode');
    end if;
    s.mode := v_txt;
  end if;

  if p_settings ? 'model' then
    v_txt := trim(coalesce(p_settings ->> 'model', ''));
    if not exists (select 1 from public.study_ai_models m where m.id = v_txt and m.enabled) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'model');
    end if;
    s.model := v_txt;
  end if;

  if p_settings ? 'effort' then
    v_txt := trim(coalesce(p_settings ->> 'effort', ''));
    if v_txt not in ('low', 'medium', 'high') then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'effort');
    end if;
    s.effort := v_txt;
  end if;

  select * into r from public._ai_int(p_settings, 'daily_cents');
  if r.v_found then
    if not r.v_ok or r.v_val < 0 or r.v_val > 10000 then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'daily_cents');
    end if;
    s.daily_cents := r.v_val;
  end if;

  select * into r from public._ai_int(p_settings, 'monthly_cents');
  if r.v_found then
    if not r.v_ok or r.v_val < 0 or r.v_val > 10000 then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'monthly_cents');
    end if;
    s.monthly_cents := r.v_val;
  end if;

  select * into r from public._ai_int(p_settings, 'per_install_daily');
  if r.v_found then
    if not r.v_ok or r.v_val < 0 or r.v_val > 500 then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'per_install_daily');
    end if;
    s.per_install_daily := r.v_val;
  end if;

  select * into r from public._ai_int(p_settings, 'per_ip_minute');
  if r.v_found then
    if not r.v_ok or r.v_val < 1 or r.v_val > 60 then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'per_ip_minute');
    end if;
    s.per_ip_minute := r.v_val;
  end if;

  select * into r from public._ai_int(p_settings, 'max_chars');
  if r.v_found then
    if not r.v_ok or r.v_val < 200 or r.v_val > 6000 then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'max_chars');
    end if;
    s.max_chars := r.v_val;
  end if;

  update public.study_ai_settings
     set enabled           = s.enabled,
         mode              = s.mode,
         model             = s.model,
         effort            = s.effort,
         daily_cents       = s.daily_cents,
         monthly_cents     = s.monthly_cents,
         per_install_daily = s.per_install_daily,
         per_ip_minute     = s.per_ip_minute,
         max_chars         = s.max_chars,
         updated_at        = now()
   where id = 1;

  select * into s from public.study_ai_settings where id = 1;
  return jsonb_build_object('ok', true, 'settings', to_jsonb(s));
end $$;

-- The readout: what has been spent today and this month in cents, how many calls and how
-- they ended, a per model tally for the month, and the last twenty rows. There is no text
-- in any of it because there is no text in the table.
create or replace function public.admin_ai_usage(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role     text;
  v_day      timestamptz := public._ai_day_start();
  v_month    timestamptz := public._ai_month_start();
  v_today    bigint;
  v_month_mc bigint;
  v_today_n  int;
  v_month_n  int;
  v_last     timestamptz;
  v_status   jsonb;
  v_models   jsonb;
  v_recent   jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(sum(cost_microcents), 0), count(*)
    into v_today, v_today_n
    from public.study_ai_calls
   where created_at >= v_day;

  select coalesce(sum(cost_microcents), 0), count(*)
    into v_month_mc, v_month_n
    from public.study_ai_calls
   where created_at >= v_month;

  select max(created_at) into v_last
    from public.study_ai_calls where status = 'ok';

  select coalesce(jsonb_object_agg(t.status, t.n), '{}'::jsonb) into v_status
    from (select status, count(*) as n
            from public.study_ai_calls
           where created_at >= v_month
           group by status) t;

  select coalesce(jsonb_object_agg(t.model, t.n), '{}'::jsonb) into v_models
    from (select coalesce(model, 'unknown') as model, count(*) as n
            from public.study_ai_calls
           where created_at >= v_month
           group by 1) t;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_recent
    from (select id, created_at, material, model, status,
                 input_tokens, output_tokens, cost_microcents, latency_ms
            from public.study_ai_calls
           order by created_at desc
           limit 20) t;

  return jsonb_build_object(
    'ok', true,
    'today_cents', round(v_today::numeric    / 1000000, 4),
    'month_cents', round(v_month_mc::numeric / 1000000, 4),
    'today_calls', v_today_n,
    'month_calls', v_month_n,
    'last_ok_at', v_last,
    'by_status', v_status,
    'by_model', v_models,
    'recent', v_recent
  );
end $$;

create or replace function public.admin_ai_models(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) into v_out
    from public.study_ai_models t;

  return jsonb_build_object('ok', true, 'models', v_out);
end $$;

-- Saves the eval's numbers, and the effort and enabled flag the owner wants per model.
-- p_models is an array of patches, each with an id and whichever fields it changes. Every
-- entry is validated before any of them is written, so a typo in the fourth does not leave
-- the first three applied. Prices may be corrected but never below zero, and the shares
-- (agreement, false points) are fractions of 1.
create or replace function public.admin_ai_models_set(p_token text, p_models jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role text;
  v_el   jsonb;
  v_id   text;
  v_txt  text;
  v_n    int := 0;
  r      record;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_models is null or jsonb_typeof(p_models) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_models');
  end if;
  if jsonb_array_length(p_models) > 50 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  -- Pass one: check everything.
  for v_el in select * from jsonb_array_elements(p_models) loop
    if jsonb_typeof(v_el) <> 'object' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'model');
    end if;
    v_id := trim(coalesce(v_el ->> 'id', ''));
    if not exists (select 1 from public.study_ai_models m where m.id = v_id) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'id');
    end if;

    if v_el ? 'enabled' and jsonb_typeof(v_el -> 'enabled') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'enabled');
    end if;

    if v_el ? 'effort' and jsonb_typeof(v_el -> 'effort') <> 'null' then
      v_txt := trim(coalesce(v_el ->> 'effort', ''));
      if v_txt not in ('low', 'medium', 'high') then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'effort');
      end if;
    end if;

    if v_el ? 'note' and length(coalesce(v_el ->> 'note', '')) > 400 then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'note');
    end if;

    select * into r from public._ai_num(v_el, 'in_per_mtok');
    if r.v_found and (not r.v_ok or r.v_val < 0) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'in_per_mtok');
    end if;

    select * into r from public._ai_num(v_el, 'out_per_mtok');
    if r.v_found and (not r.v_ok or r.v_val < 0) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'out_per_mtok');
    end if;

    select * into r from public._ai_num(v_el, 'eval_agreement');
    if r.v_found and (not r.v_ok or r.v_val < 0 or r.v_val > 1) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'eval_agreement');
    end if;

    select * into r from public._ai_num(v_el, 'eval_false_points');
    if r.v_found and (not r.v_ok or r.v_val < 0 or r.v_val > 1) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'eval_false_points');
    end if;

    select * into r from public._ai_int(v_el, 'eval_latency_ms');
    if r.v_found and (not r.v_ok or r.v_val < 0 or r.v_val > 600000) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'eval_latency_ms');
    end if;

    select * into r from public._ai_int(v_el, 'eval_cost_microcents');
    if r.v_found and (not r.v_ok or r.v_val < 0) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'eval_cost_microcents');
    end if;
  end loop;

  -- Pass two: write. Only the keys each patch carries.
  for v_el in select * from jsonb_array_elements(p_models) loop
    v_id := trim(coalesce(v_el ->> 'id', ''));

    update public.study_ai_models m set
      in_per_mtok          = case when v_el ? 'in_per_mtok' and jsonb_typeof(v_el -> 'in_per_mtok') = 'number'
                                  then greatest(0, (v_el ->> 'in_per_mtok')::numeric) else m.in_per_mtok end,
      out_per_mtok         = case when v_el ? 'out_per_mtok' and jsonb_typeof(v_el -> 'out_per_mtok') = 'number'
                                  then greatest(0, (v_el ->> 'out_per_mtok')::numeric) else m.out_per_mtok end,
      eval_agreement       = case when v_el ? 'eval_agreement'
                                  then nullif(v_el ->> 'eval_agreement', '')::numeric else m.eval_agreement end,
      eval_false_points    = case when v_el ? 'eval_false_points'
                                  then nullif(v_el ->> 'eval_false_points', '')::numeric else m.eval_false_points end,
      eval_latency_ms      = case when v_el ? 'eval_latency_ms'
                                  then nullif(v_el ->> 'eval_latency_ms', '')::int else m.eval_latency_ms end,
      eval_cost_microcents = case when v_el ? 'eval_cost_microcents'
                                  then nullif(v_el ->> 'eval_cost_microcents', '')::bigint else m.eval_cost_microcents end,
      effort               = case when v_el ? 'effort'
                                  then nullif(trim(coalesce(v_el ->> 'effort', '')), '') else m.effort end,
      enabled              = case when v_el ? 'enabled'
                                  then (v_el ->> 'enabled')::boolean else m.enabled end,
      note                 = case when v_el ? 'note'
                                  then nullif(v_el ->> 'note', '') else m.note end,
      updated_at           = now()
    where m.id = v_id;
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'updated', v_n);
end $$;

-- ---------------------------------------------------------------- grants
--
-- The two spending functions go to service_role and nothing else: revoking from public
-- alone would still leave anon and authenticated holding whatever public had, so both are
-- named. ai_status and the five admin RPCs are anon callable, the admin five because the
-- hub's owner panel runs in the same anonymous browser and proves itself with a token, not
-- with a database role. The helpers are granted to nobody.

revoke all on function public.ai_begin(text, text, text, text)        from public, anon, authenticated;
revoke all on function public.ai_end(bigint, text, int, int, int)     from public, anon, authenticated;
revoke all on function public.ai_status(text)                         from public;
revoke all on function public.admin_ai_settings(text)                 from public;
revoke all on function public.admin_ai_set(text, jsonb)               from public;
revoke all on function public.admin_ai_usage(text)                    from public;
revoke all on function public.admin_ai_models(text)                   from public;
revoke all on function public.admin_ai_models_set(text, jsonb)        from public;
revoke all on function public._ai_cost(text, int, int)                from public, anon, authenticated;
revoke all on function public._ai_day_start()                         from public, anon, authenticated;
revoke all on function public._ai_month_start()                       from public, anon, authenticated;
revoke all on function public._ai_int(jsonb, text)                    from public, anon, authenticated;
revoke all on function public._ai_num(jsonb, text)                    from public, anon, authenticated;

grant execute on function public.ai_begin(text, text, text, text)     to service_role;
grant execute on function public.ai_end(bigint, text, int, int, int)  to service_role;

grant execute on function public.ai_status(text)                      to anon;
grant execute on function public.admin_ai_settings(text)              to anon;
grant execute on function public.admin_ai_set(text, jsonb)            to anon;
grant execute on function public.admin_ai_usage(text)                 to anon;
grant execute on function public.admin_ai_models(text)                to anon;
grant execute on function public.admin_ai_models_set(text, jsonb)     to anon;
