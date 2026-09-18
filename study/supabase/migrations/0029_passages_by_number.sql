-- 0029_passages_by_number.sql
--
-- A private passage fetched by its number, for the chemistry review form. The owner asked on
-- 2026-09-17 that Ask may use the teacher's review form for the measurement unit test ("Scientific
-- Measurement Unit Test Form") the way it uses the APUSH textbook (0013): the text lives only in
-- study_ai_passages, as corpus 'chem-unit-form', one row per question with the answer key, and is
-- read only by the Edge Function for callers ai_begin2 grants the textbook to.
--
--   * A question asked by its number ("what is question 22") should get that question, not the
--     best keyword match, so this returns rows by number. ord is the question number times ten,
--     plus 1 to 3 for a lettered part (33a is 331), so asking for 33 returns 33a, 33b and 33c.
--   * Service role only, like ai_passages_search: the public key can read none of it.
--
-- Safe to run twice.

create or replace function public.ai_passages_get(p_corpus text, p_ords int[])
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_out jsonb;
begin
  if p_ords is null or cardinality(p_ords) = 0 then return jsonb_build_object('ok', true, 'passages', '[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object('chapter', p.chapter, 'heading', p.heading, 'body', p.body) order by p.ord), '[]'::jsonb)
    into v_out
    from (select * from public.study_ai_passages
           where corpus = left(coalesce(p_corpus, ''), 60)
             and (ord / 10) = any (p_ords[1:4])
           order by ord
           limit 8) p;
  return jsonb_build_object('ok', true, 'passages', v_out);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.ai_passages_get(text, int[]) from public, anon, authenticated;
grant execute on function public.ai_passages_get(text, int[]) to service_role;

notify pgrst, 'reload schema';
