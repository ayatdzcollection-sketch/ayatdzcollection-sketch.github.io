-- 0016_ai_day_bonus.sql
--
-- Extra budget for today only, without touching the standing caps. The owner hit the Ask cap
-- while cramming on 2026-09-17 and asked for a way to lift it for one day from the panel, rather
-- than raising the real cap and forgetting it.
--
--   * bonus_cents and bonus_at on study_ai_settings (the global daily cap) and on
--     study_ai_features (each feature's daily cap). The bonus counts only while bonus_at is
--     inside the current day window, so it expires by itself at the next midnight UTC (20:00 in
--     New York during daylight time), or at a spend reset (0014). Nothing has to be undone.
--   * admin_ai_bonus is the one way to set it: owner token, 0 to 10000 cents, one feature or the
--     global row. It returns what the caps now are and what has been spent against them.
--   * The standing caps in study_ai_settings and study_ai_features are never rewritten, so
--     tomorrow is exactly what it was before.
--
-- Safe to run twice.

alter table public.study_ai_settings add column if not exists bonus_cents int not null default 0;
alter table public.study_ai_settings add column if not exists bonus_at    timestamptz;
alter table public.study_ai_features add column if not exists bonus_cents int not null default 0;
alter table public.study_ai_features add column if not exists bonus_at    timestamptz;

-- Today's allowance for a row: its standing cap plus a bonus that has not expired.
create or replace function public._ai_day_cap(p_cap int, p_bonus int, p_at timestamptz)
returns bigint
language sql
stable
set search_path = pg_catalog, public
as $$
  select (coalesce(p_cap, 0) + case when p_at is not null and p_at >= public._ai_day_start()
                                    then coalesce(p_bonus, 0) else 0 end)::bigint;
$$;

-- ---------------------------------------------------------------- ai_begin2 with the bonus
-- The 0015 body, with the two daily ceilings read through _ai_day_cap.
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
  if v_spent + v_reserve > public._ai_day_cap(s.daily_cents, s.bonus_cents, s.bonus_at) * 1000000 then
    return jsonb_build_object('ok', false, 'error', 'daily_cap');
  end if;

  select coalesce(sum(c.cost_microcents), 0) into v_spent
    from public.study_ai_calls c where c.feature = f.id and c.created_at >= public._ai_day_start();
  if v_spent + v_reserve > public._ai_day_cap(f.daily_cents, f.bonus_cents, f.bonus_at) * 1000000 then
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

-- ---------------------------------------------------------------- the panel reads the bonus
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
           'bonus_cents', case when f.bonus_at is not null and f.bonus_at >= public._ai_day_start() then f.bonus_cents else 0 end,
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

-- ---------------------------------------------------------------- and sets it
-- p_feature null or '' is the global daily cap; otherwise the named feature. p_cents is the
-- extra for today, 0 clears it.
create or replace function public.admin_ai_bonus(p_token text, p_feature text, p_cents int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_id text := nullif(trim(coalesce(p_feature, '')), ''); s public.study_ai_settings%rowtype; f public.study_ai_features%rowtype;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_cents is null or p_cents < 0 or p_cents > 10000 then
    return jsonb_build_object('ok', false, 'error', 'range', 'field', 'bonus_cents');
  end if;

  if v_id is null then
    update public.study_ai_settings set bonus_cents = p_cents, bonus_at = case when p_cents = 0 then null else now() end, updated_at = now()
     where id = 1 returning * into s;
    if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
    return jsonb_build_object('ok', true, 'scope', 'all',
      'cap_cents', public._ai_day_cap(s.daily_cents, s.bonus_cents, s.bonus_at),
      'bonus_cents', case when s.bonus_at is not null and s.bonus_at >= public._ai_day_start() then s.bonus_cents else 0 end,
      'today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                      where c.created_at >= public._ai_day_start()), 0)::numeric / 1000000, 4));
  end if;

  update public.study_ai_features set bonus_cents = p_cents, bonus_at = case when p_cents = 0 then null else now() end, updated_at = now()
   where id = left(v_id, 21) returning * into f;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'scope', f.id,
    'cap_cents', public._ai_day_cap(f.daily_cents, f.bonus_cents, f.bonus_at),
    'bonus_cents', case when f.bonus_at is not null and f.bonus_at >= public._ai_day_start() then f.bonus_cents else 0 end,
    'today_cents', round(coalesce((select sum(c.cost_microcents) from public.study_ai_calls c
                                    where c.feature = f.id and c.created_at >= public._ai_day_start()), 0)::numeric / 1000000, 4));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public._ai_day_cap(int, int, timestamptz)      from public, anon, authenticated;
revoke all on function public.admin_ai_bonus(text, text, int)         from public;
grant execute on function public.admin_ai_bonus(text, text, int)      to anon;
