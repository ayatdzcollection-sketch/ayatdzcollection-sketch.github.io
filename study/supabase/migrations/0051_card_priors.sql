-- 0051: what the class finds hard (Prompt 1, stage 6).
--
-- card_priors: for a new person, a card's starting difficulty comes from the class wide miss rate
-- instead of the default, once enough anonymous review data exists: at least 20 answers from at
-- least 5 people. People, not installs: devices that shared a person id (the synced hub:person)
-- count once, and a device with no person id counts as its own person. Only the anonymous review
-- log feeds it (it respects everyone's telemetry switch, since a device with the switch off sends
-- nothing), the owner's devices and local test pages are left out, and a card below the
-- thresholds is not returned at all, so no answer from one person alone is ever visible.
--
-- admin_hardest: the owner's view of the cards and question kinds most missed across everyone.
-- Totals only; no install id, person id or time of day leaves the database.
-- Safe to run twice.

create or replace function public.card_priors(p_material text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
  with dev as (
    select install, coalesce(persons[1], install) as who,
           coalesce((profile ->> 'owner')::boolean, false) as owner,
           coalesce((profile ->> 'local')::boolean, false) as local
      from public.study_devices
  ), r as (
    select v.card, coalesce(d.who, v.install) as who, v.correct, v.grade
      from public.study_reviews v left join dev d on d.install = v.install
     where v.material = p_material and coalesce(d.owner, false) = false and coalesce(d.local, false) = false
  ), agg as (
    select card, count(*) as n, count(distinct who) as people,
           avg(case when correct is not null then (not correct)::int when grade is not null then (grade = 1)::int end) as miss
      from r group by card
  )
  select jsonb_build_object('ok', true, 'min_n', 20, 'min_people', 5,
    'cards', coalesce(jsonb_object_agg(card, jsonb_build_object('n', n, 'miss', round(miss::numeric, 3))) filter (where n >= 20 and people >= 5 and miss is not null), '{}'::jsonb))
    from agg;
$$;
revoke all on function public.card_priors(text) from public;
grant execute on function public.card_priors(text) to anon;

create or replace function public.admin_hardest(p_token text, p_material text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_out jsonb;
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  with dev as (
    select install, coalesce(persons[1], install) as who, coalesce((profile ->> 'local')::boolean, false) as local from public.study_devices
  ), r as (
    select v.card, v.step, v.chosen, coalesce(d.who, v.install) as who,
           case when v.correct is not null then (not v.correct)::int else (v.grade = 1)::int end as missed
      from public.study_reviews v left join dev d on d.install = v.install
     where v.material = p_material and coalesce(d.local, false) = false
  )
  select jsonb_build_object('ok', true,
    'cards', coalesce((select jsonb_agg(x order by (x ->> 'miss')::numeric desc, (x ->> 'n')::int desc) from (
        select jsonb_build_object('card', card, 'n', count(*), 'people', count(distinct who), 'miss', round(avg(missed)::numeric, 3),
                                  'top_wrong', mode() within group (order by chosen)) as x
          from r group by card having count(*) >= 5 order by avg(missed) desc limit 40) t), '[]'::jsonb),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('step', step, 'n', n, 'miss', miss) order by miss desc) from (
        select coalesce(step, 'none') as step, count(*) as n, round(avg(missed)::numeric, 3) as miss from r group by 1 having count(*) >= 10) s), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function public.admin_hardest(text, text) from public;
grant execute on function public.admin_hardest(text, text) to anon;
