-- Open the materials to everyone; keep the controls to the admin.
--
-- Run after 0002_auth.sql. Replaces two functions; nothing is dropped and no data moves.
--
-- What changes
--   Anyone may list materials and get the key for one, with no code at all. The default
--   state of a material is readable.
--
-- What does not change
--   Materials stay AES-256-GCM ciphertext on disk, and the key still comes from here.
--   That is what keeps "locked" meaningful and instant: flipping the switch in the admin
--   panel withholds the key immediately, with no republish and no file to delete. A
--   locked or hidden item needs an admin session, exactly as before.
--
--   So the encryption is no longer hiding the material from the public — it is what makes
--   the lock a real lock for the ones you do hold back.

create or replace function public.auth_catalog(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);      -- null for a visitor with no code

  select coalesce(jsonb_agg(to_jsonb(t) order by t.sort, t.title), '[]'::jsonb)
    into v_out
    from (
      select id, kind, class_id, class_name, term, title, blurb, path, tags, added,
             sort, hidden, locked
        from public.study_items
       where coalesce(v_role, '') = 'admin' or hidden = false
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

  select enc_key, locked, hidden into v_key, v_locked, v_hidden
    from public.study_items where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  -- Held back on purpose: the key is the gate, so only an admin gets past it.
  if (v_locked or v_hidden) and coalesce(v_role, '') <> 'admin' then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;

  if v_key is null then return jsonb_build_object('ok', false, 'error', 'not_encrypted'); end if;

  return jsonb_build_object('ok', true, 'key', v_key);
end $$;

revoke all on function public.auth_catalog(text)            from public;
revoke all on function public.auth_material_key(text, text) from public;
grant execute on function public.auth_catalog(text)            to anon;
grant execute on function public.auth_material_key(text, text) to anon;
