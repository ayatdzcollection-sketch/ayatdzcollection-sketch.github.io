-- 0045_telemetry_devices_detail.sql
--
-- More on how each device studied, so the owner can see why most visitors did not come back
-- (asked 2026-09-22, after 0043 showed 38 devices that are not the owner's, most used on one day).
-- Same function, same owner only gate, still no install id, no card key and no time of day.
-- Each device line now also carries:
--
--   per_day      reviews on each date it was used
--   sessions     runs of reviews with no gap over 30 minutes
--   steps        reviews per kind of answer (recall, mc, test, cram ...)
--   grades       reviews per grade, 1 again to 4 easy
--   right        share graded 2 or better
--   median_s     median answer time in seconds, where one was recorded
--   repeats      reviews of a card the device had already seen on an earlier day (days_since
--                of half a day or more): the spaced repetition the hub is built around
--
-- Safe to run twice.

create or replace function public.admin_telemetry_devices(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  with r as (
    select install, material, step, grade, answer_ms, days_since, reviewed_at,
           (reviewed_at at time zone 'America/New_York')::date as day
      from public.study_reviews
     where material not like '\_probe/%'
  ),
  gaps as (
    select install,
           case when lag(reviewed_at) over (partition by install order by reviewed_at) is null
                  or reviewed_at - lag(reviewed_at) over (partition by install order by reviewed_at) > interval '30 minutes'
                then 1 else 0 end as starts
      from r
  ),
  extra as (
    select x.install,
           (select count(*) from gaps g where g.install = x.install and g.starts = 1) as sessions,
           (select jsonb_object_agg(day::text, c order by day) from (select day, count(*) c from r where r.install = x.install group by day) q) as per_day,
           (select jsonb_object_agg(coalesce(step, 'none'), c order by c desc) from (select step, count(*) c from r where r.install = x.install group by step) q) as steps,
           (select jsonb_object_agg(grade::text, c order by grade) from (select grade, count(*) c from r where r.install = x.install group by grade) q) as grades,
           (select round(avg(case when grade > 1 then 1.0 else 0.0 end)::numeric, 2) from r where r.install = x.install) as right_share,
           (select round((percentile_cont(0.5) within group (order by answer_ms) / 1000.0)::numeric, 1)
              from r where r.install = x.install and answer_ms is not null) as median_s,
           (select count(*) from r where r.install = x.install and days_since >= 0.5) as repeats
      from (select distinct install from r) x
  ),
  dev as (
    select install,
           count(*) as reviews,
           count(distinct day) as days,
           min(day) as first_day,
           max(day) as last_day
      from r group by install
  ),
  kind as (
    select d.*,
           case when d.reviews < 10 then 'tried'
                when d.days = 1     then 'one day'
                else 'returning' end as kind,
           row_number() over (order by d.reviews desc, d.first_day) as n
      from dev d
  ),
  mats as (
    select install, jsonb_object_agg(material, c order by c desc) as by_material
      from (select install, material, count(*) c from r group by install, material) x
     group by install
  ),
  days as (
    select install, jsonb_agg(day order by day) as dates
      from (select distinct install, day from r) x
     group by install
  )
  select jsonb_build_object(
    'ok', true,
    'devices', (select count(*) from kind),
    'kinds', (select coalesce(jsonb_object_agg(kind, c), '{}'::jsonb)
                from (select kind, count(*) c from kind group by kind) x),
    'by_material', (select coalesce(jsonb_object_agg(material, jsonb_build_object(
                             'devices', devs, 'returning', ret, 'reviews', revs)), '{}'::jsonb)
                      from (select r.material,
                                   count(distinct r.install) devs,
                                   count(distinct r.install) filter (where k.kind = 'returning') ret,
                                   count(*) revs
                              from r join kind k using (install)
                             group by r.material) x),
    'list', (select coalesce(jsonb_agg(jsonb_build_object(
                      'device', 'D' || k.n,
                      'kind', k.kind,
                      'reviews', k.reviews,
                      'days', k.days,
                      'first', k.first_day,
                      'last', k.last_day,
                      'dates', dd.dates,
                      'by_material', m.by_material,
                      'per_day', e.per_day,
                      'sessions', e.sessions,
                      'steps', e.steps,
                      'grades', e.grades,
                      'right', e.right_share,
                      'median_s', e.median_s,
                      'repeats', e.repeats) order by k.n), '[]'::jsonb)
               from kind k
               join mats m using (install)
               join days dd using (install)
               join extra e using (install))
  ) into v_out;

  return v_out;
end $$;

revoke all on function public.admin_telemetry_devices(text) from public;
grant execute on function public.admin_telemetry_devices(text) to anon;

notify pgrst, 'reload schema';
