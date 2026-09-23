-- 0047_telemetry_devices_visits.sql
--
-- admin_telemetry_devices, now reading the visit diary and device descriptions from 0046 as
-- well as the review log. Still owner only, still no install id, card key or time of day in
-- what it returns. New per device:
--
--   owner, local   the device said it holds the owner's session, or ran on a local test server
--   profile        the coarse browser description (os, browser, app it was opened in, phone or
--                  tablet or computer, Home Screen, screen size, time zone, language) and how its
--                  install id came to be: id 'ls' | 'cookie' | 'idb' | 'new', born, prior signs
--   same_as        a group label shared by devices whose descriptions match exactly and whose
--                  dates never overlap: probably one browser that was wiped
--   person         a group label shared by devices that carried the same synced person id, which
--                  only happens when they were paired with one save code
--   visits         pages opened, pages that ended with no answer, minutes in front of the student,
--                  the screen each visit ended on, errors, suggestions shown, quiz check ins
--
-- Devices that opened pages but never answered anything are listed too (kind 'looked'); before
-- 0046 they were invisible. Top level, the errors grouped by message and the check ins.
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
  ev as (
    select install, page, kind, material, at, data,
           (at at time zone 'America/New_York')::date as day
      from public.study_events
  ),
  installs as (
    select install from r union select install from ev union select install from public.study_devices
  ),
  rdev as (
    select install, count(*) as reviews, min(day) as first_day, max(day) as last_day
      from r group by install
  ),
  alldays as (
    select install, day from r union select install, day from ev
  ),
  dev as (
    select i.install,
           coalesce(rd.reviews, 0) as reviews,
           (select count(distinct day) from alldays a where a.install = i.install) as days,
           (select min(day) from alldays a where a.install = i.install) as first_day,
           (select max(day) from alldays a where a.install = i.install) as last_day,
           d.profile, d.persons, d.first_seen, d.last_seen
      from installs i
      left join rdev rd using (install)
      left join public.study_devices d using (install)
  ),
  kind as (
    select d.*,
           case when d.reviews = 0  then 'looked'
                when d.reviews < 10 then 'tried'
                when d.days = 1     then 'one day'
                else 'returning' end as kind,
           coalesce((d.profile ->> 'owner')::boolean, false) as owner,
           coalesce((d.profile ->> 'local')::boolean, false) as local,
           row_number() over (order by d.reviews desc, d.first_day nulls last, d.install) as n
      from dev d
  ),
  -- Devices that describe themselves identically. Standalone is left out of the match: adding
  -- to the Home Screen changes it without changing the browser underneath.
  pkey as (
    select install, n, first_day, last_day,
           concat_ws('|', profile ->> 'os', profile ->> 'osv', profile ->> 'br', profile ->> 'app',
                     profile ->> 'kind', profile ->> 'scr', profile ->> 'dpr', profile ->> 'tz', profile ->> 'lang') as k
      from kind
     where profile is not null and not owner and not local
  ),
  pgroups as (
    select k, 'S' || row_number() over (order by min(n)) as label
      from pkey group by k
    having count(*) > 1
       -- and no two of them were used on the same day
       and not exists (
         select 1 from pkey a join pkey b on a.k = b.k and a.install < b.install
          join alldays da on da.install = a.install
          join alldays db on db.install = b.install and db.day = da.day
         where a.k = pkey.k)
  ),
  persons as (
    select install, unnest(persons) as person from kind where cardinality(coalesce(persons, '{}')) > 0
  ),
  pers_groups as (
    select person, 'P' || row_number() over (order by min(k.n)) as label
      from persons p join kind k using (install)
     group by person having count(distinct install) > 1
  ),
  mats as (
    select install, jsonb_object_agg(material, c order by c desc) as by_material
      from (select install, material, count(*) c from r group by install, material) x
     group by install
  ),
  gaps as (
    select install,
           case when lag(reviewed_at) over (partition by install order by reviewed_at) is null
                  or reviewed_at - lag(reviewed_at) over (partition by install order by reviewed_at) > interval '30 minutes'
                then 1 else 0 end as starts
      from r
  ),
  rextra as (
    select x.install,
           (select count(*) from gaps g where g.install = x.install and g.starts = 1) as sessions,
           (select jsonb_object_agg(coalesce(step, 'none'), c order by c desc) from (select step, count(*) c from r where r.install = x.install group by step) q) as steps,
           (select jsonb_object_agg(grade::text, c order by grade) from (select grade, count(*) c from r where r.install = x.install group by grade) q) as grades,
           (select round(avg(case when grade > 1 then 1.0 else 0.0 end)::numeric, 2) from r where r.install = x.install) as right_share,
           (select round((percentile_cont(0.5) within group (order by answer_ms) / 1000.0)::numeric, 1)
              from r where r.install = x.install and answer_ms is not null) as median_s,
           (select count(*) from r where r.install = x.install and days_since >= 0.5) as repeats
      from (select distinct install from r) x
  ),
  per_day as (
    select install, jsonb_object_agg(day::text, c order by day) as per_day
      from (select install, day, count(*) c from r group by install, day) q group by install
  ),
  dates as (
    select install, jsonb_agg(day order by day) as dates from (select distinct install, day from alldays) x group by install
  ),
  -- One line per page load: where it was, how long it was in front of the student, how many
  -- answers, and the figures from its last hide or close (the last thing a page says).
  pages as (
    select install, page,
           max(material) as material,
           min(at) as opened,
           (array_agg(data order by at desc) filter (where kind in ('hide', 'close')))[1] as last_fig,
           (array_agg(data order by at) filter (where kind = 'open'))[1] as open_data,
           count(*) filter (where kind = 'error') as errors
      from ev group by install, page
  ),
  visits as (
    select install,
           count(*) as pages,
           count(*) filter (where coalesce((last_fig ->> 'n')::int, 0) = 0) as no_answer,
           round(sum(coalesce((last_fig ->> 'act')::numeric, 0)) / 60.0, 1) as active_min,
           sum(errors) as errors,
           (select jsonb_object_agg(scr, c order by c desc) from (
              select coalesce(p2.last_fig ->> 'scr', '?') as scr, count(*) c
                from pages p2 where p2.install = pages.install and p2.last_fig is not null
               group by 1) q) as ended_on,
           (select jsonb_object_agg(ref, c order by c desc) from (
              select coalesce(p3.open_data ->> 'ref', 'direct') as ref, count(*) c
                from pages p3 where p3.install = pages.install and p3.open_data is not null
               group by 1) q) as came_from,
           jsonb_agg(jsonb_build_object(
              'day', (opened at time zone 'America/New_York')::date,
              'material', material,
              'act_s', (last_fig ->> 'act')::int,
              'n', (last_fig ->> 'n')::int,
              'ok', (last_fig ->> 'ok')::int,
              'step', last_fig ->> 'step',
              'scr', last_fig ->> 'scr',
              'errors', errors) order by opened) as list
      from pages group by install
  ),
  nudges as (
    select install, jsonb_agg(jsonb_build_object('day', day, 'material', material) || coalesce(data, '{}'::jsonb) order by at) as nudges
      from ev where kind = 'nudge' group by install
  ),
  checkins as (
    select install, jsonb_agg(jsonb_build_object('day', day, 'material', material) || coalesce(data, '{}'::jsonb) order by at) as checkins
      from ev where kind = 'checkin' group by install
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
    'errors', (select coalesce(jsonb_agg(x order by x.count desc), '[]'::jsonb) from (
                 select e.data ->> 'msg' as msg, e.data ->> 'file' as file, (e.data ->> 'line')::int as line,
                        count(*) as count, count(distinct e.install) as devices,
                        jsonb_agg(distinct e.material) as materials, max(e.day) as last
                   from ev e where e.kind = 'error'
                  group by 1, 2, 3) x),
    'list', (select coalesce(jsonb_agg(jsonb_build_object(
                      'device', 'D' || k.n,
                      'kind', k.kind,
                      'owner', k.owner,
                      'local', k.local,
                      'reviews', k.reviews,
                      'days', k.days,
                      'first', k.first_day,
                      'last', k.last_day,
                      'dates', dd.dates,
                      'by_material', m.by_material,
                      'per_day', pd.per_day,
                      'sessions', x.sessions,
                      'steps', x.steps,
                      'grades', x.grades,
                      'right', x.right_share,
                      'median_s', x.median_s,
                      'repeats', x.repeats,
                      'profile', k.profile,
                      'same_as', (select g.label from pkey pk join pgroups g using (k) where pk.install = k.install),
                      'person', (select min(pg.label) from persons p join pers_groups pg using (person) where p.install = k.install),
                      'visits', case when v.install is null then null else jsonb_build_object(
                                  'pages', v.pages, 'no_answer', v.no_answer, 'active_min', v.active_min,
                                  'errors', v.errors, 'ended_on', v.ended_on, 'came_from', v.came_from,
                                  'list', v.list) end,
                      'nudges', nu.nudges,
                      'checkins', ci.checkins) order by k.n), '[]'::jsonb)
               from kind k
               left join mats m using (install)
               left join dates dd using (install)
               left join per_day pd using (install)
               left join rextra x using (install)
               left join visits v using (install)
               left join nudges nu using (install)
               left join checkins ci using (install))
  ) into v_out;

  return v_out;
end $$;

revoke all on function public.admin_telemetry_devices(text) from public;
grant execute on function public.admin_telemetry_devices(text) to anon;

notify pgrst, 'reload schema';
