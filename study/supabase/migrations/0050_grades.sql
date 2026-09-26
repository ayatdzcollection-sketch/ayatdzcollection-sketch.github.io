-- 0050: the owner's grades, for APUSH daily's grade line and its calibration (Prompt 1, stage 5).
--
-- The owner's decision, 2026-09-26: after each StudentVue sync the school connector (connector/,
-- private) upserts the class's scored items (title, date, score, max, category) and the category
-- weights into this owner only table. Grades never go in the repo or in a material's source.
--
-- Who can do what:
--   the connector    grades_ingest(p_key, ...): a write only key whose SHA-256 is stored here
--                    (study_grade_keys), set by the owner with admin_grade_key. The key lives only
--                    in connector/.env. It can write the APUSH rows and nothing else: it cannot read.
--   the owner        admin_grades(p_token, p_course): reads them, with the owner's session token.
--   anyone else      nothing. Row level security is on with no policies and every grant revoked,
--                    so the anon key can neither read nor write the tables.
-- Safe to run twice.

create table if not exists public.study_grades (
  course      text        not null,
  ext_id      text        not null,              -- StudentVue's own id for the row
  title       text        not null,
  due         date,
  score       numeric,
  max_score   numeric,
  category    text,
  status      text,                              -- GRADED, MISSING, EXCUSED, PENDING
  updated_at  timestamptz not null default now(),
  primary key (course, ext_id)
);
alter table public.study_grades enable row level security;
revoke all on public.study_grades from anon, authenticated;

create table if not exists public.study_grade_categories (
  course      text        not null,
  name        text        not null,
  weight      numeric,
  updated_at  timestamptz not null default now(),
  primary key (course, name)
);
alter table public.study_grade_categories enable row level security;
revoke all on public.study_grade_categories from anon, authenticated;

create table if not exists public.study_grade_keys (
  id          int         primary key default 1 check (id = 1),
  key_hash    text        not null,
  set_at      timestamptz not null default now()
);
alter table public.study_grade_keys enable row level security;
revoke all on public.study_grade_keys from anon, authenticated;

-- The owner sets (or replaces) the connector's key. Only its hash is kept.
create or replace function public.admin_grade_key(p_token text, p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok', false, 'error', 'bad_hash'); end if;
  insert into public.study_grade_keys (id, key_hash, set_at) values (1, p_key_hash, now())
    on conflict (id) do update set key_hash = excluded.key_hash, set_at = now();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.admin_grade_key(text, text) from public;
grant execute on function public.admin_grade_key(text, text) to anon;

-- The connector's upsert: one course (APUSH only for now), at most 400 rows and 12 categories.
create or replace function public.grades_ingest(p_key text, p_course text, p_rows jsonb, p_categories jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_hash text; v_n int := 0; r jsonb;
begin
  if p_key is null or length(p_key) < 32 then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select key_hash into v_hash from public.study_grade_keys where id = 1;
  if v_hash is null or v_hash <> encode(digest(p_key, 'sha256'), 'hex') then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if coalesce(p_course, '') <> 'apush' then return jsonb_build_object('ok', false, 'error', 'course'); end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 400 then return jsonb_build_object('ok', false, 'error', 'rows'); end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r ->> 'ext_id', '') = '' or coalesce(r ->> 'title', '') = '' then continue; end if;
    insert into public.study_grades (course, ext_id, title, due, score, max_score, category, status, updated_at)
    values (p_course, left(r ->> 'ext_id', 80), left(r ->> 'title', 200), nullif(r ->> 'due', '')::date,
            nullif(r ->> 'score', '')::numeric, nullif(r ->> 'max', '')::numeric, left(r ->> 'category', 80), left(r ->> 'status', 20), now())
    on conflict (course, ext_id) do update set title = excluded.title, due = excluded.due, score = excluded.score,
      max_score = excluded.max_score, category = excluded.category, status = excluded.status, updated_at = now();
    v_n := v_n + 1;
  end loop;
  if jsonb_typeof(p_categories) = 'array' and jsonb_array_length(p_categories) <= 12 then
    for r in select * from jsonb_array_elements(p_categories) loop
      if coalesce(r ->> 'name', '') = '' then continue; end if;
      insert into public.study_grade_categories (course, name, weight, updated_at)
      values (p_course, left(r ->> 'name', 80), nullif(r ->> 'weight', '')::numeric, now())
      on conflict (course, name) do update set weight = excluded.weight, updated_at = now();
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'rows', v_n);
end $$;
revoke all on function public.grades_ingest(text, text, jsonb, jsonb) from public;
grant execute on function public.grades_ingest(text, text, jsonb, jsonb) to anon;

-- The owner's read.
create or replace function public.admin_grades(p_token text, p_course text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  return jsonb_build_object('ok', true,
    'rows', coalesce((select jsonb_agg(jsonb_build_object('ext_id', ext_id, 'title', title, 'due', due, 'score', score, 'max', max_score,
                        'category', category, 'status', status, 'updated_at', updated_at) order by due, title)
                      from public.study_grades where course = p_course), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'weight', weight)) from public.study_grade_categories where course = p_course), '[]'::jsonb),
    'synced_at', (select max(updated_at) from public.study_grades where course = p_course));
end $$;
revoke all on function public.admin_grades(text, text) from public;
grant execute on function public.admin_grades(text, text) to anon;
