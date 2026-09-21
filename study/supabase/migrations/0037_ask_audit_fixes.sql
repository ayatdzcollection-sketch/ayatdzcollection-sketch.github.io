-- 0037: five faults found reading the Ask path end to end on 2026-09-20.
--
-- Apply with `supabase db push`. Every function here replaces one that already exists, with the
-- same name, arguments and grants, so nothing that calls them changes.
--
-- 1. The breaker could not see retries or research answers. The chat log began recording the
--    feature a call was billed to (it used to write the constant 'ask'), and the breaker still
--    read `feature = 'ask'`. So the retry rate was always nought, its 15 per cent line could never
--    fire, and research answers, which 0034 says stay in the average, were left out of it.
-- 2. A correction fired on any ONE word of its topic, matched anywhere inside another word. The
--    comment said every word had to appear. A topic of "Stamp Act tax date" went out with "what
--    date is the test", and "act" matched "practice". An unrelated correction then rode along
--    under a rule that says it outranks the material.
-- 3. The passage search stopped at eight rows, and research mode's cap of three from any one
--    document was applied to those eight: one long document holding the top eight left an answer
--    three passages and the owner's other documents none. The ceiling is 24 now, and the function
--    asks for three times what it keeps.
-- 4. Re-adding a link deleted the old copy before checking the new one would fit.
-- 5. The per question ceiling counted the device's last two minutes for research, extern and
--    deep, which are whole answers and not add ons, so quick follow ups were refused.
--
-- No em dashes and no en dashes.

-- ---------------------------------------------------------------- 1. the breaker

create or replace function public._ai_breaker_check()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare s public.study_ai_settings%rowtype; v_mean numeric; v_n int;
        v_tools numeric; v_retry numeric; v_paused text[] := '{}'; v_note text := '';
begin
  select * into s from public.study_ai_settings where id = 1;
  if not found or not s.breaker_on then
    update public.study_ai_breaker set paused = '[]'::jsonb, note = null, mean_cents = null, at = now() where id = 1;
    return jsonb_build_object('paused', '[]'::jsonb, 'off', true);
  end if;

  select count(*), avg(cost_microcents) / 1000000.0,
         avg(case when tool_round then 1 else 0 end), avg(case when retry then 1 else 0 end)
    into v_n, v_mean, v_tools, v_retry
    from (select cost_microcents, tool_round, retry from public.study_ai_chats
           -- Every answer Ask gives, under whichever feature it was billed. Since the chat log
           -- began recording the billed feature (it used to write the constant 'ask'), a filter
           -- on 'ask' alone left out every retry, so the retry rate below was always nought and
           -- its line could never fire, and left out every research answer, which the note under
           -- this one says stay in.
           where feature in ('ask', 'retry', 'research', 'extern') and route <> 'page'
             -- A deep answer is meant to cost about eight times an ordinary one, and the student
             -- is shown that price before they ask for it. Letting those rows into this average
             -- would mean one deep question pausing the cheap escalations for everybody, which is
             -- the breaker firing at the one cost it was told about in advance. Every other mode
             -- stays in: research questions are ordinary questions with more passages, and if they
             -- are drifting up that is exactly what this is for.
             and coalesce(mode, '') not like '%deep%'
           order by id desc limit 20) t;

  if coalesce(v_n, 0) >= 10 then
    if v_mean > s.breaker_hard then
      v_paused := array['deep', 'search', 'wiki', 'tools', 'extern', 'research', 'retry', 'rerank'];
      v_note := 'average ' || round(v_mean, 2) || ' cents over the last ' || v_n || ', past the hard line';
    elsif v_mean > s.breaker_cents then
      v_paused := array['deep', 'search', 'wiki', 'tools'];
      v_note := 'average ' || round(v_mean, 2) || ' cents over the last ' || v_n;
    end if;
    -- Rate breakers: a stage that fires this often means the stage before it is not working.
    if coalesce(v_tools, 0) > 0.25 and not ('tools' = any (v_paused)) then
      v_paused := v_paused || 'tools';
      v_note := trim(both ' ,' from v_note || ', tool rounds on ' || round(v_tools * 100) || ' per cent');
    end if;
    if coalesce(v_retry, 0) > 0.15 and not ('retry' = any (v_paused)) then
      v_paused := v_paused || 'retry';
      v_note := trim(both ' ,' from v_note || ', retries on ' || round(v_retry * 100) || ' per cent');
    end if;
  end if;

  update public.study_ai_breaker
     set paused = to_jsonb(v_paused), mean_cents = round(coalesce(v_mean, 0), 3),
         note = nullif(v_note, ''), at = now()
   where id = 1;
  return jsonb_build_object('paused', to_jsonb(v_paused), 'mean', round(coalesce(v_mean, 0), 3), 'note', nullif(v_note, ''));
exception when others then
  return jsonb_build_object('paused', '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- 2. which corrections match

create or replace function public.ai_corrections_get(p_material text, p_query text, p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_rows jsonb; v_q text := lower(left(coalesce(p_query, ''), 2000));
begin
  select coalesce(jsonb_agg(jsonb_build_object('topic', t.topic, 'body', t.body) order by t.id desc), '[]'::jsonb)
    into v_rows
    from (select c.id, c.topic, c.body
            from public.study_ai_corrections c
           where c.enabled and c.material = left(coalesce(p_material, ''), 120)
             -- Every word of the topic that is worth matching has to appear in the question, as a
             -- word and not as letters inside another one. Words are cut on anything that is not
             -- a letter or a digit, so "Act," and "act" are the same word. A word of three letters
             -- counts (a floor of four left "tax" and "FDR" matching nothing at all), and a
             -- topic with no such word matches nothing, which the panel already says.
             and exists (
               select 1 from regexp_split_to_table(lower(c.topic), '[^a-z0-9]+') w where length(w) > 2)
             and not exists (
               select 1 from regexp_split_to_table(lower(c.topic), '[^a-z0-9]+') w
                where length(w) > 2
                  and v_q !~ ('(^|[^a-z0-9])' || w || '([^a-z0-9]|$)'))
           order by c.id desc
           limit greatest(1, least(coalesce(p_limit, 3), 5))) t;
  return jsonb_build_object('ok', true, 'corrections', v_rows);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- 3. the passage search, to 24

create or replace function public.ai_passages_search(p_corpus text, p_query text, p_chapter int, p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_and tsquery; v_or tsquery; v_txt text; v_lim int := greatest(1, least(coalesce(p_limit, 4), 24)); v_out jsonb;
begin
  v_and := plainto_tsquery('english', left(coalesce(p_query, ''), 1000));
  v_txt := v_and::text;
  if v_txt is null or v_txt = '' then return jsonb_build_object('ok', true, 'passages', '[]'::jsonb); end if;
  v_or := replace(v_txt, ' & ', ' | ')::tsquery;

  -- Passages holding every word first, then passages holding some, each ranked by cover
  -- density, with a small lift for the chapter the student is in.
  select coalesce(jsonb_agg(jsonb_build_object('chapter', t.chapter, 'heading', t.heading, 'body', t.body) order by t.tier, t.score desc), '[]'::jsonb)
    into v_out
    from (select p.chapter, p.heading, p.body,
                 case when p.tsv @@ v_and then 0 else 1 end as tier,
                 ts_rank_cd(p.tsv, v_or, 32) + case when p_chapter is not null and p.chapter = p_chapter then 0.02 else 0 end as score
            from public.study_ai_passages p
           where p.corpus = left(coalesce(p_corpus, ''), 60) and p.tsv @@ v_or
           order by tier, score desc
           limit v_lim) t;

  return jsonb_build_object('ok', true, 'passages', v_out);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- 4. re-adding a link

create or replace function public.ai_link_add(p_install text, p_url text, p_host text, p_title text,
                                              p_bodies text[], p_headings text[])
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_corpus text;
  v_title  text;
  v_bodies text[] := '{}';
  v_heads  text[] := '{}';
  v_body   text;
  v_head   text;
  v_from   int;
  v_to     int;
  v_have   int;
  v_n      int := 0;
  v_chars  int := 0;
  v_id     bigint;
  v_old    boolean := false;
  v_old_n  int := 0;
  i        int;
begin
  if coalesce(p_install, '') !~ '^[0-9a-f]{32}$'
     or length(coalesce(p_url, '')) > 2000
     or left(coalesce(p_url, ''), 8) <> 'https://' then
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;
  v_corpus := 'links-' || p_install;
  v_title  := nullif(left(trim(coalesce(p_title, '')), 200), '');

  -- The same url again means replace, not a second copy. The old copy is found here and dropped
  -- further down, once the new one is known to fit. It used to be deleted first, and a refusal
  -- after that (nothing readable came back, or the shelf was full) returned without putting it
  -- back, so trying to fix a thin link could lose the link.
  select l.ord_from, l.ord_to, l.n into v_from, v_to, v_old_n
    from public.study_ai_links l where l.install = p_install and l.url = p_url;
  v_old := found;

  select count(*) into v_have from public.study_ai_links where install = p_install;
  if v_have - (case when v_old then 1 else 0 end) >= 12 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;

  -- Clip first, count second: what the caller sent is not what gets stored, so the ceiling has to
  -- be measured against the passages that will actually exist.
  for i in 1 .. least(coalesce(array_length(p_bodies, 1), 0), 40) loop
    v_body := left(coalesce(p_bodies[i], ''), 1500);
    if trim(v_body) = '' then continue; end if;
    v_head := nullif(trim(coalesce(p_headings[i], '')), '');
    if v_head is null then v_head := v_title; end if;
    v_bodies := v_bodies || v_body;
    v_heads  := v_heads  || left(v_head, 200);
  end loop;
  v_n := coalesce(array_length(v_bodies, 1), 0);
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'bad'); end if;

  select count(*) into v_have from public.study_ai_passages where corpus = v_corpus;
  if v_have - (case when v_old then coalesce(v_old_n, 0) else 0 end) + v_n > 400 then
    return jsonb_build_object('ok', false, 'error', 'too_big');
  end if;

  if v_old then
    delete from public.study_ai_passages where corpus = v_corpus and ord between v_from and v_to;
    delete from public.study_ai_links where install = p_install and url = p_url;
  end if;

  select coalesce(max(p.ord), 0) + 1 into v_from from public.study_ai_passages p where p.corpus = v_corpus;
  for i in 1 .. v_n loop
    insert into public.study_ai_passages (corpus, chapter, heading, ord, body)
    values (v_corpus, null, v_heads[i], v_from + i - 1, v_bodies[i]);
    v_chars := v_chars + length(v_bodies[i]);
  end loop;

  insert into public.study_ai_links (install, url, host, title, ord_from, ord_to, n, chars)
  values (p_install, p_url, left(coalesce(p_host, ''), 200), v_title, v_from, v_from + v_n - 1, v_n, v_chars)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'n', v_n, 'title', v_title);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- 5. the ceiling, per kind of call

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
    -- That window is right for an add on (a rerank, a retry, a tool round): those are part of a
    -- question already in flight, so what the device just spent IS that question. It is wrong for
    -- research, extern and deep, which are not add ons but the answer itself: there the last two
    -- minutes are the student's previous questions, and two quick follow ups were enough to have
    -- a third, ordinary, research question refused as "more than the limit you set". For those
    -- three the ceiling is held against this call alone.
    if f.id in ('research', 'extern', 'deep') then
      v_spent := 0;
    else
      select coalesce(sum(c.cost_microcents), 0) into v_spent
        from public.study_ai_calls c
       where c.install = nullif(v_install, '') and c.created_at > now() - interval '2 minutes';
    end if;
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

revoke all on function public._ai_breaker_check()                                  from public, anon, authenticated;
grant execute on function public._ai_breaker_check()                               to service_role;
revoke all on function public.ai_corrections_get(text, text, int)                  from public, anon, authenticated;
grant execute on function public.ai_corrections_get(text, text, int)               to service_role;
revoke all on function public.ai_passages_search(text, text, int, int)             from public, anon, authenticated;
grant execute on function public.ai_passages_search(text, text, int, int)          to service_role;
revoke all on function public.ai_link_add(text, text, text, text, text[], text[])  from public, anon, authenticated;
grant execute on function public.ai_link_add(text, text, text, text, text[], text[]) to service_role;
revoke all on function public.ai_begin2(text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_begin2(text, text, text, text, text, integer, integer) to service_role;

notify pgrst, 'reload schema';
