-- 0046_telemetry_events.sql
--
-- What happens around the answers, so the owner can tell "done" from "fed up" from "it broke",
-- and one device from two. Asked for on 2026-09-22 after the device breakdown (0043 to 0045)
-- showed 38 devices that are not the owner's, almost all used once, and nothing to say why.
--
-- Two tables, both written only through telemetry_events and read only by the owner:
--
--   study_devices  one row per install id: when the server first and last heard from it, and
--                  a coarse description of the browser it runs in (see below). Enough to say
--                  "an iPhone, Safari 18, added to the Home Screen" or "opened inside Snapchat",
--                  and to notice that a brand new install looks exactly like one that went quiet
--                  last week. Nothing that names anybody: no IP address is stored, no name, no
--                  code, no session token.
--   study_events   what a page did: opened, hidden, shown, closed (with how long it was actually
--                  in front of the student and how many answers it took), the screen it was on
--                  when it was left, a script error, the rough start suggestion, the after the
--                  quiz check in. The answers themselves stay in study_reviews.
--
-- The device description the client sends (all optional, all short):
--   os, osv        operating system and its major version: 'ios' 18, 'android' 15, 'mac' ...
--   br, brv        browser and its major version: 'safari' 18, 'chrome' 129 ...
--   app            the app a link was opened inside, if any: 'snapchat', 'instagram' ...
--   kind           'phone' | 'tablet' | 'desktop'
--   standalone     opened from the Home Screen
--   scr, dpr       screen size in CSS pixels and pixel ratio: a stand in for the model
--   tz, lang       time zone and language
--   persisted      whether the browser granted persistent storage
--   owner          this browser holds the owner's session (so the owner's own devices label
--                  themselves from now on)
--   local          the page came from a local test server, not the live site
--   id             how this install id was found: 'ls' in localStorage as usual, 'cookie' or
--                  'idb' recovered from a copy after localStorage was cleared, 'new' minted
--   born           when the id was minted on the device
--   prior          signs the browser had been here before the id was minted: 'sw' a service
--                  worker was already running the page, 'cache' the offline cache had files,
--                  'store' other hub data was already in localStorage. A new id with prior
--                  signs is the same browser with its storage wiped, not a new person.
--   person         a random id that travels with the save code, so two paired devices share
--                  it. Never derived from the code.
--
-- Safe to run twice.

create table if not exists public.study_devices (
  install     text primary key,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  profile     jsonb,
  persons     text[] not null default '{}'
);
alter table public.study_devices enable row level security;
revoke all on public.study_devices from anon, authenticated;

create table if not exists public.study_events (
  id          bigserial primary key,
  install     text        not null,
  page        text        not null,          -- random per page load, so one visit reads as one
  kind        text        not null,
  material    text,
  at          timestamptz not null,
  data        jsonb,
  received_at timestamptz not null default now()
);
alter table public.study_events enable row level security;
revoke all on public.study_events from anon, authenticated;
revoke all on sequence public.study_events_id_seq from anon, authenticated;

-- A batch resent after a dropped response must not double count.
create unique index if not exists study_events_dedupe
  on public.study_events (install, page, kind, at);
create index if not exists study_events_install_at on public.study_events (install, at);

create or replace function public.telemetry_events(p_install text, p_device jsonb, p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_count  int;
  v_person text;
begin
  if p_install is null or length(p_install) < 8 or length(p_install) > 64 then
    return jsonb_build_object('ok', false, 'error', 'bad_install');
  end if;
  if p_events is not null and jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'bad_events');
  end if;
  if p_events is not null and jsonb_array_length(p_events) > 300 then
    return jsonb_build_object('ok', false, 'error', 'too_many');
  end if;

  -- The description is small by construction; anything big is not ours and is dropped.
  if p_device is not null and (jsonb_typeof(p_device) <> 'object' or length(p_device::text) > 1500) then
    p_device := null;
  end if;
  v_person := left(nullif(p_device ->> 'person', ''), 40);

  insert into public.study_devices as d (install, profile, persons)
  values (p_install, p_device - 'person', case when v_person is null then '{}'::text[] else array[v_person] end)
  on conflict (install) do update
     set last_seen = now(),
         profile   = coalesce(excluded.profile, d.profile),
         persons   = case
                       when v_person is null or v_person = any(d.persons) or cardinality(d.persons) >= 10
                         then d.persons
                       else d.persons || v_person
                     end;

  if p_events is null or jsonb_array_length(p_events) = 0 then
    return jsonb_build_object('ok', true, 'stored', 0);
  end if;

  insert into public.study_events (install, page, kind, material, at, data)
  select
    p_install,
    left(e ->> 'p', 40),
    left(e ->> 'k', 20),
    left(nullif(e ->> 'm', ''), 120),
    to_timestamp(((e ->> 't')::numeric) / 1000),
    case when e -> 'd' is not null and jsonb_typeof(e -> 'd') = 'object' and length((e -> 'd')::text) <= 1500
         then e -> 'd' else null end
  from jsonb_array_elements(p_events) as e
  where e ->> 'p' is not null
    and e ->> 'k' in ('open', 'hide', 'show', 'close', 'screen', 'error', 'nudge', 'checkin')
    and e ->> 't' is not null
    and to_timestamp(((e ->> 't')::numeric) / 1000)
        between now() - interval '60 days' and now() + interval '1 day'
  on conflict (install, page, kind, at) do nothing;

  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'stored', v_count);
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.telemetry_events(text, jsonb, jsonb) from public;
grant execute on function public.telemetry_events(text, jsonb, jsonb) to anon;

notify pgrst, 'reload schema';
