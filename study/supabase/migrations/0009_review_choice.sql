-- Which wrong option was picked, so a miss says more than "again".
--
-- Run this in the Supabase dashboard SQL editor after 0004 (and the rest). Until it runs,
-- clients keep sending the field and the ingest ignores it; nothing breaks.
--
-- Every material already keeps the count locally (c.w on the card record) so a card can say
-- "you keep picking ...". Sending the index lets the same thing be measured across devices
-- and lets a distractor that fools everybody be found and rewritten. It is the index of an
-- option in the question's own list, never the text of anything typed.

alter table public.study_reviews add column if not exists chosen smallint;

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
     answer_ms, days_since, stability, difficulty, retrievability, reps, lapses, chosen)
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
    nullif(e ->> 'w',  '')::smallint
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
