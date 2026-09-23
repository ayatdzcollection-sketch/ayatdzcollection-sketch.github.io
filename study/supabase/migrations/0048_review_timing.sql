-- 0048_review_timing.sql
--
-- How each answer time was measured, and a way to see answer times by material and step.
--
-- From 2026-09-22 the shared store (assets/sync.js) takes time spent in the background off an
-- answer's time, and where a mode sends no time it estimates one from the gap since the page's
-- previous answer. Each review now says which: 'page' measured by the material, 'net' measured
-- less time away, 'gap' estimated, 'hidden' answered while the page could not be seen (a script,
-- not a person), null for everything sent before this (or by a page still running an older copy
-- of sync.js). Analyses should keep 'gap' apart from the other two.
--
-- admin_telemetry_timing (owner only, totals only) answers "which modes send no time, and which
-- send times too short to be real": per material and step, how many answers, how many with a
-- time, the median and the tenth percentile, how many under half a second, and how many came
-- from builds too old to carry a build stamp.
--
-- Safe to run twice.

alter table public.study_reviews add column if not exists timing text;

create or replace function public.telemetry_ingest(p_install text, p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_count int;
begin
  if p_install is null or length(p_install) < 8 or length(p_install) > 64 then
    return jsonb_build_object('ok', false, 'error', 'bad_install');
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_events');
  end if;

  v_count := jsonb_array_length(p_events);
  if v_count = 0 then return jsonb_build_object('ok', true, 'stored', 0); end if;
  if v_count > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  insert into public.study_reviews
    (install, material, card, scheduler, step, reviewed_at, grade,
     answer_ms, days_since, stability, difficulty, retrievability, reps, lapses, chosen,
     correct, build, timing)
  select
    p_install,
    left(e ->> 'm', 120),
    left(e ->> 'c', 120),
    left(e ->> 'v', 20),
    left(e ->> 'k', 20),
    to_timestamp(((e ->> 't')::numeric) / 1000),
    greatest(1, least(4, (e ->> 'g')::int)),
    nullif(e ->> 'ms', '')::int,
    nullif(e ->> 'dt', '')::real,
    nullif(e ->> 's',  '')::real,
    nullif(e ->> 'd',  '')::real,
    nullif(e ->> 'r',  '')::real,
    nullif(e ->> 'n',  '')::int,
    nullif(e ->> 'l',  '')::int,
    nullif(e ->> 'w',  '')::smallint,
    case e ->> 'ok' when 'true' then true when 'false' then false else null end,
    left(nullif(e ->> 'b', ''), 80),
    case e ->> 'mt' when 'page' then 'page' when 'net' then 'net' when 'gap' then 'gap' when 'hidden' then 'hidden' else null end
  from jsonb_array_elements(p_events) as e
  where e ->> 'm' is not null
    and e ->> 'c' is not null
    and e ->> 't' is not null
    and e ->> 'g' is not null
    and to_timestamp(((e ->> 't')::numeric) / 1000)
        between now() - interval '2 years' and now() + interval '1 day'
  on conflict (install, material, card, reviewed_at) do nothing;

  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'stored', v_count);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.telemetry_ingest(text, jsonb) from public;
grant execute on function public.telemetry_ingest(text, jsonb) to anon;

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

  select jsonb_build_object('ok', true, 'rows', coalesce(jsonb_agg(x order by x.material, x.step), '[]'::jsonb))
    into v_out
    from (
      select material, coalesce(step, 'none') as step,
             count(*) as n,
             count(answer_ms) as timed,
             count(*) filter (where build is null) as no_build,
             count(*) filter (where answer_ms < 500) as under_half_s,
             round((percentile_cont(0.5) within group (order by answer_ms) / 1000.0)::numeric, 1) as median_s,
             round((percentile_cont(0.1) within group (order by answer_ms) / 1000.0)::numeric, 1) as p10_s,
             jsonb_agg(distinct coalesce(timing, 'old')) as how
        from public.study_reviews
       where material not like '\_probe/%'
       group by material, coalesce(step, 'none')
    ) x;

  return v_out;
end $$;

revoke all on function public.admin_telemetry_timing(text) from public;
grant execute on function public.admin_telemetry_timing(text) to anon;

notify pgrst, 'reload schema';
