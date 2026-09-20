-- 0033: the loop that makes Ask better, and the guards that stop it getting dearer.
--
-- Two halves of study/src/docs/plans/ask-next-plan.md:
--
--   4.3  The page already checks every answer and counts what it cannot back (0032). That count
--        alone cannot be acted on. These tables keep the sentence itself, let the owner turn one
--        into a correction, and let the correction outrank everything on the next matching
--        question. That is the whole "improve over time" loop: detect, review, correct, prefer.
--
--   8    Everything that can add spend beyond the one call an answer already costs is an
--        escalation: the passage reranker, one retry after a failed check, a tool round, a
--        Wikipedia fetch, a web search. Each gets its own switch and its own daily cap, there is
--        a ceiling on what one question may cost whatever it does, a breaker that pauses them in
--        order when the running mean climbs, and Plain mode, which turns the lot off and returns
--        Ask to exactly the single call it made before any of this.
--
-- Re-runnable. Applying it changes no behaviour on its own: every escalation row is created
-- disabled, so until the owner switches one on, nothing new can happen and nothing new can cost.

-- ---------------------------------------------------------------- flags and corrections

create table if not exists public.study_ai_flags (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  chat_id    bigint,
  material   text not null,
  kind       text not null,
  sentence   text not null,
  route      text,
  reviewed   boolean not null default false
);
create index if not exists study_ai_flags_new on public.study_ai_flags (reviewed, id desc);
alter table public.study_ai_flags enable row level security;

-- A correction the owner wrote after reading a flagged answer. Retrieved like a passage and sent
-- ahead of the material's own, so the same wrong answer cannot come back.
create table if not exists public.study_ai_corrections (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  material   text not null,
  topic      text not null,          -- the words that have to appear in a question for this to be sent
  body       text not null,          -- what is true, in the owner's words
  enabled    boolean not null default true,
  from_flag  bigint
);
create index if not exists study_ai_corrections_live on public.study_ai_corrections (material, enabled);
alter table public.study_ai_corrections enable row level security;

-- The page reports what its checks found, once per answer. Open to the same caller that may rate
-- a chat: it writes only counts and the sentences its own checks produced, never free text from
-- anywhere else, and only against a chat row that has not been written yet.
create or replace function public.ai_flags_add(p_chat_id bigint, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_material text; v_route text; v_n int := 0; r jsonb;
begin
  if p_chat_id is null then return jsonb_build_object('ok', false, 'error', 'bad_row'); end if;
  select c.material, c.route into v_material, v_route from public.study_ai_chats c where c.id = p_chat_id;
  if v_material is null then return jsonb_build_object('ok', false, 'error', 'bad_row'); end if;
  /* Once per answer: a row that already has a count is not written again. */
  if exists (select 1 from public.study_ai_chats c where c.id = p_chat_id and c.flags is not null) then
    return jsonb_build_object('ok', true, 'stored', false);
  end if;

  if jsonb_typeof(p_rows) = 'array' then
    for r in select * from jsonb_array_elements(p_rows) limit 20 loop
      if jsonb_typeof(r) <> 'object' then continue; end if;
      if coalesce(r ->> 'kind', '') = '' then continue; end if;
      insert into public.study_ai_flags (chat_id, material, kind, sentence, route)
      values (p_chat_id, v_material, left(r ->> 'kind', 20), left(coalesce(r ->> 'sentence', ''), 400), v_route);
      v_n := v_n + 1;
    end loop;
  end if;

  update public.study_ai_chats
     set flags = v_n,
         flag_kinds = coalesce((select jsonb_agg(distinct left(x ->> 'kind', 20))
                                  from jsonb_array_elements(case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end) x), '[]'::jsonb)
   where id = p_chat_id;
  return jsonb_build_object('ok', true, 'stored', true, 'n', v_n);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- A question answered by the page itself, for nothing. Logged so the savings can be measured at
-- all: without a row, the cheapest thing Ask does is the one thing invisible in the numbers.
create or replace function public.ai_chat_page(p_material text, p_install text, p_kind text, p_question text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_id bigint; v_n int;
begin
  if coalesce(trim(p_material), '') = '' then return jsonb_build_object('ok', false, 'error', 'bad_row'); end if;
  /* A page answer costs nothing, so the only thing worth guarding is noise. */
  select count(*) into v_n from public.study_ai_chats
   where install = left(p_install, 64) and route = 'page' and created_at > now() - interval '1 minute';
  if v_n >= 20 then return jsonb_build_object('ok', false, 'error', 'slow_down'); end if;

  insert into public.study_ai_chats (material, feature, install, question, answer, status, model,
                                     input_tokens, output_tokens, cost_microcents, latency_ms, route, source_step, flags)
  values (left(p_material, 120), 'ask', left(p_install, 64), left(coalesce(p_question, ''), 4200),
          left(coalesce(p_kind, ''), 60), 'ok', 'page', 0, 0, 0, 0, 'page', 'material', 0)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- What the function asks for before it answers: the corrections that match this question. Service
-- role only, because it is read inside the Edge Function and its text goes into a prompt.
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
             /* Every word of the topic that is worth matching has to appear in the question.
                Three letters was too long a floor: a topic of "tax" or "FDR" matched nothing at
                all, so a correction could look saved and never once fire. */
             and exists (
               select 1 from unnest(string_to_array(lower(c.topic), ' ')) w
                where length(w) > 2 and position(w in v_q) > 0)
           order by c.id desc
           limit greatest(1, least(coalesce(p_limit, 3), 5))) t;
  return jsonb_build_object('ok', true, 'corrections', v_rows);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- ---------------------------------------------------------------- the owner's side

create or replace function public.admin_ai_flags(p_token text, p_limit int, p_all boolean)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_rows jsonb; v_stats jsonb;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) into v_rows
    from (select f.id, f.created_at, f.chat_id, f.material, f.kind, f.sentence, f.route, f.reviewed,
                 c.question, c.answer, c.rating
            from public.study_ai_flags f
            left join public.study_ai_chats c on c.id = f.chat_id
           where coalesce(p_all, false) or not f.reviewed
           order by f.id desc
           limit greatest(1, least(coalesce(p_limit, 50), 200))) t;
  /* Counted over the flags themselves. Grouping by kind first made total the number of kinds. */
  select jsonb_build_object(
           'total', (select count(*) from public.study_ai_flags),
           'open',  (select count(*) from public.study_ai_flags where not reviewed),
           'by_kind', coalesce((select jsonb_object_agg(k.kind, k.n)
                                  from (select kind, count(*) n from public.study_ai_flags
                                         where not reviewed group by kind) k), '{}'::jsonb))
    into v_stats;
  return jsonb_build_object('ok', true, 'flags', v_rows, 'stats', v_stats);
end $$;

create or replace function public.admin_flag_reviewed(p_token text, p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  update public.study_ai_flags set reviewed = true where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_correction_add(p_token text, p_material text, p_topic text, p_body text, p_flag bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_id bigint;
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if coalesce(trim(p_topic), '') = '' or coalesce(trim(p_body), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_row');
  end if;
  insert into public.study_ai_corrections (material, topic, body, from_flag)
  values (left(trim(p_material), 120), left(trim(p_topic), 200), left(trim(p_body), 1000), p_flag)
  returning id into v_id;
  if p_flag is not null then update public.study_ai_flags set reviewed = true where id = p_flag; end if;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

create or replace function public.admin_corrections(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_rows jsonb;
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) into v_rows
    from (select id, created_at, material, topic, body, enabled, from_flag from public.study_ai_corrections order by id desc limit 200) t;
  return jsonb_build_object('ok', true, 'corrections', v_rows);
end $$;

create or replace function public.admin_correction_set(p_token text, p_id bigint, p_enabled boolean, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
begin
  if coalesce(public._auth_role(p_token), '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  update public.study_ai_corrections
     set enabled = coalesce(p_enabled, enabled),
         body = case when coalesce(trim(p_body), '') = '' then body else left(trim(p_body), 1000) end,
         updated_at = now()
   where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- the guards

alter table public.study_ai_settings add column if not exists plain           boolean not null default false;
alter table public.study_ai_settings add column if not exists ceiling_cents   numeric not null default 6;
alter table public.study_ai_settings add column if not exists breaker_cents   numeric not null default 2.6;
alter table public.study_ai_settings add column if not exists breaker_hard    numeric not null default 3.1;
alter table public.study_ai_settings add column if not exists breaker_on      boolean not null default true;

create table if not exists public.study_ai_breaker (
  id         int primary key default 1 check (id = 1),
  paused     jsonb not null default '[]'::jsonb,
  mean_cents numeric,
  note       text,
  at         timestamptz
);
insert into public.study_ai_breaker (id) values (1) on conflict (id) do nothing;
alter table public.study_ai_breaker enable row level security;

-- One row per escalation, all off, each inside Ask's own cap and the global caps. The tag is
-- Ask's, so an escalation can only ever happen on a material where Ask itself is allowed.
insert into public.study_ai_features (id, name, enabled, mode, model, daily_cents, tag, beta)
select v.id, v.name, false, 'owner', v.model, v.cents, coalesce(a.tag, 'ai-ask'), true
  from (values
        ('rerank', 'Passage reranker', 'claude-haiku-4-5', 5),
        ('retry',  'One retry after a failed check', 'claude-sonnet-4-6', 5),
        ('tools',  'Search tools during an answer', 'claude-sonnet-4-6', 8),
        ('wiki',   'Wikipedia lead section', 'claude-sonnet-4-6', 3),
        ('search', 'Web search', 'claude-sonnet-4-6', 10)
       ) as v(id, name, model, cents)
  left join public.study_ai_features a on a.id = 'ask'
on conflict (id) do nothing;

-- Which escalations are paused right now, and why. Recomputed on demand from the last twenty Ask
-- answers: the mean cost, and how often the two dearest escalations fired. The order is the plan's:
-- the dearest thing goes first and the cheapest last, so the answer keeps as much help as it can.
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
           where feature = 'ask' and route <> 'page' order by id desc limit 20) t;

  if coalesce(v_n, 0) >= 10 then
    if v_mean > s.breaker_hard then
      v_paused := array['search', 'wiki', 'tools', 'retry', 'rerank'];
      v_note := 'average ' || round(v_mean, 2) || ' cents over the last ' || v_n || ', past the hard line';
    elsif v_mean > s.breaker_cents then
      v_paused := array['search', 'wiki', 'tools'];
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
  elsif p_key = 'breaker'    then update public.study_ai_settings set breaker_cents = greatest(0, least(coalesce(p_num, 2.6), 100)), updated_at = now() where id = 1;
  elsif p_key = 'hard'       then update public.study_ai_settings set breaker_hard = greatest(0, least(coalesce(p_num, 3.1), 100)), updated_at = now() where id = 1;
  elsif p_key = 'reset'      then update public.study_ai_breaker set paused = '[]'::jsonb, note = 'reset by the owner', at = now() where id = 1;
  else return jsonb_build_object('ok', false, 'error', 'bad_key');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- ai_begin2, with the guards
--
-- As 0026, plus: Plain mode refuses every escalation outright, the breaker refuses the ones it
-- has paused, and the answer carries the ceiling and the paused list back so the function can
-- decide what it can still afford before it spends anything.

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

  /* An escalation is anything beyond the one call an answer already costs. */
  v_esc := f.id in ('rerank', 'retry', 'tools', 'wiki', 'search');
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
    if v_spent + public._ai_cost(
         (select mm.id from public.study_ai_models mm where mm.id = f.model),
         least(greatest(coalesce(p_in, 0), 3000), 60000),
         least(greatest(coalesce(p_out, 0), 200), 4000)
       ) > s.ceiling_cents * 1000000 then
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

-- ---------------------------------------------------------------- grants

revoke all on function public.ai_flags_add(bigint, jsonb)                          from public;
grant execute on function public.ai_flags_add(bigint, jsonb)                       to anon;
revoke all on function public.ai_chat_page(text, text, text, text)                 from public;
grant execute on function public.ai_chat_page(text, text, text, text)              to anon;
revoke all on function public.ai_corrections_get(text, text, int)                  from public, anon, authenticated;
grant execute on function public.ai_corrections_get(text, text, int)               to service_role;
revoke all on function public._ai_breaker_check()                                  from public, anon, authenticated;
grant execute on function public._ai_breaker_check()                               to service_role;
revoke all on function public.admin_ai_flags(text, int, boolean)                   from public;
grant execute on function public.admin_ai_flags(text, int, boolean)                to anon;
revoke all on function public.admin_flag_reviewed(text, bigint)                    from public;
grant execute on function public.admin_flag_reviewed(text, bigint)                 to anon;
revoke all on function public.admin_correction_add(text, text, text, text, bigint) from public;
grant execute on function public.admin_correction_add(text, text, text, text, bigint) to anon;
revoke all on function public.admin_corrections(text)                              from public;
grant execute on function public.admin_corrections(text)                           to anon;
revoke all on function public.admin_correction_set(text, bigint, boolean, text)    from public;
grant execute on function public.admin_correction_set(text, bigint, boolean, text) to anon;
revoke all on function public.admin_ai_guards(text)                                from public;
grant execute on function public.admin_ai_guards(text)                             to anon;
revoke all on function public.admin_ai_guard_set(text, text, numeric, boolean)     from public;
grant execute on function public.admin_ai_guard_set(text, text, numeric, boolean)  to anon;
revoke all on function public.ai_begin2(text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ai_begin2(text, text, text, text, text, integer, integer) to service_role;
