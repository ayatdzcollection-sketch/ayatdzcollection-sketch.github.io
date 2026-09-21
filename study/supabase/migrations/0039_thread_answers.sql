-- 0039: bring back an answer the page never finished receiving.
--
-- Ask keeps its conversations on the device. When the page was closed or reloaded while an
-- answer was still being written, the device had the question and nothing else, and the answer
-- was paid for and lost. From this migration's deploy the Edge Function lets such a call run to
-- its end and ai_chat_log stores the whole answer as it always has. This function is how the
-- page that asked gets it back: the rows of one conversation, for the install that owns it.
--
-- The key is the pair the page made up itself, its 32 hex install id and its 24 hex thread id,
-- the same trust ai_links_list and ai_chat_page already place in the install. Nothing here
-- reaches another device's chats, and nothing but the question, the answer and its status is
-- returned. It never throws.
create or replace function public.ai_thread_answers(p_install text, p_thread text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_rows jsonb;
begin
  if coalesce(p_install, '') !~ '^[0-9a-f]{32}$' or coalesce(p_thread, '') !~ '^ask-[0-9a-f]{24}$' then
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) into v_rows
    from (select c.id, c.turn, left(c.question, 4000) as question, c.answer, c.status, c.created_at
            from public.study_ai_chats c
           where c.install = p_install and c.thread = p_thread
           order by c.id desc
           limit 40) t;
  return jsonb_build_object('ok', true, 'rows', v_rows);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'failed');
end $$;

revoke all on function public.ai_thread_answers(text, text) from public;
grant execute on function public.ai_thread_answers(text, text) to anon;

notify pgrst, 'reload schema';
