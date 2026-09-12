-- Study Hub access control.
--
-- Run this in the Supabase dashboard SQL editor, after 0001_study_sync.sql.
--
-- Why this exists
--   GitHub Pages serves every file to anyone who asks; there is no server to check a
--   password first. So the protection is cryptographic rather than positional: each
--   material is stored on Pages as AES-256-GCM ciphertext, and the key lives here. A
--   stranger who fetches the .enc file gets noise. The key is handed out only to a
--   session that proved it knows a code.
--
-- What is protected, and what is not
--   * Protected: the contents of every encrypted material.
--   * NOT protected: which material ids exist, file sizes, and anything that was ever
--     published in plaintext (including in this repository's git history).
--   * Once a device unlocks a material its key is cached locally so it works offline.
--     Anyone with that unlocked device has that material.
--
-- Security model
--   * Codes are stored only as bcrypt hashes (cost 12). The plaintext never touches
--     this database, this repository, or any log.
--   * A successful login mints a 256-bit random token. Only its SHA-256 is stored, so a
--     database leak cannot be replayed as a login.
--   * RLS is on with no policies anywhere. anon may execute the listed functions and
--     nothing else. Every function pins search_path and is SECURITY DEFINER.
--   * Login is rate limited per IP, on top of bcrypt's own cost.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables

create table if not exists public.study_codes (
  role        text primary key check (role in ('admin', 'viewer')),
  code_hash   text not null,
  updated_at  timestamptz not null default now()
);
alter table public.study_codes enable row level security;

create table if not exists public.study_sessions (
  token_hash  text primary key,
  role        text not null check (role in ('admin', 'viewer')),
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked     boolean not null default false,
  label       text
);
alter table public.study_sessions enable row level security;
create index if not exists study_sessions_expiry on public.study_sessions (expires_at);

-- One row per material or link. `kind` keeps the hub's materials and the root page's
-- links in a single place so the admin controls work the same way for both.
create table if not exists public.study_items (
  id          text primary key,
  kind        text not null default 'material' check (kind in ('material', 'link')),
  class_id    text,
  class_name  text,
  term        text,
  title       text not null,
  blurb       text,
  path        text,
  tags        text[] not null default '{}',
  added       date,
  sort        int not null default 100,
  hidden      boolean not null default false,   -- not listed for viewers
  locked      boolean not null default false,   -- admin only, key withheld from viewers
  enc_key     text,                             -- base64 AES-256 key, never sent to viewers of locked items
  enc_iv_len  int not null default 12,
  updated_at  timestamptz not null default now()
);
alter table public.study_items enable row level security;

create table if not exists public.study_auth_attempts (
  ip           text primary key,
  window_start timestamptz not null default now(),
  fails        int not null default 0
);
alter table public.study_auth_attempts enable row level security;

revoke all on public.study_codes          from anon, authenticated;
revoke all on public.study_sessions       from anon, authenticated;
revoke all on public.study_items          from anon, authenticated;
revoke all on public.study_auth_attempts  from anon, authenticated;

-- ---------------------------------------------------------------- helpers

create or replace function public._auth_ip()
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

-- 10 failed code entries per IP per 15 minutes. bcrypt already makes guessing slow;
-- this makes a distributed sweep expensive rather than merely tedious.
create or replace function public._auth_rate_check(p_ip text)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
declare v_fails int; v_start timestamptz;
begin
  select fails, window_start into v_fails, v_start
    from public.study_auth_attempts where ip = p_ip;
  if found and v_start > now() - interval '15 minutes' and v_fails >= 10 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
end $$;

create or replace function public._auth_rate_fail(p_ip text)
returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into public.study_auth_attempts as a (ip, window_start, fails)
  values (p_ip, now(), 1)
  on conflict (ip) do update set
    fails        = case when a.window_start > now() - interval '15 minutes' then a.fails + 1 else 1 end,
    window_start = case when a.window_start > now() - interval '15 minutes' then a.window_start else now() end;
end $$;

-- Resolves a bearer token to a role, or null. Also slides the expiry forward so a device
-- in regular use never gets logged out, while an abandoned one lapses.
create or replace function public._auth_role(p_token text)
returns text
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare v_hash text; v_role text; v_exp timestamptz; v_revoked boolean;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  v_hash := encode(digest(p_token, 'sha256'), 'hex');
  select role, expires_at, revoked into v_role, v_exp, v_revoked
    from public.study_sessions where token_hash = v_hash;
  if not found or v_revoked or v_exp < now() then return null; end if;
  update public.study_sessions
     set last_seen = now(), expires_at = now() + interval '180 days'
   where token_hash = v_hash;
  return v_role;
end $$;

-- ---------------------------------------------------------------- bootstrap

-- Sets the two codes, and only works while none exist. After that, codes change through
-- admin_set_code, which requires an admin session.
create or replace function public.auth_bootstrap(p_admin_code text, p_viewer_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if exists (select 1 from public.study_codes) then
    return jsonb_build_object('ok', false, 'error', 'already_configured');
  end if;
  if length(coalesce(p_admin_code, '')) < 10 or length(coalesce(p_viewer_code, '')) < 10 then
    return jsonb_build_object('ok', false, 'error', 'codes_too_short');
  end if;
  if p_admin_code = p_viewer_code then
    return jsonb_build_object('ok', false, 'error', 'codes_must_differ');
  end if;
  insert into public.study_codes (role, code_hash) values
    ('admin',  crypt(p_admin_code,  gen_salt('bf', 12))),
    ('viewer', crypt(p_viewer_code, gen_salt('bf', 12)));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- login

create or replace function public.auth_login(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_ip    text := public._auth_ip();
  v_role  text;
  v_token text;
  v_exp   timestamptz;
  r       record;
begin
  perform public._auth_rate_check(v_ip);

  if p_code is null or length(p_code) < 4 then
    perform public._auth_rate_fail(v_ip);
    return jsonb_build_object('ok', false);
  end if;

  -- Test every row so the work done does not reveal which role was tried.
  for r in select role, code_hash from public.study_codes order by role loop
    if r.code_hash = crypt(p_code, r.code_hash) then
      v_role := r.role;
    end if;
  end loop;

  if v_role is null then
    perform public._auth_rate_fail(v_ip);
    return jsonb_build_object('ok', false);
  end if;

  v_token := encode(gen_random_bytes(32), 'base64');
  v_exp   := now() + interval '180 days';
  insert into public.study_sessions (token_hash, role, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_role, v_exp);

  return jsonb_build_object('ok', true, 'token', v_token, 'role', v_role, 'expires_at', v_exp);
end $$;

create or replace function public.auth_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if v_role is null then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'role', v_role);
end $$;

create or replace function public.auth_logout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if p_token is null then return jsonb_build_object('ok', true); end if;
  update public.study_sessions set revoked = true
   where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- catalog + keys

-- Hidden items are invisible to viewers. Locked items are listed (so the hub can show
-- them as locked) but their key is withheld, which is what actually protects them.
create or replace function public.auth_catalog(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if v_role is null then return jsonb_build_object('ok', false); end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.sort, t.title), '[]'::jsonb)
    into v_out
    from (
      select id, kind, class_id, class_name, term, title, blurb, path, tags, added,
             sort, hidden, locked
        from public.study_items
       where v_role = 'admin' or hidden = false
    ) t;

  return jsonb_build_object('ok', true, 'role', v_role, 'items', v_out);
end $$;

create or replace function public.auth_material_key(p_token text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_key text; v_locked boolean; v_hidden boolean;
begin
  v_role := public._auth_role(p_token);
  if v_role is null then return jsonb_build_object('ok', false, 'error', 'no_session'); end if;

  select enc_key, locked, hidden into v_key, v_locked, v_hidden
    from public.study_items where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if v_role <> 'admin' and (v_locked or v_hidden) then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;
  if v_key is null then return jsonb_build_object('ok', false, 'error', 'not_encrypted'); end if;

  return jsonb_build_object('ok', true, 'key', v_key);
end $$;

-- ---------------------------------------------------------------- admin

create or replace function public.admin_set_code(p_token text, p_role text, p_new_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_role not in ('admin', 'viewer') then return jsonb_build_object('ok', false, 'error', 'bad_role'); end if;
  if length(coalesce(p_new_code, '')) < 10 then
    return jsonb_build_object('ok', false, 'error', 'too_short');
  end if;

  -- A new code must not collide with the other role's code.
  if exists (select 1 from public.study_codes c
              where c.role <> p_role and c.code_hash = crypt(p_new_code, c.code_hash)) then
    return jsonb_build_object('ok', false, 'error', 'codes_must_differ');
  end if;

  update public.study_codes
     set code_hash = crypt(p_new_code, gen_salt('bf', 12)), updated_at = now()
   where role = p_role;

  -- Changing a code retires every session that code had issued, except the one doing it.
  update public.study_sessions
     set revoked = true
   where role = p_role
     and token_hash <> encode(digest(p_token, 'sha256'), 'hex');

  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_set_item(p_token text, p_id text, p_hidden boolean, p_locked boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  update public.study_items
     set hidden = coalesce(p_hidden, hidden),
         locked = coalesce(p_locked, locked),
         updated_at = now()
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_upsert_item(p_token text, p_item jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  insert into public.study_items
    (id, kind, class_id, class_name, term, title, blurb, path, tags, added, sort, enc_key)
  values (
    p_item ->> 'id',
    coalesce(p_item ->> 'kind', 'material'),
    p_item ->> 'class_id',
    p_item ->> 'class_name',
    p_item ->> 'term',
    p_item ->> 'title',
    p_item ->> 'blurb',
    p_item ->> 'path',
    coalesce((select array_agg(value::text) from jsonb_array_elements_text(p_item -> 'tags')), '{}'),
    nullif(p_item ->> 'added', '')::date,
    coalesce((p_item ->> 'sort')::int, 100),
    p_item ->> 'enc_key'
  )
  on conflict (id) do update set
    kind       = excluded.kind,
    class_id   = excluded.class_id,
    class_name = excluded.class_name,
    term       = excluded.term,
    title      = excluded.title,
    blurb      = excluded.blurb,
    path       = excluded.path,
    tags       = excluded.tags,
    added      = excluded.added,
    sort       = excluded.sort,
    enc_key    = coalesce(excluded.enc_key, public.study_items.enc_key),
    updated_at = now();

  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_delete_item(p_token text, p_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  delete from public.study_items where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_sessions(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.last_seen desc), '[]'::jsonb) into v_out
    from (
      select role, created_at, last_seen, expires_at,
             token_hash = encode(digest(p_token, 'sha256'), 'hex') as is_you
        from public.study_sessions
       where revoked = false and expires_at > now()
    ) t;

  return jsonb_build_object('ok', true, 'sessions', v_out);
end $$;

-- Signs every other device out. The one calling this stays in.
create or replace function public.admin_revoke_others(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_n int;
begin
  v_role := public._auth_role(p_token);
  if v_role <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  update public.study_sessions set revoked = true
   where revoked = false
     and token_hash <> encode(digest(p_token, 'sha256'), 'hex');
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'revoked', v_n);
end $$;

-- ---------------------------------------------------------------- grants

revoke all on function public.auth_bootstrap(text, text)            from public;
revoke all on function public.auth_login(text)                      from public;
revoke all on function public.auth_session(text)                    from public;
revoke all on function public.auth_logout(text)                     from public;
revoke all on function public.auth_catalog(text)                    from public;
revoke all on function public.auth_material_key(text, text)         from public;
revoke all on function public.admin_set_code(text, text, text)      from public;
revoke all on function public.admin_set_item(text, text, boolean, boolean) from public;
revoke all on function public.admin_upsert_item(text, jsonb)        from public;
revoke all on function public.admin_delete_item(text, text)         from public;
revoke all on function public.admin_sessions(text)                  from public;
revoke all on function public.admin_revoke_others(text)             from public;
revoke all on function public._auth_ip()                            from public;
revoke all on function public._auth_rate_check(text)                from public;
revoke all on function public._auth_rate_fail(text)                 from public;
revoke all on function public._auth_role(text)                      from public;

grant execute on function public.auth_bootstrap(text, text)            to anon;
grant execute on function public.auth_login(text)                      to anon;
grant execute on function public.auth_session(text)                    to anon;
grant execute on function public.auth_logout(text)                     to anon;
grant execute on function public.auth_catalog(text)                    to anon;
grant execute on function public.auth_material_key(text, text)         to anon;
grant execute on function public.admin_set_code(text, text, text)      to anon;
grant execute on function public.admin_set_item(text, text, boolean, boolean) to anon;
grant execute on function public.admin_upsert_item(text, jsonb)        to anon;
grant execute on function public.admin_delete_item(text, text)         to anon;
grant execute on function public.admin_sessions(text)                  to anon;
grant execute on function public.admin_revoke_others(text)             to anon;
