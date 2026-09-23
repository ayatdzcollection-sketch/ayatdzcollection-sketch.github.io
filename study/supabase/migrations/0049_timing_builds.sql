-- 0049_timing_builds.sql
--
-- admin_telemetry_timing also lists which builds of the material each row of answers came from,
-- with how many answers each build logged and how many of those were under half a second. On
-- 2026-09-22 every Crucible 3 and 4 feed and cram answer read about 0.1 seconds while the current
-- build measured 2.3 seconds for the same kind of answer; the build stamp is what tells an old
-- copy of a page from a live bug. Owner only, totals only. Safe to run twice.

create or replace function public.admin_telemetry_timing(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  with base as (
    select material, coalesce(step, 'none') as step, answer_ms, build, timing
      from public.study_reviews
     where material not like '\_probe/%'
  ),
  builds as (
    select material, step, jsonb_object_agg(coalesce(build, 'none'), jsonb_build_object('n', n, 'fast', fast)) as builds
      from (select material, step, build, count(*) n, count(*) filter (where answer_ms < 500) fast
              from base group by material, step, build) b
     group by material, step
  ),
  rows as (
    select b.material, b.step,
           count(*) as n,
           count(b.answer_ms) as timed,
           count(*) filter (where b.build is null) as no_build,
           count(*) filter (where b.answer_ms < 500) as under_half_s,
           round((percentile_cont(0.5) within group (order by b.answer_ms) / 1000.0)::numeric, 1) as median_s,
           round((percentile_cont(0.1) within group (order by b.answer_ms) / 1000.0)::numeric, 1) as p10_s,
           jsonb_agg(distinct coalesce(b.timing, 'old')) as how
      from base b group by b.material, b.step
  )
  select jsonb_build_object('ok', true, 'rows', coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object('builds', bu.builds)
                                                                  order by x.material, x.step), '[]'::jsonb))
    into v_out
    from rows x join builds bu using (material, step);

  return v_out;
end $$;

revoke all on function public.admin_telemetry_timing(text) from public;
grant execute on function public.admin_telemetry_timing(text) to anon;

notify pgrst, 'reload schema';
