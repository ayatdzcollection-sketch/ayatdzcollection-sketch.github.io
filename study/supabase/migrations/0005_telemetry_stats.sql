-- How much review data has arrived, in totals only.
--
-- Run this in the Supabase dashboard SQL editor, same as 0004. It adds one read-only
-- function and changes nothing else.
--
-- Why it exists
--   0004 made study_reviews write-only from outside, on purpose: RLS on, no policies, one
--   SECURITY DEFINER function that only inserts. That also meant nobody, the owner included,
--   could see how much had been collected without opening the dashboard. This returns
--   counts and date ranges and nothing else, so the hub can say "N reviews collected"
--   without any row, card key, install id or timestamp of an individual review leaving the
--   database.
--
-- What it returns
--   reviews          total rows
--   devices          distinct install ids (random per device, not per person)
--   first, last      the earliest and latest review times
--   with_time        rows that carry an answer time
--   with_prediction  rows that carry the model's predicted retrievability (every review
--                    after a card's first; these are the pairs an optimiser can use)
--   by_material      rows per material
--   by_step          rows per kind of answer (recall, mc, quiz, worked, concept ...)
--   grades           rows per grade, 1 again to 4 easy
--   recalled_when_forecast_90 observed recall rate among reviews the model forecast at
--                    85 to 95 per cent: the one number that says whether it is calibrated

create or replace function public.telemetry_stats()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'reviews',          (select count(*) from public.study_reviews),
    'devices',          (select count(distinct install) from public.study_reviews),
    'first',            (select min(reviewed_at) from public.study_reviews),
    'last',             (select max(reviewed_at) from public.study_reviews),
    'with_time',        (select count(*) from public.study_reviews where answer_ms is not null),
    'with_prediction',  (select count(*) from public.study_reviews where retrievability is not null),
    'by_material',      (select coalesce(jsonb_object_agg(material, n), '{}'::jsonb)
                           from (select material, count(*) n from public.study_reviews group by material) x),
    'by_step',          (select coalesce(jsonb_object_agg(coalesce(step, 'none'), n), '{}'::jsonb)
                           from (select step, count(*) n from public.study_reviews group by step) x),
    'grades',           (select coalesce(jsonb_object_agg(grade::text, n), '{}'::jsonb)
                           from (select grade, count(*) n from public.study_reviews group by grade) x),
    'recalled_when_forecast_90', (select jsonb_build_object(
                           'n', count(*),
                           'recalled', round(avg(case when grade > 1 then 1.0 else 0.0 end)::numeric, 3))
                           from public.study_reviews where retrievability between 0.85 and 0.95)
  );
$$;

revoke all on function public.telemetry_stats() from public;
grant execute on function public.telemetry_stats() to anon;
