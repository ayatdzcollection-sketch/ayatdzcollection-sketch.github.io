-- 0036: read "beyond the material" off the contract, not off the bill.
--
-- study_ai_features is a billing and switching table. A row exists per escalation so each one can
-- have its own daily cap, be paused on its own by the breaker, and be switched off. Which row a
-- call lands on is therefore decided by what it costs:
--
--     deep ? 'deep' : fault ? 'retry' : MODE_FEATURE[mode]
--
-- That is right for money and wrong for content. ai_begin2 returned that row's `beyond`, so the
-- rule governing what an answer may draw on was chosen by its price bucket. Measured on the live
-- rows, the same question in the same material got three different contracts:
--
--     first attempt          feature ask    beyond true   ->  may use its own knowledge
--     the same one retried   feature retry  beyond false  ->  nothing of its own
--     the same one deeply    feature deep   beyond false  ->  nothing of its own
--
-- So a retry was held to a stricter rule than the attempt it was correcting, and nobody was told
-- the rules had changed. The two research modes had it worse than inconsistent: their own rules
-- already say to answer from the chosen sources and not from the model's own knowledge, so a
-- `beyond` of true would have put a permission and a prohibition in one request.
--
-- After this, 'beyond' means one thing: the material contract, kept on the 'ask' row, read by
-- every answer in a material. The other rows keep the column and it is no longer read for the
-- answer path, so writing it does nothing; the panel stops offering it anywhere but 'ask'.
--
-- As 0034 otherwise, line for line, with that one value changed.
-- No em dashes and no en dashes.

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
  v_esc      boolean;
  v_paused   jsonb;
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

  -- An escalation is anything beyond the one call an answer already costs. fetch is
  -- deliberately not in this list: pulling a link spends no tokens at all, so Plain mode,
  -- the breaker and the per question ceiling have nothing to weigh.
  v_esc := f.id in ('rerank', 'retry', 'tools', 'wiki', 'search', 'deep', 'research', 'extern');
  if v_esc then
    if s.plain then return jsonb_build_object('ok', false, 'error', 'plain_mode'); end if;
    v_paused := (public._ai_breaker_check()) -> 'paused';
    if v_paused ? f.id then return jsonb_build_object('ok', false, 'error', 'paused'); end if;
    -- The ceiling on one question. Read from the ledger rather than from anything the caller
    -- sends, so a forged request cannot buy itself more room: what this device has already spent
    -- in the last two minutes is what a question in flight has cost so far.
    select coalesce(sum(c.cost_microcents), 0) into v_spent
      from public.study_ai_calls c
     where c.install = nullif(v_install, '') and c.created_at > now() - interval '2 minutes';
    -- Deep research has its own ceiling, and it has to. The shared one defaults to 6 cents and a
    -- deep question is meant to cost 11 to 13, so on the shared ceiling every deep question would
    -- be refused by arithmetic, and the only way to allow one would be to raise the ceiling for
    -- everything, which is the opposite of guarding it.
    if v_spent + public._ai_cost(
         (select mm.id from public.study_ai_models mm where mm.id = f.model),
         least(greatest(coalesce(p_in, 0), 3000), 60000),
         least(greatest(coalesce(p_out, 0), 200), 4000)
       ) > (case when f.id = 'deep' then s.deep_ceiling_cents else s.ceiling_cents end) * 1000000 then
      return jsonb_build_object('ok', false, 'error', 'ceiling');
    end if;
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
                            -- Not f.beyond. Which row billed this call is decided by what it
                            -- costs, and what an answer may draw on is not a question about cost.
                            -- Reading it off the billing row meant the same question got a
                            -- different contract depending on its price bucket: an ordinary
                            -- attempt went by 'ask', its retry by 'retry' and its deep version by
                            -- 'deep', so a retry could be held to a stricter rule than the answer
                            -- it was correcting. The material contract lives on 'ask' and every
                            -- answer in a material reads it. The two research modes never go
                            -- beyond their sources, whatever any row says; deep is settled in the
                            -- Edge Function instead, because only it knows which mode asked.
                            'beyond', case
                              when f.id in ('research', 'extern') then false
                              when f.id in ('ask', 'deep', 'retry')
                                then coalesce((select a.beyond from public.study_ai_features a where a.id = 'ask'), false)
                              else f.beyond
                            end,
                            'textbook', v_book,
                            'plain', s.plain, 'ceiling_cents', s.ceiling_cents,
                            'paused', coalesce((select b.paused from public.study_ai_breaker b where b.id = 1), '[]'::jsonb));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.ai_begin2(text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_begin2(text, text, text, text, text, integer, integer) to service_role;
