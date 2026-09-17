-- 0013_ai_passages.sql
--
-- The course textbook as a private index for the owner only Ask feature. The owner decided on
-- 2026-09-17 that Ask may draw on the textbook itself, for a hub used only by them and people
-- they know, with occasional short quotation in answers. To keep that true in practice:
--
--   * The text lives only in this table. It is never written into a material, the repo or a
--     browser. The table is not readable with the public key.
--   * Only the Edge Function reads it, through ai_passages_search (service role), and sends a
--     few short passages to the model with each question, the same way the material's own
--     passages go.
--   * The passages are loaded by study/src/tools/load_passages.mjs from the private copies in
--     study/src/sources/, which are gitignored.
--
-- Safe to run twice.

create table if not exists public.study_ai_passages (
  id       bigserial primary key,
  corpus   text not null,
  chapter  int,
  heading  text,
  ord      int  not null,
  body     text not null,
  tsv      tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || body)) stored,
  unique (corpus, ord)
);
create index if not exists study_ai_passages_tsv on public.study_ai_passages using gin (tsv);
create index if not exists study_ai_passages_corpus on public.study_ai_passages (corpus, chapter);
alter table public.study_ai_passages enable row level security;
revoke all on table public.study_ai_passages from anon, authenticated;
revoke all on sequence public.study_ai_passages_id_seq from anon, authenticated;

-- The best few passages for a question: passages with every word first, then any word,
-- because students ask short vague questions.
create or replace function public.ai_passages_search(p_corpus text, p_query text, p_chapter int, p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_and tsquery; v_or tsquery; v_txt text; v_lim int := greatest(1, least(coalesce(p_limit, 4), 8)); v_out jsonb;
begin
  v_and := plainto_tsquery('english', left(coalesce(p_query, ''), 1000));
  v_txt := v_and::text;
  if v_txt is null or v_txt = '' then return jsonb_build_object('ok', true, 'passages', '[]'::jsonb); end if;
  v_or := replace(v_txt, ' & ', ' | ')::tsquery;

  /* Passages holding every word first, then passages holding some, each ranked by cover
     density, with a small lift for the chapter the student is in. */
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

revoke all on function public.ai_passages_search(text, text, int, int) from public, anon, authenticated;
grant execute on function public.ai_passages_search(text, text, int, int) to service_role;
