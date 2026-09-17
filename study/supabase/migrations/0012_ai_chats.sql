-- 0012_ai_chats.sql
--
-- Saves Ask conversations so the beta can be improved over time: each question and answer,
-- with the context it was answered from and an optional rating. The owner asked for this on
-- 2026-09-17, for a feature that is owner only; the hub's existing terms cover it. If Ask is
-- ever opened beyond the owner, revisit the privacy row in study/README.md first.
--
--   * study_ai_chats: one row per question and answer. Written only by the Edge Function
--     through ai_chat_log (service role). Read only through admin_ai_chats (owner token).
--   * ai_chat_rate: the owner marks an answer helpful or not. Owner token required.
--   * Nothing here is reachable anonymously except the two token guarded RPCs, which answer
--     forbidden without the owner's token (the 0006 coalesce form).
--
-- Safe to run twice.

create table if not exists public.study_ai_chats (
  id          bigserial primary key,
  call_id     bigint,
  created_at  timestamptz not null default now(),
  material    text not null,
  feature     text not null default 'ask',
  install     text,
  thread      text,
  turn        int  not null default 0,
  question    text not null,
  quote       text,
  focus       text,
  labels      jsonb not null default '[]'::jsonb,
  progress    boolean not null default false,
  notes       boolean not null default false,
  answer      text,
  status      text not null default 'ok',
  model       text,
  input_tokens  int,
  output_tokens int,
  cost_microcents bigint,
  latency_ms  int,
  rating      smallint check (rating in (-1, 1)),
  rated_at    timestamptz
);
create index if not exists study_ai_chats_created on public.study_ai_chats (created_at desc);
create index if not exists study_ai_chats_thread  on public.study_ai_chats (thread, turn);
alter table public.study_ai_chats enable row level security;
revoke all on table public.study_ai_chats from anon, authenticated;
revoke all on sequence public.study_ai_chats_id_seq from anon, authenticated;

-- Written by the Edge Function once an answer has finished (or failed). Every text field is
-- clipped here as well as in the function, so a bug upstream cannot store an essay.
create or replace function public.ai_chat_log(p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_id bigint;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_row');
  end if;
  insert into public.study_ai_chats (call_id, material, feature, install, thread, turn, question, quote, focus,
                                     labels, progress, notes, answer, status, model, input_tokens, output_tokens,
                                     cost_microcents, latency_ms)
  values (
    nullif(p_row ->> 'call_id', '')::bigint,
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
    greatest(0, coalesce((p_row ->> 'latency_ms')::int, 0))
  )
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

-- The owner rates one answer: 1 helpful, -1 not, null clears.
create or replace function public.ai_chat_rate(p_token text, p_chat_id bigint, p_rating int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_rating is not null and p_rating not in (-1, 1) then
    return jsonb_build_object('ok', false, 'error', 'range');
  end if;
  update public.study_ai_chats set rating = p_rating, rated_at = case when p_rating is null then null else now() end
   where id = p_chat_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- Recent chats for the owner panel and for export. Newest first, paged by id.
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
                 answer, status, model, input_tokens, output_tokens, cost_microcents, latency_ms, rating
            from public.study_ai_chats
           where p_before is null or id < p_before
           order by id desc
           limit greatest(1, least(coalesce(p_limit, 50), 500))) t;

  select jsonb_build_object(
           'total', count(*),
           'helpful', count(*) filter (where rating = 1),
           'unhelpful', count(*) filter (where rating = -1),
           'today', count(*) filter (where created_at >= public._ai_day_start()))
    into v_stats
    from public.study_ai_chats;

  return jsonb_build_object('ok', true, 'chats', v_rows, 'stats', v_stats);
end $$;

revoke all on function public.ai_chat_log(jsonb)                   from public, anon, authenticated;
revoke all on function public.ai_chat_rate(text, bigint, int)      from public;
revoke all on function public.admin_ai_chats(text, int, bigint)    from public;

grant execute on function public.ai_chat_log(jsonb)                to service_role;
grant execute on function public.ai_chat_rate(text, bigint, int)   to anon;
grant execute on function public.admin_ai_chats(text, int, bigint) to anon;
