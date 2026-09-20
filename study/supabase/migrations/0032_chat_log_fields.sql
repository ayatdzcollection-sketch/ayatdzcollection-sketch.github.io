-- 0032: what each Ask answer actually cost and how it was reached.
--
-- The first 46 chats could not answer "did the cheap path help?", because the row kept the
-- blended token count and nothing about which route answered, how many passages went, or whether
-- the page had to flag anything afterwards. These columns are the measurement the next round is
-- judged on (study/src/docs/plans/ask-next-plan.md, sections 7.2 and 8.6).
--
-- Everything here is additive and re-runnable. Until it is applied, study-ask sends the extra
-- keys and ai_chat_log ignores them, so the function and the pages can ship in any order.
--
-- Also widens the stored question from 700 characters to 4,200: the message box now takes 4,000
-- so a student can paste a worksheet, and a row that keeps the first 700 characters of one
-- cannot be read back later.

alter table public.study_ai_chats add column if not exists route        text;    -- page, reuse, haiku, sonnet, escalated
alter table public.study_ai_chats add column if not exists chunks_sent  int;     -- passages in the request
alter table public.study_ai_chats add column if not exists cache_read   int;     -- prefix read at a tenth
alter table public.study_ai_chats add column if not exists cache_write  int;     -- prefix written at 1.25
alter table public.study_ai_chats add column if not exists marks        boolean; -- inline marking was asked for
alter table public.study_ai_chats add column if not exists has_rules    boolean; -- the thread carried pinned rules
alter table public.study_ai_chats add column if not exists items        int;     -- items a pasted message was split into
alter table public.study_ai_chats add column if not exists rerank       boolean; -- the small passage picker ran
alter table public.study_ai_chats add column if not exists tool_round   boolean; -- the model called a search tool
alter table public.study_ai_chats add column if not exists retry        boolean; -- one escalation after a failed check
alter table public.study_ai_chats add column if not exists source_step  text;    -- material, correction, textbook, shelf, own, wiki, web
alter table public.study_ai_chats add column if not exists flags        int;     -- code check faults, written by the page
alter table public.study_ai_chats add column if not exists flag_kinds   jsonb;

-- The writer. Same as 0024 with the new columns and the wider question.
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
                                     rerank, tool_round, retry, source_step)
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
    left(nullif(p_row ->> 'source_step', ''), 20)
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- What the page found wrong with an answer after it arrived (the code checks in the plan,
-- section 4.2). Open to the same caller that may rate a chat: it writes only to the row it was
-- given, only once, and only counts and kinds, never new text. The sentence that failed is kept
-- so the owner can read it in the panel and turn it into a correction.
create or replace function public.ai_chat_flags(p_chat_id bigint, p_flags int, p_kinds jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_n int; v_kinds jsonb;
begin
  if p_chat_id is null then return jsonb_build_object('ok', false, 'error', 'bad_row'); end if;
  v_n := greatest(0, least(coalesce(p_flags, 0), 50));
  v_kinds := case when jsonb_typeof(p_kinds) = 'array' then jsonb_path_query_array(p_kinds, '$[0 to 20]') else '[]'::jsonb end;
  update public.study_ai_chats
     set flags = v_n, flag_kinds = v_kinds
   where id = p_chat_id and flags is null;
  if not found then return jsonb_build_object('ok', true, 'stored', false); end if;
  return jsonb_build_object('ok', true, 'stored', true);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- The owner's list, now carrying how each answer was reached.
create or replace function public.admin_ai_chats(p_token text, p_limit int, p_before bigint)
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
    from (select id, created_at, material, feature, thread, turn, question, quote, focus, labels, progress, notes,
                 answer, status, model, input_tokens, output_tokens, cost_microcents, latency_ms, rating,
                 pass_id, pass_label, level, intent,
                 route, chunks_sent, cache_read, cache_write, marks, has_rules, items,
                 rerank, tool_round, retry, source_step, flags, flag_kinds
            from public.study_ai_chats
           where p_before is null or id < p_before
           order by id desc
           limit greatest(1, least(coalesce(p_limit, 50), 500))) t;

  select jsonb_build_object(
           'total', count(*),
           'helpful', count(*) filter (where rating = 1),
           'unhelpful', count(*) filter (where rating = -1),
           'flagged', count(*) filter (where coalesce(flags, 0) > 0),
           'from_codes', count(*) filter (where pass_label is not null),
           'today', count(*) filter (where created_at >= public._ai_day_start()))
    into v_stats
    from public.study_ai_chats;

  return jsonb_build_object('ok', true, 'chats', v_rows, 'stats', v_stats);
end $$;

revoke all on function public.ai_chat_log(jsonb)                    from public, anon, authenticated;
grant execute on function public.ai_chat_log(jsonb)                 to service_role;
revoke all on function public.ai_chat_flags(bigint, int, jsonb)     from public;
grant execute on function public.ai_chat_flags(bigint, int, jsonb)  to anon;
revoke all on function public.admin_ai_chats(text, int, bigint)     from public;
grant execute on function public.admin_ai_chats(text, int, bigint)  to anon;
