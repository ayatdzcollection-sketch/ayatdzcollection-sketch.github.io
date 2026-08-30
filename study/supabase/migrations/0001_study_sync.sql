-- Study Hub sync backing store.
--
-- Run this in the Supabase dashboard SQL editor (or `supabase db push` if the CLI is linked).
--
-- Security model
--   * RLS is enabled on both tables with NO policies, so the anon key can never touch
--     them directly through PostgREST. The two RPCs below are SECURITY DEFINER, so they
--     run as the table owner and bypass RLS.
--   * Knowing the pairing code is the only credential. The code itself is never stored;
--     only its SHA-256 hash is.
--   * search_path is pinned on every function. `extensions` is included so pgcrypto's
--     digest() resolves whether the project installed pgcrypto into `extensions`
--     (the Supabase default) or into `public`.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.study_sync (
  id         uuid primary key default gen_random_uuid(),
  code_hash  text not null unique,
  payload    jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.study_sync enable row level security;

-- Per-IP failed-attempt counter. Defense in depth only: a 60-bit code is ~1.15e18
-- possibilities, so guessing is already infeasible. This just makes a scripted sweep
-- pointless and cheap to absorb.
create table if not exists public.study_sync_attempts (
  ip           text primary key,
  window_start timestamptz not null default now(),
  fails        int not null default 0
);
alter table public.study_sync_attempts enable row level security;

revoke all on public.study_sync          from anon, authenticated;
revoke all on public.study_sync_attempts from anon, authenticated;

-- ---------------------------------------------------------------- helpers
-- Not granted to anon; reachable only from the definer functions below.

create or replace function public._study_client_ip()
returns text
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare h jsonb;
begin
  h := nullif(current_setting('request.headers', true), '')::jsonb;
  if h is null then return 'unknown'; end if;
  return coalesce(nullif(trim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''), 'unknown');
exception when others then
  return 'unknown';
end $$;

create or replace function public._study_rate_check(p_ip text)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_fails int; v_start timestamptz;
begin
  select fails, window_start into v_fails, v_start
    from public.study_sync_attempts where ip = p_ip;
  if found and v_start > now() - interval '1 hour' and v_fails >= 30 then
    raise exception 'rate_limited: too many failed attempts, try again later'
      using errcode = 'P0001';
  end if;
end $$;

create or replace function public._study_rate_fail(p_ip text)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.study_sync_attempts as a (ip, window_start, fails)
  values (p_ip, now(), 1)
  on conflict (ip) do update set
    fails        = case when a.window_start > now() - interval '1 hour' then a.fails + 1 else 1 end,
    window_start = case when a.window_start > now() - interval '1 hour' then a.window_start else now() end;
end $$;

-- ---------------------------------------------------------------- RPCs

create or replace function public.sync_pull(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_ip      text := public._study_client_ip();
  v_hash    text;
  v_payload jsonb;
  v_updated timestamptz;
begin
  perform public._study_rate_check(v_ip);
  v_hash := encode(digest(upper(p_code), 'sha256'), 'hex');
  select payload, updated_at
    into v_payload, v_updated
    from public.study_sync
   where code_hash = v_hash;
  if not found then
    perform public._study_rate_fail(v_ip);
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object('found', true, 'payload', v_payload, 'updated_at', v_updated);
end $$;

-- Optimistic concurrency, not last-write-wins: the update only lands if the row still
-- carries the updated_at the client last saw. On mismatch the current server row comes
-- back so the client can re-merge and retry.
create or replace function public.sync_push(p_code text, p_payload jsonb, p_seen_updated_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_ip      text := public._study_client_ip();
  v_hash    text;
  v_id      uuid;
  v_payload jsonb;
  v_seen    timestamptz;
  v_new     timestamptz;
begin
  perform public._study_rate_check(v_ip);

  if p_payload is null or pg_column_size(p_payload) > 262144 then
    raise exception 'payload_rejected: null or larger than 256KB';
  end if;

  v_hash := encode(digest(upper(p_code), 'sha256'), 'hex');

  select id, payload, updated_at
    into v_id, v_payload, v_seen
    from public.study_sync
   where code_hash = v_hash
     for update;

  if not found then
    perform public._study_rate_fail(v_ip);   -- row creation counts against the hourly budget
    insert into public.study_sync (code_hash, payload)
    values (v_hash, p_payload)
    returning updated_at into v_new;
    return jsonb_build_object('ok', true, 'updated_at', v_new);
  end if;

  if p_seen_updated_at is null or v_seen <> p_seen_updated_at then
    return jsonb_build_object('ok', false, 'payload', v_payload, 'updated_at', v_seen);
  end if;

  update public.study_sync
     set payload = p_payload, updated_at = now()
   where id = v_id
   returning updated_at into v_new;

  return jsonb_build_object('ok', true, 'updated_at', v_new);
end $$;

-- ---------------------------------------------------------------- grants
-- anon may execute exactly the two RPCs and nothing else.

revoke all on function public.sync_pull(text)                     from public;
revoke all on function public.sync_push(text, jsonb, timestamptz) from public;
revoke all on function public._study_client_ip()                  from public;
revoke all on function public._study_rate_check(text)             from public;
revoke all on function public._study_rate_fail(text)              from public;

grant execute on function public.sync_pull(text)                     to anon;
grant execute on function public.sync_push(text, jsonb, timestamptz) to anon;
