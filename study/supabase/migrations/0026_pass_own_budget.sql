-- 0026_pass_own_budget.sql
--
-- A code pays from its own money, not from the owner's caps. Until now every call on an access
-- code (0017) was checked against the owner's monthly cap, the global daily cap and the
-- feature's daily cap before the code's own budget, so a friend holding a code with money left
-- could be refused because the owner, or another code, had used the day's allowance. The owner
-- asked on 2026-09-17 that a code holder is never cut off under their own limit, and that their
-- spending shows.
--
--   * ai_begin2: a call on a live code skips the monthly, daily and feature caps. What bounds it
--     is what the owner set on the code: the money loaded, its daily cap and its per minute
--     limit, all still checked under the same lock. The owner's master switch and the feature's
--     own switch still stop every call, codes included.
--   * The owner's caps now count only calls that were not made on a code (pass_id is null), so
--     a friend's use never eats the owner's own allowance either. pass_id is never cleared, even
--     when a code is deleted (0017 has no foreign key), so a deleted code's past spend stays
--     outside the caps rather than landing on the owner's day.
--   * ai_begin, the SAQ grader's gate (0010), gets the same rule for its caps.
--   * who on every new ledger row: 'owner', 'pass' or 'open'. The Calls list prints it, so a
--     row reads as yours, a code's (with its label) or a visitor's. Older rows have none.
--   * admin_ai_usage and admin_ai_features report the two apart: today_cents, month_cents and the
--     call counts are what the caps compare against; codes_* is what codes spent, from their own
--     money; all_* is the two together.
--
-- Safe to run twice.

alter table public.study_ai_calls add column if not exists who text;

update public.study_ai_calls set who = 'pass' where pass_id is not null and who is null;

create or replace function public.ai_begin2(p_feature text, p_material text, p_install text, p_ip text,
                                            p_token text, p_in integer, p_out integer)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s          public.study_ai_settings%rowtype;
  f          public.study_ai_features%rowtype;
  m          public.study_ai_models%rowtype;
  pass       public.study_ai_passes;
  v_material text := left(trim(coalesce(p_material, '')), 120);
  v_install  text := left(trim(coalesce(p_install, '')), 64);
  v_ip       text;
  v_role     text;
  v_owner    boolean := false;
  v_book     boolean := false;
  v_pass_id  bigint;
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

  v_role := public._auth_role(p_token);
  v_owner := coalesce(v_role, '') = 'admin';
  v_book := v_owner;
  if not v_owner then
    pass := public._auth_pass(p_token);
    if pass.id is not null and public._ai_pass_may(pass, f.id) then
      v_pass_id := pass.id;
      v_book := public._ai_pass_may(pass, 'textbook');
    elsif f.mode = 'owner' then
      if pass.id is not null then return jsonb_build_object('ok', false, 'error', 'pass_feature'); end if;
      pass := public._auth_pass_any(p_token);
      return jsonb_build_object('ok', false, 'error', case when pass.id is not null then 'pass_expired' else 'owner_only' end);
    end if;
  end if;

  select * into m from public.study_ai_models where id = f.model;
  if not found or not m.enabled then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  v_reserve := public._ai_cost(m.id, least(greatest(coalesce(p_in, 0), 3000), 60000), least(greatest(coalesce(p_out, 0), 200), 4000));
  if v_reserve is null then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  perform pg_advisory_xact_lock(4801001);

  if v_pass_id is null then
    /* The owner's caps, over the calls that were not made on a code. */
    select coalesce(sum(c.cost_microcents), 0) into v_spent
      from public.study_ai_calls c where c.created_at >= public._ai_month_start() and c.pass_id is null;
    if v_spent + v_reserve > s.monthly_cents::bigint * 1000000 then
      return jsonb_build_object('ok', false, 'error', 'monthly_cap');
    end if;

    select coalesce(sum(c.cost_microcents), 0) into v_spent
      from public.study_ai_calls c where c.created_at >= public._ai_day_start() and c.pass_id is null;
    if v_spent + v_reserve > public._ai_day_cap(s.daily_cents, s.bonus_cents, s.bonus_at) * 1000000 then
      return jsonb_build_object('ok', false, 'error', 'daily_cap');
    end if;

    select coalesce(sum(c.cost_microcents), 0) into v_spent
      from public.study_ai_calls c
     where c.feature = f.id and c.created_at >= public._ai_day_start() and c.pass_id is null;
    if v_spent + v_reserve > public._ai_day_cap(f.daily_cents, f.bonus_cents, f.bonus_at) * 1000000 then
      return jsonb_build_object('ok', false, 'error', 'feature_cap');
    end if;
  end if;

  if v_pass_id is not null then
    /* The code's own limits, read again under the lock. */
    select * into pass from public.study_ai_passes where id = v_pass_id;
    if not found or not public._ai_pass_live(pass) or not public._ai_pass_may(pass, f.id) then
      return jsonb_build_object('ok', false, 'error', case when found and public._ai_pass_live(pass) then 'pass_feature' else 'pass_expired' end);
    end if;
    if public._ai_pass_spent(pass.id) + v_reserve > pass.budget_microcents then
      return jsonb_build_object('ok', false, 'error', 'pass_spent');
    end if;
    if pass.daily_cents is not null then
      select coalesce(sum(c.cost_microcents), 0) into v_spent
        from public.study_ai_calls c where c.pass_id = pass.id and c.created_at >= public._ai_day_start();
      if v_spent + v_reserve > pass.daily_cents::bigint * 1000000 then
        return jsonb_build_object('ok', false, 'error', 'pass_day');
      end if;
    end if;
    select count(*) into v_count from public.study_ai_calls c
     where c.pass_id = pass.id and c.created_at > now() - interval '1 minute';
    if v_count >= pass.per_minute then
      return jsonb_build_object('ok', false, 'error', 'slow_down');
    end if;
  elsif not v_owner and f.mode = 'open' then
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

  insert into public.study_ai_calls (material, install, ip, model, status, cost_microcents, feature, pass_id, who)
  values (v_material, nullif(v_install, ''), v_ip, m.id, 'pending', v_reserve, f.id, v_pass_id,
          case when v_owner then 'owner' when v_pass_id is not null then 'pass' else 'open' end)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort,
                            'beyond', f.beyond, 'textbook', v_book);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

create or replace function public.admin_ai_usage(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_role   text;
  v_day    timestamptz := public._ai_day_start();
  v_month  timestamptz := public._ai_month_start();
  t        record;
  v_last   timestamptz;
  v_status jsonb;
  v_models jsonb;
  v_recent jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(sum(cost_microcents) filter (where created_at >= v_day and pass_id is null), 0)     as own_day,
         coalesce(sum(cost_microcents) filter (where created_at >= v_day and pass_id is not null), 0) as code_day,
         coalesce(sum(cost_microcents) filter (where created_at >= v_month and pass_id is null), 0)     as own_month,
         coalesce(sum(cost_microcents) filter (where created_at >= v_month and pass_id is not null), 0) as code_month,
         count(*) filter (where created_at >= v_day and pass_id is null)                              as own_day_n,
         count(*) filter (where created_at >= v_day and pass_id is not null)                          as code_day_n,
         count(*) filter (where created_at >= v_month and pass_id is null)                            as own_month_n,
         count(*) filter (where created_at >= v_month and pass_id is not null)                        as code_month_n
    into t
    from public.study_ai_calls
   where created_at >= least(v_day, v_month);

  select max(created_at) into v_last
    from public.study_ai_calls where status = 'ok';

  select coalesce(jsonb_object_agg(x.status, x.n), '{}'::jsonb) into v_status
    from (select status, count(*) as n
            from public.study_ai_calls
           where created_at >= v_month
           group by status) x;

  select coalesce(jsonb_object_agg(x.model, x.n), '{}'::jsonb) into v_models
    from (select coalesce(model, 'unknown') as model, count(*) as n
            from public.study_ai_calls
           where created_at >= v_month
           group by 1) x;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) into v_recent
    from (select c.id, c.created_at, c.material, c.feature, c.model, c.status,
                 c.input_tokens, c.output_tokens, c.cost_microcents, c.latency_ms,
                 c.pass_id, coalesce(c.who, case when c.pass_id is not null then 'pass' end) as who,
                 p.label as pass_label
            from public.study_ai_calls c
            left join public.study_ai_passes p on p.id = c.pass_id
           order by c.created_at desc
           limit 20) x;

  return jsonb_build_object(
    'ok', true,
    'today_cents',       round(t.own_day::numeric / 1000000, 4),
    'month_cents',       round(t.own_month::numeric / 1000000, 4),
    'today_calls',       t.own_day_n,
    'month_calls',       t.own_month_n,
    'codes_today_cents', round(t.code_day::numeric / 1000000, 4),
    'codes_month_cents', round(t.code_month::numeric / 1000000, 4),
    'codes_today_calls', t.code_day_n,
    'codes_month_calls', t.code_month_n,
    'all_today_cents',   round((t.own_day + t.code_day)::numeric / 1000000, 4),
    'all_month_cents',   round((t.own_month + t.code_month)::numeric / 1000000, 4),
    'last_ok_at', v_last,
    'by_status', v_status,
    'by_model', v_models,
    'recent', v_recent
  );
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
           'daily_cents', f.daily_cents, 'tag', f.tag, 'beta', f.beta, 'beyond', f.beyond, 'updated_at', f.updated_at,
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

/* The SAQ grader's own gate (0010), unchanged but for the same rule: its caps count the calls
   not made on a code, and its rows say whose they were. */
create or replace function public.ai_begin(p_material text, p_install text, p_ip text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  s          public.study_ai_settings%rowtype;
  m          public.study_ai_models%rowtype;
  v_material text := left(trim(coalesce(p_material, '')), 120);
  v_install  text := left(trim(coalesce(p_install, '')), 64);
  v_ip       text;
  v_owner    boolean;
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

  if v_material = '' or not exists (
       select 1 from public.study_items i
        where i.id = v_material and 'ai' = any (i.tags)
     ) then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end if;

  v_owner := coalesce(public._auth_role(p_token), '') = 'admin';
  if s.mode = 'owner' and not v_owner then
    return jsonb_build_object('ok', false, 'error', 'owner_only');
  end if;

  select * into m from public.study_ai_models where id = s.model;
  if not found or not m.enabled then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  v_reserve := public._ai_cost(m.id, 2000, 400);
  if v_reserve is null then
    return jsonb_build_object('ok', false, 'error', 'no_model');
  end if;

  perform pg_advisory_xact_lock(4801001);

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c
   where c.created_at >= public._ai_month_start() and c.pass_id is null;
  if v_spent + v_reserve > s.monthly_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'monthly_cap');
  end if;

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c
   where c.created_at >= public._ai_day_start() and c.pass_id is null;
  if v_spent + v_reserve > s.daily_cents::bigint * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'daily_cap');
  end if;

  if s.mode = 'open' then
    if length(v_install) < 8 then
      return jsonb_build_object('ok', false, 'error', 'bad_install');
    end if;
    select count(*) into v_count
      from public.study_ai_calls c
     where c.install = v_install
       and c.status in ('ok', 'pending')
       and c.created_at >= public._ai_day_start();
    if v_count >= s.per_install_daily then
      return jsonb_build_object('ok', false, 'error', 'device_cap');
    end if;
    select count(*) into v_count
      from public.study_ai_calls c
     where c.ip = v_ip
       and c.created_at > now() - interval '1 minute';
    if v_count >= s.per_ip_minute then
      return jsonb_build_object('ok', false, 'error', 'slow_down');
    end if;
  end if;

  insert into public.study_ai_calls (material, install, ip, model, status, cost_microcents, who)
  values (v_material, nullif(v_install, ''), v_ip, m.id, 'pending', v_reserve,
          case when v_owner then 'owner' else 'open' end)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'call_id', v_id, 'model', m.id, 'effort', s.effort, 'max_chars', s.max_chars);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.ai_begin(text, text, text, text) from public, anon, authenticated;
grant execute on function public.ai_begin(text, text, text, text) to service_role;

revoke all on function public.ai_begin2(text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_begin2(text, text, text, text, text, integer, integer) to service_role;
revoke all on function public.admin_ai_usage(text)    from public;
revoke all on function public.admin_ai_features(text) from public;
grant execute on function public.admin_ai_usage(text)    to anon;
grant execute on function public.admin_ai_features(text) to anon;

notify pgrst, 'reload schema';
