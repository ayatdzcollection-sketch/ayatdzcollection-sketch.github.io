-- Study Hub request inbox.
--
-- Run this in the Supabase dashboard SQL editor, after 0001 through 0006.
--
-- Why this exists
--   A request for a material can carry attachments (a syllabus page, a photo of the
--   board, a slide deck), and there is no public bucket on GitHub Pages to hold them.
--   Postgres already holds the one thing that actually matters here, the encryption keys
--   for every material, so it is the one place already trusted with private bytes. A file
--   is only ever read back by a session that proved it holds the admin code
--   (admin_request_file), and once study/tools/requests.mjs pulls a request down, it
--   purges the stored bytes (admin_request_purge), so nothing sits in the database any
--   longer than it has to.
--
-- What is protected, and what is not
--   * Protected: the contents of every attached file, and the request's notes, while it
--     sits in this database.
--   * Not protected: that a request with a given subject exists, once an admin has
--     listed it. This table is never exposed to anon beyond the write-only submission
--     path; only an admin session can read requests back at all.
--
-- Security model
--   * RLS is on with no policies anywhere. anon may execute the listed functions and
--     nothing else. Every function pins search_path and is SECURITY DEFINER.
--   * Submitting is rate limited per IP (five open requests per hour), on top of the
--     per-request and per-file size caps below.
--   * Reading a request, reading a file's bytes, marking status, and purging all require
--     an admin session token, checked with public._auth_role from 0002_auth.sql.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists public.study_requests (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  status      text not null default 'open' check (status in ('open', 'submitted', 'seen', 'done')),
  subject     text,
  purpose     text,
  due         text,
  features    text[] not null default '{}',
  other       text,
  notes       text,
  from_name   text,
  ip          text,
  file_count  int not null default 0,
  bytes       bigint not null default 0
);
alter table public.study_requests enable row level security;
create index if not exists study_requests_status on public.study_requests (status, created_at desc);
create index if not exists study_requests_ip on public.study_requests (ip, created_at);

-- File bytes live here rather than on disk or in a bucket; see the header above.
create table if not exists public.study_request_files (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.study_requests (id) on delete cascade,
  name        text,
  mime        text,
  size        bigint not null default 0,     -- declared size, checked at request_file_open
  chunks      int not null default 0,
  data        bytea not null default ''::bytea,
  purged      boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table public.study_request_files enable row level security;
create index if not exists study_request_files_request on public.study_request_files (request_id);

revoke all on public.study_requests      from anon, authenticated;
revoke all on public.study_request_files from anon, authenticated;

-- ---------------------------------------------------------------- helpers
-- Not granted to anon; reachable only from the definer functions below.

create or replace function public._req_clip(p_text text, p_max int)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select nullif(substring(trim(coalesce(p_text, '')) from 1 for greatest(p_max, 0)), '');
$$;

-- ---------------------------------------------------------------- submit

create or replace function public.request_open(p_meta jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_ip       text := public._auth_ip();
  v_count    int;
  v_subject  text;
  v_notes    text;
  v_features text[];
  v_id       uuid;
  v_el       jsonb;
begin
  /* Uploads abandoned half way (a closed tab, a dropped connection) never reach
     request_finish and would sit in storage forever. Clear any older than a day. */
  delete from public.study_requests where status = 'open' and created_at < now() - interval '1 day';

  select count(*) into v_count
    from public.study_requests
   where ip = v_ip and created_at > now() - interval '1 hour';
  if v_count >= 5 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  v_subject := public._req_clip(p_meta ->> 'subject', 200);
  v_notes   := public._req_clip(p_meta ->> 'notes', 4000);
  if v_subject is null and v_notes is null then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  v_features := '{}';
  if jsonb_typeof(p_meta -> 'features') = 'array' then
    for v_el in select * from jsonb_array_elements(p_meta -> 'features') limit 20 loop
      declare v_f text;
      begin
        v_f := public._req_clip(v_el #>> '{}', 60);
        if v_f is not null then v_features := array_append(v_features, v_f); end if;
      end;
    end loop;
  end if;

  insert into public.study_requests
    (status, subject, purpose, due, features, other, notes, from_name, ip)
  values (
    'open', v_subject,
    public._req_clip(p_meta ->> 'purpose', 500),
    public._req_clip(p_meta ->> 'due', 60),
    v_features,
    public._req_clip(p_meta ->> 'other', 1000),
    v_notes,
    public._req_clip(p_meta ->> 'from_name', 100),
    v_ip
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.request_file_open(p_request uuid, p_name text, p_mime text, p_size bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_status      text;
  v_created     timestamptz;
  v_file_count  int;
  v_req_bytes   bigint;
  v_stored      bigint;
  v_id          uuid;
begin
  select status, created_at into v_status, v_created
    from public.study_requests where id = p_request;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_status <> 'open' then return jsonb_build_object('ok', false, 'error', 'not_open'); end if;
  if v_created < now() - interval '2 hours' then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  if p_size is null or p_size <= 0 or p_size > 20 * 1024 * 1024 then
    return jsonb_build_object('ok', false, 'error', 'file_too_large');
  end if;

  select count(*) into v_file_count
    from public.study_request_files where request_id = p_request;
  if v_file_count >= 6 then
    return jsonb_build_object('ok', false, 'error', 'too_many_files');
  end if;

  select coalesce(sum(size), 0) into v_req_bytes
    from public.study_request_files where request_id = p_request;
  if v_req_bytes + p_size > 30 * 1024 * 1024 then
    return jsonb_build_object('ok', false, 'error', 'request_too_large');
  end if;

  select coalesce(sum(octet_length(data)), 0) into v_stored
    from public.study_request_files where purged = false;
  if v_stored > 400 * 1024 * 1024 then
    return jsonb_build_object('ok', false, 'error', 'storage_full');
  end if;

  insert into public.study_request_files (request_id, name, mime, size, chunks, data)
  values (p_request, public._req_clip(p_name, 200), public._req_clip(p_mime, 100), p_size, 0, ''::bytea)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'file_id', v_id);
end $$;

create or replace function public.request_file_chunk(p_file uuid, p_index int, p_b64 text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_status  text;
  v_chunks  int;
  v_size    bigint;
  v_have    bigint;
  v_bytes   bytea;
  v_total   bigint;
begin
  select r.status, f.chunks, f.size, octet_length(f.data)
    into v_status, v_chunks, v_size, v_have
    from public.study_request_files f
    join public.study_requests r on r.id = f.request_id
   where f.id = p_file
     for update of f;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_status <> 'open' then return jsonb_build_object('ok', false, 'error', 'not_open'); end if;
  if p_index <> v_chunks then return jsonb_build_object('ok', false, 'error', 'out_of_order'); end if;

  begin
    v_bytes := decode(p_b64, 'base64');
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'bad_chunk');
  end;

  if octet_length(v_bytes) > 1572864 then
    return jsonb_build_object('ok', false, 'error', 'chunk_too_large');
  end if;
  if v_have + octet_length(v_bytes) > v_size + 1024 then
    return jsonb_build_object('ok', false, 'error', 'oversize');
  end if;

  update public.study_request_files
     set data = data || v_bytes, chunks = chunks + 1
   where id = p_file
   returning octet_length(data) into v_total;

  return jsonb_build_object('ok', true, 'bytes', v_total);
end $$;

create or replace function public.request_finish(p_request uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_status text;
  v_count  int;
  v_bytes  bigint;
begin
  select status into v_status from public.study_requests where id = p_request;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_status <> 'open' then return jsonb_build_object('ok', false, 'error', 'not_open'); end if;

  select count(*), coalesce(sum(octet_length(data)), 0) into v_count, v_bytes
    from public.study_request_files where request_id = p_request;

  update public.study_requests
     set status = 'submitted', file_count = v_count, bytes = v_bytes
   where id = p_request;

  return jsonb_build_object('ok', true, 'ref', substring(p_request::text from 1 for 6));
end $$;

-- ---------------------------------------------------------------- admin

create or replace function public.admin_requests(p_token text, p_all boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_out
    from (
      select r.id, r.created_at, r.status, r.subject, r.purpose, r.due, r.features,
             r.other, r.notes, r.from_name, r.file_count, r.bytes,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', f.id, 'name', f.name, 'mime', f.mime,
                        'size', octet_length(f.data), 'purged', f.purged
                      ) order by f.created_at)
                 from public.study_request_files f
                where f.request_id = r.id
             ), '[]'::jsonb) as files
        from public.study_requests r
       where (case when p_all then r.status <> 'open' else r.status = 'submitted' end)
    ) t;

  return jsonb_build_object('ok', true, 'requests', v_out);
end $$;

create or replace function public.admin_request_file(p_token text, p_file uuid, p_offset bigint, p_len int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_data bytea;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select data into v_data from public.study_request_files where id = p_file;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  return jsonb_build_object(
    'ok', true,
    'b64', encode(substring(v_data from p_offset + 1 for least(coalesce(p_len, 0), 2000000)), 'base64'),
    'total', octet_length(v_data)
  );
end $$;

create or replace function public.admin_request_mark(p_token text, p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status not in ('seen', 'done', 'submitted') then
    return jsonb_build_object('ok', false, 'error', 'bad_status');
  end if;

  update public.study_requests set status = p_status where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_request_purge(p_token text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  update public.study_request_files
     set data = ''::bytea, purged = true
   where request_id = p_id;

  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- sync_push, cap raised
-- Identical to 0001_study_sync.sql's function, the payload cap only, 262144 became
-- 1048576 (1 MB) so a fuller offline queue can still push in one call.

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

  if p_payload is null or pg_column_size(p_payload) > 1048576 then
    raise exception 'payload_rejected: null or larger than 1MB';
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

revoke all on function public.sync_push(text, jsonb, timestamptz) from public;
grant execute on function public.sync_push(text, jsonb, timestamptz) to anon;

-- ---------------------------------------------------------------- grants

revoke all on function public.request_open(jsonb)                          from public;
revoke all on function public.request_file_open(uuid, text, text, bigint)  from public;
revoke all on function public.request_file_chunk(uuid, int, text)          from public;
revoke all on function public.request_finish(uuid)                         from public;
revoke all on function public.admin_requests(text, boolean)                from public;
revoke all on function public.admin_request_file(text, uuid, bigint, int)  from public;
revoke all on function public.admin_request_mark(text, uuid, text)         from public;
revoke all on function public.admin_request_purge(text, uuid)              from public;
revoke all on function public._req_clip(text, int)                        from public;

grant execute on function public.request_open(jsonb)                          to anon;
grant execute on function public.request_file_open(uuid, text, text, bigint)  to anon;
grant execute on function public.request_file_chunk(uuid, int, text)          to anon;
grant execute on function public.request_finish(uuid)                         to anon;
grant execute on function public.admin_requests(text, boolean)                to anon;
grant execute on function public.admin_request_file(text, uuid, bigint, int)  to anon;
grant execute on function public.admin_request_mark(text, uuid, text)         to anon;
grant execute on function public.admin_request_purge(text, uuid)              to anon;
-- _req_clip is an internal helper and is never granted to anon.
