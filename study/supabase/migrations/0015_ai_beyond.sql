-- 0015_ai_beyond.sql
--
-- One more switch on a feature: may an answer go beyond the material. Ask answers only from the
-- material by design, which is right for a quiz but leaves the assistant unable to explain
-- anything the material does not happen to contain. The owner asked on 2026-09-17 for this to be
-- possible, off by default, owner controlled, with guard rails in the prompt.
--
--   * study_ai_features.beyond: false means the prompt keeps its "only from the material" rule.
--     true adds the rule that lets an answer use the model's own knowledge of the subject, marked
--     as outside the material, never contradicting it, never promising what is on the test.
--   * The switch lives on the server. The page cannot ask for it: ai_begin2 reads it and the
--     Edge Function builds the prompt from what ai_begin2 returns, so a forged request changes
--     nothing.
--   * It is per feature, so SAQ grading (which must stay inside the rubric) is unaffected.
--
-- Safe to run twice.

alter table public.study_ai_features add column if not exists beyond boolean not null default false;

-- ---------------------------------------------------------------- ai_begin2, now naming beyond
-- Unchanged except for the last line: the answer's permission travels with its budget.
create or replace function public.ai_begin2(p_feature text, p_material text, p_install text, p_ip text, p_token text, p_in int, p_out int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s          public.study_ai_settings%rowtype;
  f          public.study_ai_features%rowtype;
  m          public.study_ai_models%rowtype;
  v_material text := left(trim(coalesce(p_material, '')), 120);
  v_install  text := left(trim(coalesce(p_install, '')), 64);
  v_ip       text;
  v_reserve  bigint;
  v_spent    bigint;
  v_count    int;
  v_id       bigint;
begin
  v_ip := left(coalesce(nullif(trim(coalesce(p_ip, '')), ''), public._auth_ip()), 64);

  select * into s from public.study_ai_settings where id = 1;
  if not found or not s.enabled then
    return jsonb_build_object('ok', false, 'error', 'off');
  end if;

  select * into f from public.study_ai_features where id = left(trim(coalesce(p_feature, '')), 21);
  if not found or not f.enabled then
    return jsonb_build_object('ok', false, 'error', 'off');
  end if;

  if v_material = '' or not exists (
       select 1 from public.study_items i
        where i.id = v_material and f.tag = any (i.tags)
     ) then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end if;

  if f.mode = 'owner' and coalesce(public._auth_role(p_token), '') <> 'admin' then
    return jsonb_build_object('ok', false, 'error', 'owner_only');
  end if;

  select * into m from public.study_ai_models where id = f.model;
  if not found or not m.enabled then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  v_reserve := public._ai_cost(m.id, least(greatest(coalesce(p_in, 0), 500), 60000), least(greatest(coalesce(p_out, 0), 200), 4000));
  if v_reserve is null then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  perform pg_advisory_xact_lock(4801001);

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c where c.created_at >= public._ai_month_start();
  if v_spent + v_reserve > s.monthly_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'monthly_cap');
  end if;

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c where c.created_at >= public._ai_day_start();
  if v_spent + v_reserve > s.daily_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'daily_cap');
  end if;

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c where c.feature = f.id and c.created_at >= public._ai_day_start();
  if v_spent + v_reserve > f.daily_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'feature_cap');
  end if;

  if f.mode = 'open' then
    if length(v_install) < 8 then
      return jsonb_build_object('ok', false, 'error', 'bad_install');
    end if;
    select count(*) into v_count from public.study_ai_calls c
     where c.install = v_install and c.status in ('ok', 'pending') and c.created_at >= public._ai_day_start();
    if v_count >= s.per_install_daily then
      return jsonb_build_object('ok', false, 'error', 'device_cap');
    end if;
    select count(*) into v_count from public.study_ai_calls c
     where c.ip = v_ip and c.created_at > now() - interval '1 minute';
    if v_count >= s.per_ip_minute then
      return jsonb_build_object('ok', false, 'error', 'slow_down');
    end if;
  end if;

  insert into public.study_ai_calls (material, install, ip, model, status, cost_microcents, feature)
  values (v_material, nullif(v_install, ''), v_ip, m.id, 'pending', v_reserve, f.id)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort, 'beyond', f.beyond);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- the owner panel reads it
create or replace function public.admin_ai_features(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'name', f.name, 'enabled', f.enabled, 'mode', f.mode, 'model', f.model,
           'daily_cents', f.daily_cents, 'tag', f.tag, 'beta', f.beta, 'beyond', f.beyond, 'updated_at', f.updated_at,
           'today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                          where c.feature = f.id and c.created_at >= public._ai_day_start()), 0)::numeric / 1000000, 4),
           'month_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                          where c.feature = f.id and c.created_at >= public._ai_month_start()), 0)::numeric / 1000000, 4),
           'today_calls', (select count(*) from public.study_ai_calls c
                            where c.feature = f.id and c.created_at >= public._ai_day_start())
         ) order by f.id), '[]'::jsonb)
    into v_out
    from public.study_ai_features f;

  /* Unchanged from 0011: the SAQ grader has no row here, only its spend. */
  return jsonb_build_object('ok', true, 'features', v_out,
    'saq_today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                        where c.feature = 'saq' and c.created_at >= public._ai_day_start()), 0)::numeric / 1000000, 4),
    'saq_month_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                        where c.feature = 'saq' and c.created_at >= public._ai_month_start()), 0)::numeric / 1000000, 4));
end $$;

-- ---------------------------------------------------------------- and writes it
create or replace function public.admin_ai_feature_set(p_token text, p_feature jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role text;
  f      public.study_ai_features%rowtype;
  v_txt  text;
  r      record;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_feature is null or jsonb_typeof(p_feature) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_feature');
  end if;

  select * into f from public.study_ai_features where id = left(trim(coalesce(p_feature ->> 'id', '')), 21) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_feature ? 'enabled' then
    if jsonb_typeof(p_feature -> 'enabled') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'enabled');
    end if;
    f.enabled := (p_feature ->> 'enabled')::boolean;
  end if;

  if p_feature ? 'beyond' then
    if jsonb_typeof(p_feature -> 'beyond') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'beyond');
    end if;
    f.beyond := (p_feature ->> 'beyond')::boolean;
  end if;

  if p_feature ? 'mode' then
    v_txt := trim(coalesce(p_feature ->> 'mode', ''));
    if v_txt not in ('open', 'owner') then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'mode');
    end if;
    f.mode := v_txt;
  end if;

  if p_feature ? 'model' then
    v_txt := trim(coalesce(p_feature ->> 'model', ''));
    if not exists (select 1 from public.study_ai_models mm where mm.id = v_txt and mm.enabled) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'model');
    end if;
    f.model := v_txt;
  end if;

  select * into r from public._ai_int(p_feature, 'daily_cents');
  if r.v_found then
    if not r.v_ok or r.v_val < 0 or r.v_val > 10000 then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'daily_cents');
    end if;
    f.daily_cents := r.v_val;
  end if;

  update public.study_ai_features
     set enabled = f.enabled, mode = f.mode, model = f.model, daily_cents = f.daily_cents, beyond = f.beyond, updated_at = now()
   where id = f.id;

  select * into f from public.study_ai_features where id = f.id;
  return jsonb_build_object('ok', true, 'feature', to_jsonb(f));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;
