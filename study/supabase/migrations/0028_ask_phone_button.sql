-- 0028_ask_phone_button.sql
--
-- The corner Ask button, on phones only, and only when the owner says so. The owner decided on
-- 2026-09-17 that no Ask button sits on the screen for anyone, owner or code holder: on a
-- computer the ways in are highlighting text and the keys. On a phone there are no keys, so the
-- owner may switch a button on for phones, and it shows only to someone the server says may use
-- Ask (the owner, a live code that carries it, or anyone while Ask is open).
--
--   * phone_button on study_ai_features, off by default. It is a display switch and grants
--     nothing: every call is still checked by ai_begin2 as before.
--   * ai_status2 (0017's three argument form) returns it beside the rest, unchanged otherwise.
--   * admin_ai_feature_set accepts it as a boolean; admin_ai_features lists it (the 0026 body
--     otherwise).
--
-- Safe to run twice.

alter table public.study_ai_features add column if not exists phone_button boolean not null default false;

create or replace function public.ai_status2(p_material text, p_feature text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s public.study_ai_settings%rowtype;
  f public.study_ai_features%rowtype;
  p public.study_ai_passes;
  v_tagged boolean := false; v_role text; v_left bigint; v_out jsonb;
begin
  select * into s from public.study_ai_settings where id = 1;
  select * into f from public.study_ai_features where id = left(trim(coalesce(p_feature, '')), 21);
  if f.id is null then
    return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'tagged', false,
                              'available', false, 'beta', true, 'may', false, 'why', 'unavailable');
  end if;
  select exists (select 1 from public.study_items i
                  where i.id = left(trim(coalesce(p_material, '')), 120) and f.tag = any (i.tags)) into v_tagged;

  v_out := jsonb_build_object(
    'ok', true,
    'enabled', coalesce(s.enabled, false) and f.enabled,
    'mode', f.mode,
    'tagged', v_tagged,
    'available', coalesce(s.enabled, false) and f.enabled and v_tagged,
    'beta', f.beta,
    'phone_button', coalesce(f.phone_button, false));

  if not (coalesce(s.enabled, false) and f.enabled) then
    return v_out || jsonb_build_object('may', false, 'why', 'off');
  end if;
  if not v_tagged then
    return v_out || jsonb_build_object('may', false, 'why', 'unavailable');
  end if;

  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') = 'admin' then
    return v_out || jsonb_build_object('may', true, 'why', 'owner');
  end if;

  p := public._auth_pass(p_token);
  if p.id is not null and public._ai_pass_may(p, f.id) then
    v_left := p.budget_microcents - public._ai_pass_spent(p.id);
    return v_out || jsonb_build_object('may', v_left > 0, 'why', case when v_left > 0 then 'pass' else 'pass_spent' end,
      'pass', jsonb_build_object('label', p.label, 'expires_at', p.expires_at,
        'left_cents', round(greatest(v_left, 0)::numeric / 1000000, 2)));
  end if;

  if f.mode = 'open' then
    return v_out || jsonb_build_object('may', true, 'why', 'open');
  end if;
  if p.id is not null then
    return v_out || jsonb_build_object('may', false, 'why', 'pass_feature');
  end if;
  p := public._auth_pass_any(p_token);
  if p.id is not null then
    return v_out || jsonb_build_object('may', false, 'why', 'pass_expired',
      'pass', jsonb_build_object('label', p.label, 'expires_at', p.expires_at, 'left_cents', 0));
  end if;
  return v_out || jsonb_build_object('may', false, 'why', 'owner_only');
exception when others then
  return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'tagged', false,
                            'available', false, 'beta', true, 'may', false, 'why', 'rejected');
end $$;

create or replace function public.admin_ai_features(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_out jsonb; v_day timestamptz := public._ai_day_start(); v_month timestamptz := public._ai_month_start();
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', f.id, 'name', f.name, 'enabled', f.enabled, 'mode', f.mode, 'model', f.model,
           'daily_cents', f.daily_cents, 'tag', f.tag, 'beta', f.beta, 'beyond', f.beyond, 'phone_button', f.phone_button, 'updated_at', f.updated_at,
           'bonus_cents', case when f.bonus_at is not null and f.bonus_at >= v_day then f.bonus_cents else 0 end,
           'today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                          where c.feature = f.id and c.created_at >= v_day and c.pass_id is null), 0)::numeric / 1000000, 4),
           'month_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                          where c.feature = f.id and c.created_at >= v_month and c.pass_id is null), 0)::numeric / 1000000, 4),
           'today_calls', (select count(*) from public.study_ai_calls c
                            where c.feature = f.id and c.created_at >= v_day and c.pass_id is null),
           'codes_today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                                where c.feature = f.id and c.created_at >= v_day and c.pass_id is not null), 0)::numeric / 1000000, 4),
           'codes_month_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                                where c.feature = f.id and c.created_at >= v_month and c.pass_id is not null), 0)::numeric / 1000000, 4),
           'codes_today_calls', (select count(*) from public.study_ai_calls c
                                  where c.feature = f.id and c.created_at >= v_day and c.pass_id is not null)
         ) order by f.id), '[]'::jsonb)
    into v_out
    from public.study_ai_features f;

  /* Unchanged from 0011: the SAQ grader has no row here, only its spend. */
  return jsonb_build_object('ok', true, 'features', v_out,
    'saq_today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                        where c.feature = 'saq' and c.created_at >= v_day), 0)::numeric / 1000000, 4),
    'saq_month_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                        where c.feature = 'saq' and c.created_at >= v_month), 0)::numeric / 1000000, 4));
end $$;

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

  if p_feature ? 'phone_button' then
    if jsonb_typeof(p_feature -> 'phone_button') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'phone_button');
    end if;
    f.phone_button := (p_feature ->> 'phone_button')::boolean;
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
     set enabled = f.enabled, mode = f.mode, model = f.model, daily_cents = f.daily_cents, beyond = f.beyond, phone_button = f.phone_button, updated_at = now()
   where id = f.id;

  select * into f from public.study_ai_features where id = f.id;
  return jsonb_build_object('ok', true, 'feature', to_jsonb(f));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.ai_status2(text, text, text)          from public;
revoke all on function public.admin_ai_features(text)               from public;
revoke all on function public.admin_ai_feature_set(text, jsonb)     from public;
grant execute on function public.ai_status2(text, text, text)       to anon;
grant execute on function public.admin_ai_features(text)            to anon;
grant execute on function public.admin_ai_feature_set(text, jsonb)  to anon;

notify pgrst, 'reload schema';
