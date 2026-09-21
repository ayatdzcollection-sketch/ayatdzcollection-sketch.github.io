-- 0038: what is on the class shelf, by name.
--
-- Research mode's "Class sources" answers from the documents the owner loaded for a class
-- (corpus shelf-<class> in study_ai_passages). Ask settings said so and never said which
-- documents those were, so the student could not tell a thin shelf from a full one before
-- asking. This lists them: each document's name, how many passages it came to, and the section
-- names inside it. A shelf heading is "<document>: <section>", which is what the loader writes.
--
-- It never reads a passage body out, the same rule ai_links_list keeps, and it answers only a
-- caller ai_status2 would let use research mode on that material: the owner, a pass that
-- carries it, or anyone when the feature is open. It never throws.
create or replace function public.ai_shelf_list(p_material text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_st jsonb; v_cls text; v_rows jsonb;
begin
  v_st := public.ai_status2(p_material, 'research', p_token);
  if coalesce((v_st->>'may')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'error', coalesce(v_st->>'why', 'unavailable'));
  end if;
  v_cls := split_part(left(trim(coalesce(p_material, '')), 120), '/', 1);
  if v_cls !~ '^[a-z0-9-]{1,40}$' then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  select coalesce(jsonb_agg(to_jsonb(t) order by t.first_ord), '[]'::jsonb) into v_rows
    from (select d.doc, count(*)::int as passages, sum(length(d.body))::int as chars, min(d.ord) as first_ord,
                 (array_agg(d.sec order by d.ord) filter (where d.sec <> ''))[1:40] as sections
            from (select case when position(': ' in coalesce(p.heading, '')) > 0
                               then left(p.heading, position(': ' in p.heading) - 1)
                               else coalesce(nullif(p.heading, ''), 'Untitled') end as doc,
                         case when position(': ' in coalesce(p.heading, '')) > 0
                               then substr(p.heading, position(': ' in p.heading) + 2) else '' end as sec,
                         p.body, p.ord
                    from public.study_ai_passages p
                   where p.corpus = 'shelf-' || v_cls) d
           group by d.doc
           limit 40) t;
  return jsonb_build_object('ok', true, 'class', v_cls, 'docs', v_rows);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'failed');
end $$;

revoke all on function public.ai_shelf_list(text, text) from public;
grant execute on function public.ai_shelf_list(text, text) to anon;

notify pgrst, 'reload schema';
