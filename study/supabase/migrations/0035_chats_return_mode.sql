-- 0035: let the owner read which mode a chat was asked in.
--
-- 0034 added study_ai_chats.mode and the Edge Function has written it since, so the column is
-- correct and full. Nothing ever read it back: admin_ai_chats, last replaced in 0032, selects a
-- fixed list of columns and mode was never added to it. The panel therefore cannot tell a
-- research answer from an ordinary one, which is the one thing 0034 added the column for.
--
-- The chat log also recorded the constant 'ask' whatever the call was billed to. That half is
-- fixed in the Edge Function, not here; this side only has to hand both columns back.
--
-- As 0032 otherwise, line for line, with 'mode' added to the select list.
-- No em dashes and no en dashes.

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
                 rerank, tool_round, retry, source_step, flags, flag_kinds, mode
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
           'today', count(*) filter (where created_at >= public._ai_day_start()),
           -- How many of the stored chats were asked in a research mode, so the Chats line can
           -- say so without reading every row.
           'research', count(*) filter (where coalesce(mode, '') not in ('', 'material')))
    into v_stats
    from public.study_ai_chats;

  return jsonb_build_object('ok', true, 'chats', v_rows, 'stats', v_stats);
end $$;

revoke all on function public.admin_ai_chats(text, int, bigint)     from public;
grant execute on function public.admin_ai_chats(text, int, bigint)  to anon;
