-- 0042: the other materials search, measured against the live index and corrected.
--
-- 0041 kept a passage holding 60 per cent of the question's weight. Tried on the loaded index
-- (3,785 passages) it failed both ways: "what did the puritans believe" found nothing, because the
-- materials say "beliefs" (a different stem) and Puritan alone is 55 per cent of that question;
-- and "is this correct" found three random quiz questions, because "correct" is in every answer
-- key. Two changes, both relative, never a fixed score:
--   - a word found in more than a tenth of the hub carries no weight at all (like a stopword), and
--     a question left with no weighted word finds nothing;
--   - a passage needs half the question's weight AND at least 80 per cent of the best passage's
--     share, so a weak neighbour of a strong hit is left out ("significant figures work" also
--     found a painting of 1492 at 0.61 beside the sig figs card at 0.83);
--   - on a tie, the passage whose own heading carries the question's words first: "who was abigail
--     williams" found three other characters' cards that mention her before her own.
-- No em dashes and no en dashes.
create or replace function public.ai_passages_search_hub(p_exclude text, p_query text, p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_lex   text[];
  v_or    tsquery;
  v_n     int;
  v_lim   int  := greatest(1, least(coalesce(p_limit, 3), 12));
  v_ex    text := left(coalesce(p_exclude, ''), 120);
  v_class text := split_part(substr(left(coalesce(p_exclude, ''), 120), 5), '/', 1);
  v_out   jsonb;
begin
  select coalesce(array_agg(distinct l.lexeme), '{}'::text[]) into v_lex
    from unnest(to_tsvector('english', left(coalesce(p_query, ''), 1000))) l;
  v_lex := v_lex[1:16];
  if cardinality(v_lex) = 0 then return jsonb_build_object('ok', true, 'passages', '[]'::jsonb); end if;
  v_or := array_to_string(array(select quote_literal(w) from unnest(v_lex) w), ' | ')::tsquery;

  select count(*) into v_n from public.study_ai_passages where corpus like 'mat:%';
  if v_n = 0 then return jsonb_build_object('ok', true, 'passages', '[]'::jsonb); end if;

  with lex as (
         select d.w, ln(1 + (v_n - d.df + 0.5) / (d.df + 0.5)) as idf
           from (select w, (select count(*) from public.study_ai_passages p
                             where p.corpus like 'mat:%' and p.tsv @@ quote_literal(w)::tsquery) as df
                   from unnest(v_lex) w) d
          where d.df * 10 <= v_n),
       tot as (select sum(idf) as s from lex),
       cand as (
         select p.corpus, p.heading, p.body,
                (select coalesce(sum(lex.idf), 0) from lex where lex.w = any(tsvector_to_array(p.tsv)))
                  / nullif((select s from tot), 0) as share,
                (select coalesce(sum(lex.idf), 0) from lex where lex.w = any(tsvector_to_array(to_tsvector('english', coalesce(p.heading, '')))))
                  / nullif((select s from tot), 0) as head,
                ts_rank_cd(p.tsv, v_or, 32) as score,
                split_part(substr(p.corpus, 5), '/', 1) = v_class as same_class
           from public.study_ai_passages p
          where p.corpus like 'mat:%' and p.corpus <> v_ex and p.tsv @@ v_or
            and exists (select 1 from lex)),
       best as (select max(share) as b from cand),
       ranked as (
         select c.*, row_number() over (partition by c.corpus order by c.share desc, c.head desc, c.score desc) as rn
           from cand c, best
          where c.share >= 0.5 and c.share >= 0.8 * best.b)
  select coalesce(jsonb_agg(jsonb_build_object('material', substr(t.corpus, 5), 'heading', t.heading, 'body', t.body,
                                               'share', round(t.share::numeric, 2))
                            order by t.share desc, t.head desc, t.same_class desc, t.score desc), '[]'::jsonb)
    into v_out
    from (select * from ranked where rn <= 2 order by share desc, head desc, same_class desc, score desc limit v_lim) t;

  return jsonb_build_object('ok', true, 'passages', v_out);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.ai_passages_search_hub(text, text, int) from public, anon, authenticated;
grant execute on function public.ai_passages_search_hub(text, text, int) to service_role;

notify pgrst, 'reload schema';
