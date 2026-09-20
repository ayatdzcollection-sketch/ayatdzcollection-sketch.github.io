-- 0034: two research modes and a Deep research intensifier, and the room they need on the server.
--
-- study/src/docs/plans/ask-next-plan.md, section 13. The owner asked for a mode that comes back
-- with sources, a mode that may draw only on documents they chose, and a deeper mode that lifts
-- the limits and thinks harder. The first is the source shelf, which already exists: passages
-- under the corpus shelf-<class>, searched in Postgres, cited by document name, nothing new in
-- SQL. This migration adds the other two:
--
--   * Research (external). The owner pastes the links they want an answer to come from. The Edge
--     Function fetches each page and extracts the text itself, in code, with no model involved,
--     splits it into passages and stores them under the corpus links-<install>, where <install>
--     is the device's own 32 hex character id. Questions in that mode are answered from those
--     passages and, unless the owner turns the material back on, from nothing else.
--   * Deep research. Bigger limits and thinking on, about eight times the cost of an ordinary
--     answer, so it gets its own feature row, its own daily cap, and first place in the breaker.
--
-- The rule that governs the textbook governs a fetched page exactly as it stands (CLAUDE.md,
-- 2026-09-17 and 2026-09-20): the text lives only in study_ai_passages. It is never written into
-- a material, never into the repo, and never read with the public key. Only the Edge Function
-- reads it, through ai_passages_search under the service role, and only a few short passages go
-- to the model with a question. The same fifteen word quotation limit applies: an answer may
-- quote a fetched page the way it may quote a chapter, under fifteen words, with the source
-- named, and never at length.
--
-- Re-runnable. Applying it changes no behaviour on its own: all four feature rows are created
-- disabled, so until the owner switches one on, no link can be pulled and no research question
-- can be asked.

-- ---------------------------------------------------------------- the deep research ceiling
--
-- study_ai_settings.ceiling_cents is the most one question may cost, and it defaults to 6. A deep
-- question is meant to cost 11 to 13, so it needs its own number: without one, ai_begin2 would
-- refuse every deep question, and the only cure would be raising the ceiling for ordinary
-- questions too. 20 leaves room for a long one and still stops a runaway.
alter table public.study_ai_settings add column if not exists deep_ceiling_cents numeric not null default 20;

-- ---------------------------------------------------------------- the guards readout, with deep
--
-- Both replaced from 0033 for one reason each: the owner has to be able to see the deep ceiling
-- and to move it, and neither is any use if it can only be changed by editing this file.

create or replace function public.admin_ai_guards(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare s public.study_ai_settings%rowtype; b public.study_ai_breaker%rowtype;
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  perform public._ai_breaker_check();
  select * into s from public.study_ai_settings where id = 1;
  select * into b from public.study_ai_breaker where id = 1;
  return jsonb_build_object('ok', true,
    'plain', s.plain, 'ceiling_cents', s.ceiling_cents, 'breaker_on', s.breaker_on,
    'deep_ceiling_cents', s.deep_ceiling_cents,
    'breaker_cents', s.breaker_cents, 'breaker_hard', s.breaker_hard,
    'paused', b.paused, 'mean_cents', b.mean_cents, 'note', b.note, 'at', b.at);
end $$;

create or replace function public.admin_ai_guard_set(p_token text, p_key text, p_num numeric, p_flag boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_key = 'plain'         then update public.study_ai_settings set plain = coalesce(p_flag, false), updated_at = now() where id = 1;
  elsif p_key = 'breaker_on' then update public.study_ai_settings set breaker_on = coalesce(p_flag, true), updated_at = now() where id = 1;
  elsif p_key = 'ceiling'    then update public.study_ai_settings set ceiling_cents = greatest(0, least(coalesce(p_num, 6), 100)), updated_at = now() where id = 1;
  elsif p_key = 'deep_ceiling' then update public.study_ai_settings set deep_ceiling_cents = greatest(0, least(coalesce(p_num, 20), 200)), updated_at = now() where id = 1;
  elsif p_key = 'breaker'    then update public.study_ai_settings set breaker_cents = greatest(0, least(coalesce(p_num, 2.6), 100)), updated_at = now() where id = 1;
  elsif p_key = 'hard'       then update public.study_ai_settings set breaker_hard = greatest(0, least(coalesce(p_num, 3.1), 100)), updated_at = now() where id = 1;
  elsif p_key = 'reset'      then update public.study_ai_breaker set paused = '[]'::jsonb, note = 'reset by the owner', at = now() where id = 1;
  else return jsonb_build_object('ok', false, 'error', 'bad_key');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- the owner's own links

-- One row per link the owner pulled in, for one install. It holds only the address and where its
-- passages sit; the text itself is in study_ai_passages and nowhere else. The ord range is what
-- makes a link removable: the passages carry no link id of their own, so the row is the index.
create table if not exists public.study_ai_links (
  id         bigserial primary key,
  install    text not null,
  url        text not null,
  host       text not null,
  title      text,
  ord_from   int  not null,
  ord_to     int  not null,
  n          int  not null,
  chars      int  not null default 0,
  created_at timestamptz not null default now(),
  unique (install, url)
);
create index if not exists study_ai_links_install on public.study_ai_links (install);
alter table public.study_ai_links enable row level security;
revoke all on table public.study_ai_links from anon, authenticated;
revoke all on sequence public.study_ai_links_id_seq from anon, authenticated;

-- Store one fetched page. Service role only: the Edge Function does the fetching and the text
-- extraction, so nothing else has any business writing passages, and the public key must never be
-- able to put words into a corpus a question will be answered from.
--
-- Re-adding a url replaces what was there, because the ordinary use is to fix a link that came
-- back thin. Two ceilings keep one device from filling the table: twelve links, and four hundred
-- passages in its corpus.
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
  i        int;
begin
  if coalesce(p_install, '') !~ '^[0-9a-f]{32}$'
     or length(coalesce(p_url, '')) > 2000
     or left(coalesce(p_url, ''), 8) <> 'https://' then
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;
  v_corpus := 'links-' || p_install;
  v_title  := nullif(left(trim(coalesce(p_title, '')), 200), '');

  /* The same url again means replace, not a second copy: drop its passages by the range the old
     row recorded, then the row, before anything is counted. */
  select l.ord_from, l.ord_to into v_from, v_to
    from public.study_ai_links l where l.install = p_install and l.url = p_url;
  if found then
    delete from public.study_ai_passages where corpus = v_corpus and ord between v_from and v_to;
    delete from public.study_ai_links where install = p_install and url = p_url;
  end if;

  select count(*) into v_have from public.study_ai_links where install = p_install;
  if v_have >= 12 then return jsonb_build_object('ok', false, 'error', 'too_many'); end if;

  /* Clip first, count second: what the caller sent is not what gets stored, so the ceiling has to
     be measured against the passages that will actually exist. */
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
  if v_have + v_n > 400 then return jsonb_build_object('ok', false, 'error', 'too_big'); end if;

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

-- The three the page calls with the public key, keyed on the install it was given, the way
-- ai_chat_page is in 0033. They never read a passage body back out: the list is addresses and
-- counts, so the page can show the owner what is on the shelf and take something off it without
-- the text itself ever reaching a browser. None of them throws.
create or replace function public.ai_links_list(p_install text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_rows jsonb;
begin
  if coalesce(p_install, '') !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) into v_rows
    from (select l.id, l.url, l.host, l.title, l.n, l.chars, l.created_at
            from public.study_ai_links l
           where l.install = p_install
           order by l.id desc
           limit 50) t;
  return jsonb_build_object('ok', true, 'links', v_rows);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'failed');
end $$;

create or replace function public.ai_link_remove(p_install text, p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_corpus text; v_from int; v_to int;
begin
  if coalesce(p_install, '') !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  v_corpus := 'links-' || p_install;
  select l.ord_from, l.ord_to into v_from, v_to
    from public.study_ai_links l where l.id = p_id and l.install = p_install;
  if not found then return jsonb_build_object('ok', true, 'removed', false); end if;
  delete from public.study_ai_passages where corpus = v_corpus and ord between v_from and v_to;
  delete from public.study_ai_links where id = p_id and install = p_install;
  return jsonb_build_object('ok', true, 'removed', true);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'failed');
end $$;

create or replace function public.ai_links_clear(p_install text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_corpus text; v_n int := 0;
begin
  if coalesce(p_install, '') !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  v_corpus := 'links-' || p_install;
  delete from public.study_ai_passages where corpus = v_corpus;
  delete from public.study_ai_links where install = p_install;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'removed', v_n);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'failed');
end $$;

-- ---------------------------------------------------------------- the four new rows

-- Seeded exactly as 0033 seeds its escalations: off, owner only, inside Ask's own cap and the
-- global caps, and carrying Ask's tag, so a research question can only happen on a material where
-- Ask itself is allowed. fetch has a row although it spends nothing at all, because the owner
-- needs one switch that stops link pulling without stopping the mode.
insert into public.study_ai_features (id, name, enabled, mode, model, daily_cents, tag, beta)
select v.id, v.name, false, 'owner', v.model, v.cents, coalesce(a.tag, 'ai-ask'), true
  from (values
        ('research', 'Research mode, the source shelf', 'claude-sonnet-4-6', 15),
        ('extern',   'Research mode, the owner''s own links', 'claude-sonnet-4-6', 15),
        ('deep',     'Deep research', 'claude-sonnet-4-6', 30),
        ('fetch',    'Pulling a link into the shelf', 'claude-haiku-4-5', 1)
       ) as v(id, name, model, cents)
  left join public.study_ai_features a on a.id = 'ask'
on conflict (id) do nothing;

-- ---------------------------------------------------------------- the breaker, with the new names
--
-- As 0033, with the two pause lists widened. Deep research is the dearest thing Ask can do, so it
-- pauses first, at both lines. The two research modes are different in kind: the student turned
-- them on deliberately and is waiting for sources, and a mode that silently stops working is
-- worse than a mode that costs money, so extern and research pause only at the hard line, next to
-- retry and rerank. The order is still the plan's, dearest first and cheapest last, so an answer
-- keeps as much help as it can for as long as it can.

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
           where feature = 'ask' and route <> 'page'
             /* A deep answer is meant to cost about eight times an ordinary one, and the student
                is shown that price before they ask for it. Letting those rows into this average
                would mean one deep question pausing the cheap escalations for everybody, which is
                the breaker firing at the one cost it was told about in advance. Every other mode
                stays in: research questions are ordinary questions with more passages, and if they
                are drifting up that is exactly what this is for. */
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
    /* Rate breakers: a stage that fires this often means the stage before it is not working. */
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

-- ---------------------------------------------------------------- ai_begin2, with the new modes
--
-- As 0033, with the three research feature names added to the escalation test. Everything the
-- guards do keys on that test, so naming them here is the whole of it: Plain mode refuses them,
-- the breaker refuses the ones it has paused, and the per question ceiling is computed before a
-- deep question is allowed to start.

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

  /* An escalation is anything beyond the one call an answer already costs. fetch is
     deliberately not in this list: pulling a link spends no tokens at all, so Plain mode,
     the breaker and the per question ceiling have nothing to weigh. */
  v_esc := f.id in ('rerank', 'retry', 'tools', 'wiki', 'search', 'deep', 'research', 'extern');
  if v_esc then
    if s.plain then return jsonb_build_object('ok', false, 'error', 'plain_mode'); end if;
    v_paused := (public._ai_breaker_check()) -> 'paused';
    if v_paused ? f.id then return jsonb_build_object('ok', false, 'error', 'paused'); end if;
    /* The ceiling on one question. Read from the ledger rather than from anything the caller
       sends, so a forged request cannot buy itself more room: what this device has already spent
       in the last two minutes is what a question in flight has cost so far. */
    select coalesce(sum(c.cost_microcents), 0) into v_spent
      from public.study_ai_calls c
     where c.install = nullif(v_install, '') and c.created_at > now() - interval '2 minutes';
    /* Deep research has its own ceiling, and it has to. The shared one defaults to 6 cents and a
       deep question is meant to cost 11 to 13, so on the shared ceiling every deep question would
       be refused by arithmetic, and the only way to allow one would be to raise the ceiling for
       everything, which is the opposite of guarding it. */
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
                            'beyond', f.beyond, 'textbook', v_book,
                            'plain', s.plain, 'ceiling_cents', s.ceiling_cents,
                            'paused', coalesce((select b.paused from public.study_ai_breaker b where b.id = 1), '[]'::jsonb));
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- which mode answered

alter table public.study_ai_chats add column if not exists mode text;  -- plain, research, extern, deep

-- The writer. Exactly 0032 with that one column, so a research answer can be told from an
-- ordinary one in the numbers. Without it the cost of the modes is invisible: a deep answer and
-- a normal answer differ by eight times and by nothing else the row records.

create or replace function public.ai_chat_log(p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_id bigint; v_call bigint; v_pass bigint; v_label text;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_row');
  end if;
  v_call := nullif(p_row ->> 'call_id', '')::bigint;
  /* The code is read from the call the ledger opened for it, never from the row sent here. */
  if v_call is not null then
    select l.pass_id into v_pass from public.study_ai_calls l where l.id = v_call;
    if v_pass is not null then
      select p.label into v_label from public.study_ai_passes p where p.id = v_pass;
    end if;
  end if;

  insert into public.study_ai_chats (call_id, material, feature, install, thread, turn, question, quote, focus,
                                     labels, progress, notes, answer, status, model, input_tokens, output_tokens,
                                     cost_microcents, latency_ms, pass_id, pass_label, level, intent,
                                     route, chunks_sent, cache_read, cache_write, marks, has_rules, items,
                                     rerank, tool_round, retry, source_step, mode)
  values (
    v_call,
    left(coalesce(p_row ->> 'material', ''), 120),
    left(coalesce(p_row ->> 'feature', 'ask'), 21),
    left(p_row ->> 'install', 64),
    left(p_row ->> 'thread', 64),
    greatest(0, least(coalesce((p_row ->> 'turn')::int, 0), 1000)),
    left(coalesce(p_row ->> 'question', ''), 4200),
    left(p_row ->> 'quote', 1300),
    left(p_row ->> 'focus', 2600),
    case when jsonb_typeof(p_row -> 'labels') = 'array' then p_row -> 'labels' else '[]'::jsonb end,
    coalesce((p_row ->> 'progress')::boolean, false),
    coalesce((p_row ->> 'notes')::boolean, false),
    left(p_row ->> 'answer', 6000),
    case when p_row ->> 'status' in ('ok', 'error', 'refused') then p_row ->> 'status' else 'error' end,
    left(p_row ->> 'model', 60),
    greatest(0, coalesce((p_row ->> 'input_tokens')::int, 0)),
    greatest(0, coalesce((p_row ->> 'output_tokens')::int, 0)),
    greatest(0, coalesce((p_row ->> 'cost_microcents')::bigint, 0)),
    greatest(0, coalesce((p_row ->> 'latency_ms')::int, 0)),
    v_pass, left(v_label, 60),
    case when p_row ->> 'level' in ('quick', 'normal', 'careful') then p_row ->> 'level' else null end,
    left(nullif(p_row ->> 'intent', ''), 12),
    left(nullif(p_row ->> 'route', ''), 24),
    greatest(0, least(coalesce((p_row ->> 'chunks_sent')::int, 0), 100)),
    greatest(0, coalesce((p_row ->> 'cache_read')::int, 0)),
    greatest(0, coalesce((p_row ->> 'cache_write')::int, 0)),
    coalesce((p_row ->> 'marks')::boolean, false),
    coalesce((p_row ->> 'has_rules')::boolean, false),
    greatest(0, least(coalesce((p_row ->> 'items')::int, 0), 100)),
    coalesce((p_row ->> 'rerank')::boolean, false),
    coalesce((p_row ->> 'tool_round')::boolean, false),
    coalesce((p_row ->> 'retry')::boolean, false),
    left(nullif(p_row ->> 'source_step', ''), 20),
    left(p_row ->> 'mode', 20)
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- grants

revoke all on function public.ai_link_add(text, text, text, text, text[], text[]) from public, anon, authenticated;
grant execute on function public.ai_link_add(text, text, text, text, text[], text[]) to service_role;
revoke all on function public.ai_links_list(text)                                  from public;
grant execute on function public.ai_links_list(text)                               to anon, authenticated;
revoke all on function public.ai_link_remove(text, bigint)                         from public;
grant execute on function public.ai_link_remove(text, bigint)                      to anon, authenticated;
revoke all on function public.ai_links_clear(text)                                 from public;
grant execute on function public.ai_links_clear(text)                              to anon, authenticated;
revoke all on function public._ai_breaker_check()                                  from public, anon, authenticated;
grant execute on function public._ai_breaker_check()                               to service_role;
revoke all on function public.ai_chat_log(jsonb)                                   from public, anon, authenticated;
grant execute on function public.ai_chat_log(jsonb)                                to service_role;
revoke all on function public.ai_begin2(text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_begin2(text, text, text, text, text, integer, integer) to service_role;
revoke all on function public.admin_ai_guards(text)                                from public;
grant execute on function public.admin_ai_guards(text)                             to anon;
revoke all on function public.admin_ai_guard_set(text, text, numeric, boolean)     from public;
grant execute on function public.admin_ai_guard_set(text, text, numeric, boolean)  to anon;
