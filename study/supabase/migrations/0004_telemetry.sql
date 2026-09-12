-- Anonymous review logs, so the scheduler can be measured against reality.
--
-- Run this in the Supabase dashboard SQL editor, same as the earlier migrations. Until it
-- is run, clients queue events locally, get one 404 per page load, and stop trying for
-- that load. Nothing breaks and nothing is lost; they start sending once this exists.
--
-- What this is for
--   An FSRS optimiser needs pairs of (what the model predicted, what actually happened).
--   Every row here is one review: the model's stability, difficulty and predicted
--   retrievability at the moment the question was asked, and the grade that came back.
--   With enough of those you can measure calibration and refit the weights.
--
-- What is deliberately NOT here
--   No name, no code, no session token, no email, and no IP address. The client sends a
--   random per-device install id and nothing else that could identify anybody. The card
--   key is the QUESTION ("Na|n2s", "Ohio"), never the answer somebody typed.
--
-- Security model, unchanged from the other tables
--   RLS on with no policies, so the anon key cannot read or write it through PostgREST.
--   The one entry point is a SECURITY DEFINER function that only ever inserts.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.study_reviews (
  id          bigserial primary key,
  install     text        not null,          -- random per device, not per person
  material    text        not null,          -- 'chem/periodic-table'
  card        text        not null,          -- 'Na|n2s': the question, never the answer
  scheduler   text,                          -- 'fsrs6' | 'fsrs5'
  step        text,                          -- recall | mc | test | speed | match | locate
  reviewed_at timestamptz not null,
  grade       smallint    not null,          -- 1 again, 2 hard, 3 good, 4 easy
  answer_ms   integer,                       -- how long the answer took
  days_since  real,                          -- since the previous review, null if first
  stability   real,                          -- model state BEFORE this review
  difficulty  real,
  retrievability real,                       -- what the model predicted, the key signal
  reps        integer,
  lapses      integer,
  received_at timestamptz not null default now()
);
alter table public.study_reviews enable row level security;
revoke all on public.study_reviews from anon, authenticated;
revoke all on sequence public.study_reviews_id_seq from anon, authenticated;

-- A device that resends a batch after a dropped response must not double-count it.
create unique index if not exists study_reviews_dedupe
  on public.study_reviews (install, material, card, reviewed_at);

create index if not exists study_reviews_material_at
  on public.study_reviews (material, reviewed_at);

-- ---------------------------------------------------------------- ingest

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
  -- The client batches 200. Anything far above that is not this client.
  if v_count > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  insert into public.study_reviews
    (install, material, card, scheduler, step, reviewed_at, grade,
     answer_ms, days_since, stability, difficulty, retrievability, reps, lapses)
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
    nullif(e ->> 'l',  '')::int
  from jsonb_array_elements(p_events) as e
  where e ->> 'm' is not null
    and e ->> 'c' is not null
    and e ->> 't' is not null
    and e ->> 'g' is not null
    -- A clock that is wildly wrong would poison any analysis more than a missing row does.
    and to_timestamp(((e ->> 't')::numeric) / 1000)
        between now() - interval '2 years' and now() + interval '1 day'
  on conflict (install, material, card, reviewed_at) do nothing;

  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'stored', v_count);
exception when others then
  -- A malformed batch is the client's problem to fix, not a reason to fail the study
  -- session. Report it and move on rather than raising.
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.telemetry_ingest(text, jsonb) from public;
grant execute on function public.telemetry_ingest(text, jsonb) to anon;
