-- 0054: a flag on a generated question counts only from a device the hub has seen (2026-09-26).
--
-- gen_flag took any install id, so a script could invent two and retire every question. It now
-- needs an install already in study_devices (written by the hub's own telemetry). A person with
-- telemetry off can still flag: the flag hides the question on their device, it just does not
-- count toward retiring it for everyone. No em dashes and no en dashes.
create or replace function public.gen_flag(p_id bigint, p_install text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_install text := left(trim(coalesce(p_install, '')), 64); v_m text; v_n int;
begin
  if v_install = '' or v_install !~ '^[A-Za-z0-9_-]{8,64}$' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select material into v_m from public.study_gen_items where id = p_id;
  if v_m is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not exists (select 1 from public.study_devices d where d.install = v_install) then
    return jsonb_build_object('ok', true, 'counted', false);
  end if;
  insert into public.study_gen_flags (item_id, install, reason) values (p_id, v_install, left(coalesce(p_reason, ''), 200))
    on conflict (item_id, install) do nothing;
  select count(*) into v_n from public.study_gen_flags where item_id = p_id;
  update public.study_gen_items set flags = v_n, updated_at = now() where id = p_id;
  perform public._gen_sweep(v_m);
  return jsonb_build_object('ok', true, 'counted', true, 'flags', v_n);
end $$;
revoke all on function public.gen_flag(bigint, text, text) from public;
grant execute on function public.gen_flag(bigint, text, text) to anon;
