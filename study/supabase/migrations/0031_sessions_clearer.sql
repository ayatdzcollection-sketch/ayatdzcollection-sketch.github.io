-- 0031_sessions_clearer.sql
--
-- What the owner panel's device count means. On 2026-09-18 it read "55 active devices (54 admin,
-- 1 viewer)" and the owner could not tell whether that was them or someone else. It was them:
-- every sign in with the admin code makes a session that lives 180 days, and the publish and
-- request scripts signed in on every run and never signed out (49 of the 54 were used once, in
-- the minute they were made). The scripts now sign out when they finish; this makes the count
-- say what it is and gives the owner one tap to clear the leftovers.
--
--   * admin_sessions also says, per session, whether it came from an access code (code, and the
--     code's label) so the panel can count devices, one time sign ins and code holders apart.
--   * admin_revoke_stale signs out owner and viewer sessions that were never used again after
--     the first five minutes and are over an hour old, and any not seen for 30 days. It never
--     touches the caller's own session or a code holder's (those follow the code's own switch).
--
-- Safe to run twice.

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

  select coalesce(jsonb_agg(to_jsonb(t) order by t.last_seen desc nulls last), '[]'::jsonb) into v_out
    from (
      select s.role, s.created_at, s.last_seen, s.expires_at,
             s.token_hash = encode(digest(p_token, 'sha256'), 'hex') as is_you,
             s.pass_id is not null as code,
             p.label as code_label
        from public.study_sessions s
        left join public.study_ai_passes p on p.id = s.pass_id
       where s.revoked = false and s.expires_at > now()
    ) t;

  return jsonb_build_object('ok', true, 'sessions', v_out);
end $$;

create or replace function public.admin_revoke_stale(p_token text)
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
     and pass_id is null
     and token_hash <> encode(digest(p_token, 'sha256'), 'hex')
     and ((coalesce(last_seen, created_at) < created_at + interval '5 minutes' and created_at < now() - interval '1 hour')
          or coalesce(last_seen, created_at) < now() - interval '30 days');
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'revoked', v_n);
end $$;

revoke all on function public.admin_sessions(text)     from public;
revoke all on function public.admin_revoke_stale(text) from public;
grant execute on function public.admin_sessions(text)     to anon;
grant execute on function public.admin_revoke_stale(text) to anon;

notify pgrst, 'reload schema';
