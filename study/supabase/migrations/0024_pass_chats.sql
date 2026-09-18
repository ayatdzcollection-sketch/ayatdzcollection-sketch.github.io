-- 0024_pass_chats.sql
--
-- Whose chat is this. The owner collects the conversations of people given an access code, for
-- improving the feature, and tells them so when handing the code over (their words, 2026-09-17).
-- Every Ask call was already stored in study_ai_chats (0012); what was missing was saying which
-- code asked, and keeping that when the code itself is deleted.
--
--   * pass_id and pass_label on every chat, filled in by ai_chat_log from the call it belongs to,
--     so the Edge Function does not need to know and cannot claim a different code. The label is
--     copied, not looked up later, so deleting a code keeps its conversations readable as whose
--     they were. A chat from the owner or an open visitor has neither.
--   * level and intent: how much care the answer was given and, on auto, what the question was
--     read as. Both are what the next round of improving the feature needs.
--   * admin_pass_chats: one code's conversations, newest first, owner token only.
--   * Nothing here widens who can read a chat. The table stays unreadable with the public key.
--
-- Safe to run twice.

alter table public.study_ai_chats add column if not exists pass_id    bigint;
alter table public.study_ai_chats add column if not exists pass_label text;
alter table public.study_ai_chats add column if not exists level      text;
alter table public.study_ai_chats add column if not exists intent     text;
create index if not exists study_ai_chats_pass on public.study_ai_chats (pass_id, id desc);

-- The chats already stored: their code, where the call still knows it.
update public.study_ai_chats c
   set pass_id = l.pass_id,
       pass_label = (select p.label from public.study_ai_passes p where p.id = l.pass_id)
  from public.study_ai_calls l
 where l.id = c.call_id and l.pass_id is not null and c.pass_id is null;

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
                                     cost_microcents, latency_ms, pass_id, pass_label, level, intent)
  values (
    v_call,
    left(coalesce(p_row ->> 'material', ''), 120),
    left(coalesce(p_row ->> 'feature', 'ask'), 21),
    left(p_row ->> 'install', 64),
    left(p_row ->> 'thread', 64),
    greatest(0, least(coalesce((p_row ->> 'turn')::int, 0), 1000)),
    left(coalesce(p_row ->> 'question', ''), 700),
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
    left(nullif(p_row ->> 'intent', ''), 12)
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- The owner's list, now saying whose each chat was and at what care.
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
                 pass_id, pass_label, level, intent
            from public.study_ai_chats
           where p_before is null or id < p_before
           order by id desc
           limit greatest(1, least(coalesce(p_limit, 50), 500))) t;

  select jsonb_build_object(
           'total', count(*),
           'helpful', count(*) filter (where rating = 1),
           'unhelpful', count(*) filter (where rating = -1),
           'from_codes', count(*) filter (where pass_label is not null),
           'today', count(*) filter (where created_at >= public._ai_day_start()))
    into v_stats
    from public.study_ai_chats;

  return jsonb_build_object('ok', true, 'chats', v_rows, 'stats', v_stats);
end $$;

-- One code's conversations, in full, for the owner.
create or replace function public.admin_pass_chats(p_token text, p_pass_id bigint, p_limit int, p_before bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_rows jsonb; v_n int;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select count(*) into v_n from public.study_ai_chats where pass_id = p_pass_id;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) into v_rows
    from (select id, created_at, material, thread, turn, question, quote, focus, labels, answer, status,
                 rating, level, intent, pass_label, cost_microcents, latency_ms
            from public.study_ai_chats
           where pass_id = p_pass_id and (p_before is null or id < p_before)
           order by id desc
           limit greatest(1, least(coalesce(p_limit, 50), 500))) t;
  return jsonb_build_object('ok', true, 'chats', v_rows, 'total', v_n);
end $$;

revoke all on function public.ai_chat_log(jsonb)                           from public, anon, authenticated;
grant execute on function public.ai_chat_log(jsonb)                        to service_role;
revoke all on function public.admin_ai_chats(text, int, bigint)            from public;
grant execute on function public.admin_ai_chats(text, int, bigint)         to anon;
revoke all on function public.admin_pass_chats(text, bigint, int, bigint)  from public;
grant execute on function public.admin_pass_chats(text, bigint, int, bigint) to anon;
