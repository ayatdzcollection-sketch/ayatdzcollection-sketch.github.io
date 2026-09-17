-- 0014_ai_spend_reset.sql
--
-- Lets the owner start "today" over for the AI caps without deleting a single ledger row. On
-- 2026-09-17, the morning of a test, the day's Ask budget had been used up by quality testing
-- the night before, and the owner asked for the cap to be reset for the day.
--
--   * study_ai_settings.spend_reset_at: when set and later than midnight UTC, "today" starts
--     there instead. Every daily figure reads the day's start through _ai_day_start(): the
--     global daily cap, each feature's daily cap, the per device count, and the owner panel's
--     today totals. So one timestamp resets all of them together, consistently.
--   * The monthly cap is untouched: a reset gives back the day, never the month.
--   * The next midnight UTC (20:00 in New York during daylight time) is later than any reset
--     made the day before, so a reset lapses on its own.
--   * The ledger keeps every row. Nothing is deleted or rewritten.
--
-- To reset (Supabase SQL editor, or the Management API query endpoint):
--   update public.study_ai_settings set spend_reset_at = now() where id = 1;
--
-- Safe to run twice.

alter table public.study_ai_settings add column if not exists spend_reset_at timestamptz;

create or replace function public._ai_day_start()
returns timestamptz
language sql
stable
set search_path = pg_catalog, public
as $$
  select greatest(
    date_trunc('day', (now() at time zone 'utc')) at time zone 'utc',
    coalesce((select s.spend_reset_at from public.study_ai_settings s where s.id = 1), '-infinity'::timestamptz)
  );
$$;

revoke all on function public._ai_day_start() from public, anon, authenticated;
