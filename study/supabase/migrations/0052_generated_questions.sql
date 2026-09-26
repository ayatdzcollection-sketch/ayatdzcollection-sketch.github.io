-- 0052: generated questions (Prompt 1, stage 7; the owner's decision of 2026-09-26, CLAUDE.md,
-- Paid APIs, item 4).
--
-- The Edge Function study-gen writes a few multiple choice questions for one section of a material
-- tagged ai-gen, grounded in that material's own passages and the textbook, each citing its page.
-- The function checks every question in code before it is kept (four distinct options, one key, a
-- misconception tag on every wrong option, the cited words found in the grounding text, no dashes,
-- not a copy of the bank) and stores the ones that pass here, through gen_insert (service role).
--
-- Who can do what:
--   anyone        gen_items(material): the live and promoted questions, so every person using the
--                 material practises the same shared set; gen_flag(id, install, reason): one flag
--                 per device per question. Two flags from two devices retire a question, and so
--                 does a key that looks broken (at least 12 answers from the review log, 85 per
--                 cent or more of them wrong). A promoted question is only ever retired by the
--                 owner.
--   the owner     admin_gen_list(token, material) with flags and answer counts, and
--                 admin_gen_set(token, id, status) to promote, retire or put back.
--   the function  gen_insert, service role only.
-- The feature row 'gen' has its own daily cap and is off by default. Nothing here calls a model.
-- Safe to run twice. No em dashes and no en dashes.

insert into public.study_ai_features (id, name, enabled, mode, model, daily_cents, tag, beta)
values ('gen', 'Generated questions', false, 'owner', 'claude-sonnet-4-6', 20, 'ai-gen', true)
on conflict (id) do nothing;

create table if not exists public.study_gen_items (
  id           bigserial   primary key,
  material     text        not null,
  sec          text        not null,
  ch           text,
  q            text        not null,
  o            jsonb       not null,                -- the four options, in the order written
  a            int         not null check (a between 0 and 3),
  why          text        not null,
  mis          jsonb       not null,                -- a misconception code per option, null at the key
  x            boolean     not null default false,  -- an EXCEPT question
  cite         jsonb       not null,                -- { label, page, quote }
  status       text        not null default 'live' check (status in ('live', 'promoted', 'retired')),
  retired_why  text,
  flags        int         not null default 0,
  call_id      bigint,
  made_at      timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists study_gen_items_material on public.study_gen_items (material, status);
alter table public.study_gen_items enable row level security;
revoke all on table public.study_gen_items from anon, authenticated;
revoke all on sequence public.study_gen_items_id_seq from anon, authenticated;

create table if not exists public.study_gen_flags (
  item_id  bigint      not null references public.study_gen_items (id) on delete cascade,
  install  text        not null,
  reason   text,
  at       timestamptz not null default now(),
  primary key (item_id, install)
);
alter table public.study_gen_flags enable row level security;
revoke all on table public.study_gen_flags from anon, authenticated;

-- Retire what the class shows to be broken: two flags, or a key most people miss. Never a promoted
-- question, which only the owner retires.
create or replace function public._gen_sweep(p_material text)
returns void
language sql
security definer
set search_path = pg_catalog, public, extensions
as $$
  update public.study_gen_items g
     set status = 'retired', updated_at = now(),
         retired_why = case when g.flags >= 2 then 'flagged twice' else 'most answers wrong: the key may be wrong' end
   where g.material = p_material and g.status = 'live'
     and (g.flags >= 2 or exists (
           select 1 from (select count(*) as n, avg(case when v.correct then 0 else 1 end) as miss
                            from public.study_reviews v
                           where v.material = g.material and v.card = 'g-' || g.id and v.correct is not null) s
            where s.n >= 12 and s.miss >= 0.85));
$$;
revoke all on function public._gen_sweep(text) from public;

create or replace function public.gen_items(p_material text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_m text := left(coalesce(p_material, ''), 120);
begin
  perform public._gen_sweep(v_m);
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('id', g.id, 'sec', g.sec, 'ch', g.ch, 'q', g.q, 'o', g.o, 'a', g.a, 'why', g.why,
                                        'mis', g.mis, 'x', g.x, 'cite', g.cite, 'status', g.status) order by g.id)
      from (select * from public.study_gen_items where material = v_m and status in ('live', 'promoted') order by id desc limit 200) g), '[]'::jsonb));
end $$;
revoke all on function public.gen_items(text) from public;
grant execute on function public.gen_items(text) to anon;

create or replace function public.gen_flag(p_id bigint, p_install text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_install text := left(trim(coalesce(p_install, '')), 64); v_m text; v_n int;
begin
  if v_install = '' or v_install !~ '^[A-Za-z0-9_-]{8,64}$' then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select material into v_m from public.study_gen_items where id = p_id;
  if v_m is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  insert into public.study_gen_flags (item_id, install, reason) values (p_id, v_install, left(coalesce(p_reason, ''), 200))
    on conflict (item_id, install) do nothing;
  select count(*) into v_n from public.study_gen_flags where item_id = p_id;
  update public.study_gen_items set flags = v_n, updated_at = now() where id = p_id;
  perform public._gen_sweep(v_m);
  return jsonb_build_object('ok', true, 'flags', v_n);
end $$;
revoke all on function public.gen_flag(bigint, text, text) from public;
grant execute on function public.gen_flag(bigint, text, text) to anon;

-- The function's insert. It has already checked every item; this checks the shape again.
create or replace function public.gen_insert(p_material text, p_sec text, p_ch text, p_items jsonb, p_call bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare r jsonb; v_ids bigint[] := '{}'; v_id bigint;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 6 then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  for r in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(r -> 'o') <> 'array' or jsonb_array_length(r -> 'o') <> 4 or jsonb_typeof(r -> 'mis') <> 'array'
       or coalesce(r ->> 'q', '') = '' or (r ->> 'a')::int not between 0 and 3 then continue; end if;
    insert into public.study_gen_items (material, sec, ch, q, o, a, why, mis, x, cite, call_id)
    values (left(p_material, 120), left(p_sec, 80), left(p_ch, 10), left(r ->> 'q', 600), r -> 'o', (r ->> 'a')::int,
            left(coalesce(r ->> 'why', ''), 800), r -> 'mis', coalesce((r ->> 'x')::boolean, false), coalesce(r -> 'cite', '{}'::jsonb), p_call)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;
  return jsonb_build_object('ok', true, 'ids', to_jsonb(v_ids));
end $$;
revoke all on function public.gen_insert(text, text, text, jsonb, bigint) from public;
grant execute on function public.gen_insert(text, text, text, jsonb, bigint) to service_role;

create or replace function public.admin_gen_list(p_token text, p_material text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  perform public._gen_sweep(p_material);
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('id', g.id, 'sec', g.sec, 'ch', g.ch, 'q', g.q, 'o', g.o, 'a', g.a, 'why', g.why, 'cite', g.cite,
             'status', g.status, 'retired_why', g.retired_why, 'flags', g.flags, 'made_at', g.made_at,
             'reasons', (select coalesce(jsonb_agg(f.reason) filter (where coalesce(f.reason, '') <> ''), '[]'::jsonb) from public.study_gen_flags f where f.item_id = g.id),
             'n', (select count(*) from public.study_reviews v where v.material = g.material and v.card = 'g-' || g.id and v.correct is not null),
             'miss', (select round(avg(case when v.correct then 0 else 1 end)::numeric, 3) from public.study_reviews v where v.material = g.material and v.card = 'g-' || g.id and v.correct is not null))
           order by g.id desc)
      from public.study_gen_items g where g.material = p_material), '[]'::jsonb));
end $$;
revoke all on function public.admin_gen_list(text, text) from public;
grant execute on function public.admin_gen_list(text, text) to anon;

create or replace function public.admin_gen_set(p_token text, p_id bigint, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status not in ('live', 'promoted', 'retired') then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  update public.study_gen_items set status = p_status, updated_at = now(),
         retired_why = case when p_status = 'retired' then 'retired by the owner' else null end,
         flags = case when p_status = 'live' then 0 else flags end
   where id = p_id;
  if p_status = 'live' then delete from public.study_gen_flags where item_id = p_id; end if;
  return jsonb_build_object('ok', found);
end $$;
revoke all on function public.admin_gen_set(text, bigint, text) from public;
grant execute on function public.admin_gen_set(text, bigint, text) to anon;
