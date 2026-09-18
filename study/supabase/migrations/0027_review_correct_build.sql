-- 0027_review_correct_build.sql
--
-- Whether an answer was right, and which build of the material marked it.
--
-- Run this in the Supabase dashboard SQL editor after 0009 (and the rest). Until it runs,
-- clients send the two new fields and the ingest ignores them, the same way 0009 went in;
-- nothing breaks and nothing is lost except those two fields on the rows sent meanwhile.
-- Safe to run twice: the columns are added only if missing, and the function is replaced.
--
-- Why correct
--   The grade is not correctness. It mixes whether the answer was right with a judgement
--   for the scheduler: the periodic table grades a right tap out of four as HARD (2) on
--   purpose, the shared engine grades a slow right answer HARD, and a misspelled name is
--   HARD too. Reading grade > 2 as "right" made multiple choice look 40 per cent right when
--   it was 90. From here every client sends ok, true or false, set from the page's own
--   verdict and never from the grade. It means exactly right: a near miss the page marks
--   apart from right (a misspelling, a value at the wrong precision, a French word with the
--   wrong article) is false, and its grade still carries the partial credit, so a false row
--   graded 2 is a near miss. A self-marked written answer is what the student marked. A
--   name shown for the first time (step 'teach') is not an answer and sends no ok.
--
-- Why build
--   Two devices on different cached copies of a material graded the same step differently
--   in the same week, and nothing in the data said so. Every client now sends b, the
--   material id and a hash of the material's own script text, for example
--   'chem/periodic-table@128um7g'. The page computes it on the first answer, so any edit to
--   the engine or the questions changes it and nothing has to be bumped by hand. To name a
--   build, hash the main script of a given source the same way (32-bit FNV-1a, base 36).
--
-- What else changed in what clients send, with no schema change
--   w (chosen, 0009) now comes with every wrong answer where a choice was offered: the
--   option's index in the question's own list where it has one, its position on screen
--   where the options are drawn fresh each time (an element, a name), and for true or
--   false 0 for True and 1 for False. Typed and self-marked answers have no choice and send
--   none. ms now comes with quiz and test answers where the page shows one question, or one
--   set, at a time; a paper with every question on one page cannot say when a question
--   appeared and still sends none.
--
-- Old clients send neither field and keep working: both columns stay null for them. A
-- malformed ok becomes null rather than rejecting the batch.

alter table public.study_reviews add column if not exists correct boolean;
alter table public.study_reviews add column if not exists build text;

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
     correct, build)
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
    -- A JSON true or false reads back as the text 'true' or 'false'. Anything else is null,
    -- so one odd value cannot throw and cost the whole batch.
    case e ->> 'ok' when 'true' then true when 'false' then false else null end,
    left(nullif(e ->> 'b', ''), 80)
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
