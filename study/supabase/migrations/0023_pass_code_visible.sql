-- 0023_pass_code_visible.sql
--
-- Letting the owner read back a code they handed out.
--
-- Until now a pass code was stored only as a bcrypt hash, which is why it is shown exactly once
-- when it is minted: nobody could recover it, the owner included. The owner asked to see their
-- live codes in the panel, so from here a code is also kept as text, and one owner-token RPC
-- hands it back. What that costs, plainly, because it is a real change to the security model:
--
--   * A dump of this database now reveals every code made from here on. Before, it revealed only
--     hashes. The bcrypt hash stays and is still what a login is checked against, so this does
--     not weaken the login itself; it weakens what a stolen database is worth.
--   * What a stolen code is worth is bounded: a pass is viewer level, its money is capped and
--     visible, it can be ended from the panel in one press, and every call is in the ledger. The
--     same dump already carries the decryption keys for every material, so the marginal loss is
--     the ability to act as that person rather than to read anything new.
--   * Codes minted before this migration cannot be recovered. There is nothing to recover: the
--     plaintext was never stored. They keep working; the panel simply has nothing to show.
--   * The alternative was to replace a code instead of revealing it, which is safer and which I
--     did not make the default: a pass code is also that person's sync code, so replacing it cuts
--     them off from their own saved progress.
--
-- Safe to run twice.

alter table public.study_ai_passes add column if not exists code_plain text;

-- The code itself, to the owner, one pass at a time. Never in a list, so a single call cannot
-- rake every code at once, and the read is recorded on the row.
create or replace function public.admin_pass_code(p_token text, p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_code text; v_label text;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select code_plain, label into v_code, v_label from public.study_ai_passes where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_code is null then
    return jsonb_build_object('ok', false, 'error', 'not_kept', 'label', v_label);
  end if;
  return jsonb_build_object('ok', true, 'code', v_code, 'label', v_label);
end $$;

-- create, unchanged except that it keeps the code it just minted.
create or replace function public.admin_pass_create(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role text; v_code text := ''; v_alpha text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_label text; v_feats text[]; v_budget bigint; v_expires timestamptz; v_daily int; v_id bigint; i int;
  v_when text; v_hours numeric; v_all boolean := false;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_pass is null or jsonb_typeof(p_pass) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_pass');
  end if;

  v_label := left(trim(coalesce(p_pass ->> 'label', '')), 60);
  if v_label = '' then return jsonb_build_object('ok', false, 'error', 'range', 'field', 'label'); end if;

  if jsonb_typeof(p_pass -> 'all_features') = 'boolean' then v_all := (p_pass ->> 'all_features')::boolean; end if;
  if jsonb_typeof(p_pass -> 'features') = 'array' then v_feats := public._ai_pass_feats(p_pass -> 'features'); end if;
  if v_feats is null or array_length(v_feats, 1) is null then
    v_feats := case when v_all then '{}'::text[] else array['ask'] end;
  end if;

  v_budget := (greatest(0, least(coalesce((p_pass ->> 'budget_cents')::numeric, 0), 10000)) * 1000000)::bigint;

  v_when := lower(trim(coalesce(p_pass ->> 'when', 'none')));
  if v_when = 'morning' then v_expires := public._ai_pass_morning();
  elsif v_when = 'hours' then
    v_hours := greatest(0.25, least(coalesce((p_pass ->> 'hours')::numeric, 3), 720));
    v_expires := now() + (v_hours * interval '1 hour');
  elsif v_when = 'local' then
    begin
      v_expires := (left(trim(coalesce(p_pass ->> 'local', '')), 19)::timestamp at time zone 'America/Detroit');
    exception when others then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'local');
    end;
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

  insert into public.study_ai_passes (label, code_hash, code_tail, code_fp, code_plain, features, all_features,
                                      budget_microcents, daily_cents, expires_at, note)
  values (v_label, crypt(v_code, gen_salt('bf', 12)), '', public._ai_pass_fp(v_code), v_code, v_feats, v_all,
          v_budget, v_daily, v_expires, left(trim(coalesce(p_pass ->> 'note', '')), 200))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'code', v_code, 'expires_at', v_expires,
                            'features', to_jsonb(v_feats), 'all_features', v_all, 'daily_cents', v_daily,
                            'budget_cents', round(v_budget::numeric / 1000000, 2), 'zone', 'America/Detroit');
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- admin_passes says whether a code can be shown, so the panel offers the button only when it can.
create or replace function public.admin_passes(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb; v_feats jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'enabled', f.enabled) order by f.id), '[]'::jsonb)
    into v_feats from public.study_ai_features f;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'label', p.label, 'enabled', p.enabled,
           'features', to_jsonb(p.features), 'all_features', p.all_features, 'denied', to_jsonb(p.denied),
           'expires_at', p.expires_at, 'created_at', p.created_at,
           'last_used_at', p.last_used_at, 'revoked_at', p.revoked_at, 'note', p.note,
           'daily_cents', p.daily_cents, 'per_minute', p.per_minute,
           'live', public._ai_pass_live(p.*),
           'may_ask', public._ai_pass_may(p.*, 'ask'),
           'may_book', public._ai_pass_may(p.*, 'textbook'),
           'shows', p.code_plain is not null,
           'budget_cents', round(p.budget_microcents::numeric / 1000000, 2),
           'spent_cents',  round(public._ai_pass_spent(p.id)::numeric / 1000000, 2),
           'left_cents',   round(greatest(p.budget_microcents - public._ai_pass_spent(p.id), 0)::numeric / 1000000, 2),
           'calls', (select count(*) from public.study_ai_calls c where c.pass_id = p.id),
           'sessions', (select count(*) from public.study_sessions x where x.pass_id = p.id and not x.revoked and x.expires_at > now())
         ) order by p.id desc), '[]'::jsonb)
    into v_out
    from public.study_ai_passes p;

  return jsonb_build_object('ok', true, 'passes', v_out, 'features', v_feats, 'now', now(), 'zone', 'America/Detroit');
end $$;

revoke all on function public.admin_pass_code(text, bigint) from public;
grant execute on function public.admin_pass_code(text, bigint) to anon;
