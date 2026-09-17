-- 0018_tickets.sql
--
-- Bug reports, from anywhere, by anyone. The owner asked on 2026-09-17 for a ticket that is
-- specific rather than "it broke": a report carries what was on screen when it was made, and an
-- answer reported from Ask carries the question, the answer and the passages it was built from,
-- so the fix does not depend on anyone remembering.
--
--   * Anyone may file one: the hub is open, and a visitor who hits a bug is the person most worth
--     hearing from. Nothing here is readable without the owner's token.
--   * ticket_add is rate limited per address, clips every field, and stores no text the page did
--     not put in it. A report never carries a token, a code or a sync code.
--   * context is a small json object the page fills in: the tab, the card, the chat id, the
--     material's version. It is capped in size and stored as sent.
--   * Tickets are for reports. The AI conversations themselves stay in study_ai_chats (0012).
--
-- Safe to run twice.

create table if not exists public.study_tickets (
  id         bigserial primary key,
  created_at timestamptz not null default now(),
  material   text,
  kind       text not null default 'other' check (kind in ('material', 'answer', 'app', 'other')),
  summary    text not null,
  body       text,
  context    jsonb not null default '{}'::jsonb,
  install    text,
  ip         text,
  by_role    text not null default 'visitor' check (by_role in ('owner', 'pass', 'visitor')),
  pass_id    bigint,
  status     text not null default 'open' check (status in ('open', 'fixed', 'wontfix')),
  note       text,
  updated_at timestamptz
);
create index if not exists study_tickets_open on public.study_tickets (status, id desc);
alter table public.study_tickets enable row level security;
revoke all on table public.study_tickets from anon, authenticated;
revoke all on sequence public.study_tickets_id_seq from anon, authenticated;

-- Twenty reports an hour from one address is far past honest use and far under a person who is
-- really hitting a bug over and over.
create or replace function public.ticket_add(p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_ip text := left(coalesce(public._auth_ip(), ''), 64);
  v_role text := 'visitor'; v_pass_id bigint; v_id bigint; v_n int; p public.study_ai_passes;
  v_token text;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_row');
  end if;
  if length(trim(coalesce(p_row ->> 'summary', ''))) < 3 then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;

  select count(*) into v_n from public.study_tickets t
   where t.ip = v_ip and t.created_at > now() - interval '1 hour';
  if v_n >= 20 then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;

  /* Who filed it, as far as the server can tell. A wrong or missing token just means visitor. */
  v_token := p_row ->> 'token';
  if coalesce(public._auth_role(v_token), '') = 'admin' then v_role := 'owner';
  else
    p := public._auth_pass(v_token);
    if p.id is not null then v_role := 'pass'; v_pass_id := p.id; end if;
  end if;

  insert into public.study_tickets (material, kind, summary, body, context, install, ip, by_role, pass_id)
  values (
    left(nullif(trim(coalesce(p_row ->> 'material', '')), ''), 120),
    case when p_row ->> 'kind' in ('material', 'answer', 'app', 'other') then p_row ->> 'kind' else 'other' end,
    left(trim(p_row ->> 'summary'), 200),
    left(nullif(trim(coalesce(p_row ->> 'body', '')), ''), 2000),
    case when jsonb_typeof(p_row -> 'context') = 'object' and length(p_row -> 'context' #>> '{}') <= 4000
         then p_row -> 'context' else '{}'::jsonb end,
    left(nullif(trim(coalesce(p_row ->> 'install', '')), ''), 64),
    v_ip, v_role, v_pass_id)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

create or replace function public.admin_tickets(p_token text, p_status text, p_limit int, p_before bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_rows jsonb; v_stats jsonb; v_status text := nullif(trim(coalesce(p_status, '')), '');
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.id desc), '[]'::jsonb) into v_rows
    from (select id, created_at, material, kind, summary, body, context, by_role, status, note, updated_at
            from public.study_tickets
           where (v_status is null or status = v_status)
             and (p_before is null or id < p_before)
           order by id desc
           limit greatest(1, least(coalesce(p_limit, 30), 200))) t;

  select jsonb_build_object(
           'open',   count(*) filter (where status = 'open'),
           'fixed',  count(*) filter (where status = 'fixed'),
           'total',  count(*))
    into v_stats from public.study_tickets;

  return jsonb_build_object('ok', true, 'tickets', v_rows, 'stats', v_stats);
end $$;

create or replace function public.admin_ticket_set(p_token text, p_id bigint, p_status text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status is not null and p_status not in ('open', 'fixed', 'wontfix') then
    return jsonb_build_object('ok', false, 'error', 'range', 'field', 'status');
  end if;
  update public.study_tickets
     set status = coalesce(p_status, status),
         note = case when p_note is null then note else left(p_note, 500) end,
         updated_at = now()
   where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_ticket_delete(p_token text, p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  delete from public.study_tickets where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.ticket_add(jsonb)                         from public;
revoke all on function public.admin_tickets(text, text, int, bigint)    from public;
revoke all on function public.admin_ticket_set(text, bigint, text, text) from public;
revoke all on function public.admin_ticket_delete(text, bigint)         from public;

grant execute on function public.ticket_add(jsonb)                          to anon;
grant execute on function public.admin_tickets(text, text, int, bigint)     to anon;
grant execute on function public.admin_ticket_set(text, bigint, text, text) to anon;
grant execute on function public.admin_ticket_delete(text, bigint)          to anon;
