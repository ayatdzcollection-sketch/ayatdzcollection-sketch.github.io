-- 0043_telemetry_devices.sql
--
-- How many people the review logs come from, not just how many browsers.
--
-- On 2026-09-22 telemetry_stats said 4,136 reviews from 44 devices, and the owner asked whether
-- that was them or other people. A device is a random id per browser: clearing site data, the
-- in-app browser, the iOS Simulator and the local test page each make a new one, so 44 devices
-- could be one person testing or a dozen people studying. The only way to tell is to look at how
-- each device was used: a browser that answered six questions once is a test, one that came
-- back on five days for the same class is somebody studying.
--
-- admin_telemetry_devices gives one line per device with no install id in it, only a label
-- (D1, D2 ... by review count), its review count, the days it was used (dates only, New York
-- time, never a time of day), and its reviews per material. It also sorts devices into three
-- kinds and counts devices per material. Because a per device profile says more than totals do,
-- this one is owner only: it needs an admin session token, the same as admin_sessions, and is
-- not open to the anon key the way telemetry_stats is.
--
--   tried      fewer than 10 reviews in all
--   one day    10 or more reviews, all on one day
--   returning  used on two or more days
--
-- Read only. Changes nothing in study_reviews. Safe to run twice.

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
    select install, material, (reviewed_at at time zone 'America/New_York')::date as day
      from public.study_reviews
     where material not like '\_probe/%'
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
                      'by_material', m.by_material) order by k.n), '[]'::jsonb)
               from kind k
               join mats m using (install)
               join days dd using (install))
  ) into v_out;

  return v_out;
end $$;

revoke all on function public.admin_telemetry_devices(text) from public;
grant execute on function public.admin_telemetry_devices(text) to anon;

notify pgrst, 'reload schema';
