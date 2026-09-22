-- 0041: Ask may draw on the student's other materials.
--
-- The owner's decision, 2026-09-22. Every material already tells Ask what it knows: its adapter's
-- docs() is the list of labelled passages the page searches for a question asked inside it.
-- study/src/tools/build_hub_index.mjs stores that same list, for every material, in the private
-- passages table under the corpus 'mat:<class>/<id>' (heading "<short title>: <label>"). This is
-- the search over all of them at once, leaving out the material the question was asked in, whose
-- own passages the page has already sent.
--
-- What makes a passage worth sending from somewhere else. A passage that holds any one word of the
-- question is not: "correct" and "question" are in half the hub. So each word of the question is
-- weighted by how rare it is across the hub (the same idf the page's own search uses), and a
-- passage comes back only when it holds at least 60 per cent of that weight. It is a share, not a
-- score, so it reads the same whatever the question and however large the hub grows.
-- At most two passages from any one material, the asking material's own class first on a tie.
--
-- Service role only, like every other passage function: the text is read by the Edge Function and
-- never by a page. It never throws. No em dashes and no en dashes.
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
                   from unnest(v_lex) w) d),
       tot as (select sum(idf) as s from lex),
       cand as (
         select p.corpus, p.heading, p.body,
                (select coalesce(sum(lex.idf), 0) from lex where lex.w = any(tsvector_to_array(p.tsv)))
                  / nullif((select s from tot), 0) as share,
                ts_rank_cd(p.tsv, v_or, 32) as score,
                split_part(substr(p.corpus, 5), '/', 1) = v_class as same_class
           from public.study_ai_passages p
          where p.corpus like 'mat:%' and p.corpus <> v_ex and p.tsv @@ v_or),
       ranked as (
         select c.*, row_number() over (partition by c.corpus order by c.share desc, c.score desc) as rn
           from cand c
          where c.share >= 0.6)
  select coalesce(jsonb_agg(jsonb_build_object('material', substr(t.corpus, 5), 'heading', t.heading, 'body', t.body,
                                               'share', round(t.share::numeric, 2))
                            order by t.share desc, t.same_class desc, t.score desc), '[]'::jsonb)
    into v_out
    from (select * from ranked where rn <= 2 order by share desc, same_class desc, score desc limit v_lim) t;

  return jsonb_build_object('ok', true, 'passages', v_out);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.ai_passages_search_hub(text, text, int) from public, anon, authenticated;
grant execute on function public.ai_passages_search_hub(text, text, int) to service_role;

notify pgrst, 'reload schema';
