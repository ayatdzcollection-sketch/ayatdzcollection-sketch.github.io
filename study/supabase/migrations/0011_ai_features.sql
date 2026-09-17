-- 0011_ai_features.sql
--
-- A second AI feature, and a place to put the third. 0010 built one feature, SAQ grading,
-- with one settings row. This adds a small features table so each AI feature has its own
-- switch, mode, model and daily cap, while 0010's settings row stays what it is: the master
-- switch and the global daily and monthly ceilings that every feature spends against.
--
-- The first row is 'ask': ask about the material, from a highlight or a chat, in a
-- material that carries the 'ai-ask' tag. It starts off and owner only.
--
-- Rules carried over from 0010 and 0006:
--   * ai_begin2 is callable only by the service role, so only the Edge Function can open a
--     ledger row. The anon surface is ai_status2 and the token guarded admin RPCs.
--   * Every admin RPC opens with coalesce(v_role, '') <> 'admin', the 0006 lesson: a null
--     role from a bad token must fail closed.
--   * The global caps are checked against every ledger row of every feature, under the same
--     advisory lock ai_begin takes, so two features calling together cannot overshoot.
--   * No student or owner text is ever stored. The ledger keeps tokens, cost and timing.
--
-- Safe to run twice.

alter table public.study_ai_calls add column if not exists feature text not null default 'saq';
create index if not exists study_ai_calls_feature_created on public.study_ai_calls (feature, created_at);

create table if not exists public.study_ai_features (
  id          text primary key check (id ~ '^[a-z][a-z0-9_]{1,20}$'),
  name        text not null,
  enabled     boolean not null default false,
  mode        text not null default 'owner' check (mode in ('open', 'owner')),
  model       text not null default 'claude-sonnet-4-6',
  daily_cents int  not null default 30 check (daily_cents between 0 and 10000),
  tag         text not null check (tag ~ '^[a-z][a-z0-9-]{1,30}$'),
  beta        boolean not null default true,
  updated_at  timestamptz not null default now()
);
alter table public.study_ai_features enable row level security;
revoke all on table public.study_ai_features from anon, authenticated;

insert into public.study_ai_features (id, name, enabled, mode, model, daily_cents, tag, beta)
values ('ask', 'Ask about the material', false, 'owner', 'claude-sonnet-4-6', 30, 'ai-ask', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- ai_begin2
-- Opens a ledger row for one call of one feature. The reserve is sized by the caller from
-- what it is about to send (clipped here to sane bounds), so a short question does not
-- hold a large reserve and a long one cannot hide behind a small one.
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

  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- ai_status2
-- What a material asks before it draws anything for a feature. Thin on purpose.
create or replace function public.ai_status2(p_material text, p_feature text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s        public.study_ai_settings%rowtype;
  f        public.study_ai_features%rowtype;
  v_tagged boolean := false;
begin
  select * into s from public.study_ai_settings where id = 1;
  select * into f from public.study_ai_features where id = left(trim(coalesce(p_feature, '')), 21);
  if f.id is null then
    return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'tagged', false, 'available', false, 'beta', true);
  end if;
  select exists (select 1 from public.study_items i
                  where i.id = left(trim(coalesce(p_material, '')), 120) and f.tag = any (i.tags)) into v_tagged;
  return jsonb_build_object(
    'ok', true,
    'enabled', coalesce(s.enabled, false) and f.enabled,
    'mode', f.mode,
    'tagged', v_tagged,
    'available', coalesce(s.enabled, false) and f.enabled and v_tagged,
    'beta', f.beta
  );
exception when others then
  return jsonb_build_object('ok', true, 'enabled', false, 'mode', 'owner', 'tagged', false, 'available', false, 'beta', true);
end $$;

-- ---------------------------------------------------------------- owner panel
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
           'daily_cents', f.daily_cents, 'tag', f.tag, 'beta', f.beta, 'updated_at', f.updated_at,
           'today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                          where c.feature = f.id and c.created_at >= public._ai_day_start()), 0)::numeric / 1000000, 4),
           'month_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                          where c.feature = f.id and c.created_at >= public._ai_month_start()), 0)::numeric / 1000000, 4),
           'today_calls', (select count(*) from public.study_ai_calls c
                            where c.feature = f.id and c.created_at >= public._ai_day_start())
         ) order by f.id), '[]'::jsonb)
    into v_out
    from public.study_ai_features f;

  /* 'saq' is the 0010 feature. It has no row here because its switch, mode and model live in
     study_ai_settings; the panel shows it from admin_ai_settings. Its spend is reported here
     so the panel can put every feature's numbers side by side. */
  return jsonb_build_object('ok', true, 'features', v_out,
    'saq_today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                        where c.feature = 'saq' and c.created_at >= public._ai_day_start()), 0)::numeric / 1000000, 4),
    'saq_month_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                        where c.feature = 'saq' and c.created_at >= public._ai_month_start()), 0)::numeric / 1000000, 4));
end $$;

-- Applies only the keys the patch carries. id is required and must name an existing row.
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
     set enabled = f.enabled, mode = f.mode, model = f.model, daily_cents = f.daily_cents, updated_at = now()
   where id = f.id;

  select * into f from public.study_ai_features where id = f.id;
  return jsonb_build_object('ok', true, 'feature', to_jsonb(f));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.ai_begin2(text, text, text, text, text, int, int) from public, anon, authenticated;
revoke all on function public.ai_status2(text, text)                           from public;
revoke all on function public.admin_ai_features(text)                          from public;
revoke all on function public.admin_ai_feature_set(text, jsonb)                from public;

grant execute on function public.ai_begin2(text, text, text, text, text, int, int) to service_role;
grant execute on function public.ai_status2(text, text)                           to anon;
grant execute on function public.admin_ai_features(text)                          to anon;
grant execute on function public.admin_ai_feature_set(text, jsonb)                to anon;


-- ---------------------------------------------------------------- usage, with the feature
-- The same readout as 0010, now naming which feature each recent call belonged to.
create or replace function public.admin_ai_usage(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role     text;
  v_day      timestamptz := public._ai_day_start();
  v_month    timestamptz := public._ai_month_start();
  v_today    bigint;
  v_month_mc bigint;
  v_today_n  int;
  v_month_n  int;
  v_last     timestamptz;
  v_status   jsonb;
  v_models   jsonb;
  v_recent   jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(sum(cost_microcents), 0), count(*)
    into v_today, v_today_n
    from public.study_ai_calls
   where created_at >= v_day;

  select coalesce(sum(cost_microcents), 0), count(*)
    into v_month_mc, v_month_n
    from public.study_ai_calls
   where created_at >= v_month;

  select max(created_at) into v_last
    from public.study_ai_calls where status = 'ok';

  select coalesce(jsonb_object_agg(t.status, t.n), '{}'::jsonb) into v_status
    from (select status, count(*) as n
            from public.study_ai_calls
           where created_at >= v_month
           group by status) t;

  select coalesce(jsonb_object_agg(t.model, t.n), '{}'::jsonb) into v_models
    from (select coalesce(model, 'unknown') as model, count(*) as n
            from public.study_ai_calls
           where created_at >= v_month
           group by 1) t;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) into v_recent
    from (select id, created_at, material, feature, model, status,
                 input_tokens, output_tokens, cost_microcents, latency_ms
            from public.study_ai_calls
           order by created_at desc
           limit 20) t;

  return jsonb_build_object(
    'ok', true,
    'today_cents', round(v_today::numeric    / 1000000, 4),
    'month_cents', round(v_month_mc::numeric / 1000000, 4),
    'today_calls', v_today_n,
    'month_calls', v_month_n,
    'last_ok_at', v_last,
    'by_status', v_status,
    'by_model', v_models,
    'recent', v_recent
  );
end $$;
