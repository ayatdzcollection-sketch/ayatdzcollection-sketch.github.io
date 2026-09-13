-- Fix: every admin function let a caller with no session through.
--
-- Run this in the Supabase dashboard SQL editor NOW, before anything else. It replaces six
-- functions from 0002_auth.sql and changes nothing else; no data moves.
--
-- What was wrong
--   Each admin function starts with
--       v_role := public._auth_role(p_token);
--       if v_role <> 'admin' then return ... 'forbidden'; end if;
--   _auth_role returns null for a token it does not recognise, and in SQL null <> 'admin'
--   is null, not true. plpgsql treats a null condition as false, so the refusal was skipped
--   and the function carried on. Anyone who called these RPCs directly with a made-up token
--   could change the admin or viewer code, unlock or hide or delete a material, rewrite a
--   catalog entry, list sessions, or sign every device out. On 2026-09-13 a read-only call to
--   admin_sessions with a fake token returned the real session list, which is how it was found.
--   0003 had already fixed the same mistake in auth_material_key with coalesce; the admin
--   functions never got it.
--
-- The fix is the same coalesce, in each of the six. Bodies are otherwise identical to 0002.

create or replace function public.admin_set_code(p_token text, p_role text, p_new_code text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
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
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

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
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

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
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
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
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.last_seen desc), '[]'::jsonb) into v_out
    from (
      select role, created_at, last_seen, expires_at,
             token_hash = encode(digest(p_token, 'sha256'), 'hex') as is_you
        from public.study_sessions
       where revoked = false and expires_at > now()
    ) t;

  return jsonb_build_object('ok', true, 'sessions', v_out);
end $$;

create or replace function public.admin_revoke_others(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_n int;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  update public.study_sessions set revoked = true
   where revoked = false
     and token_hash <> encode(digest(p_token, 'sha256'), 'hex');
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'revoked', v_n);
end $$;
