-- 0024_ai_trap.sql
--
-- Trap notes: when a student keeps picking the same wrong option on a multiple choice card,
-- the page spends one AI call, ever, on that card. It writes two short lines from the
-- material's own passages (why that option looks right, and the thing that rules it out),
-- keeps them with the student's progress under 'trapnotes', and shows them on every later
-- review of the card with no further call. The call goes through study-ask with
-- purpose 'trap' (README.md beside the function).
--
-- This is only the feature's row. ai_begin2, ai_status2, the ledger, the owner panel's
-- Features group and the per code switches in the passes panel (0017 to 0023) already read
-- every row of study_ai_features, so nothing else changes here.
--
--   * enabled false and mode 'owner': until the owner switches it on in the panel, every
--     call answers 'off' and every page draws nothing.
--   * model and tag are copied from the 'ask' row as it stands when this runs, so trap notes
--     run on the same model and wherever Ask is tagged ('ai-ask'). The second insert covers a
--     database where the 'ask' row is missing, with the values 0011 gave Ask.
--   * daily_cents 10: a note costs about half a cent on Sonnet 4.6. The reserve held while a
--     call is open is sized at the 3000 input token floor ai_begin2 applies (0021), about 1.2
--     cents on Sonnet 4.6 and 2 cents on Opus 5, so ten cents a day is roughly five notes held
--     open at once and fifteen to twenty written.
--   * beyond keeps its default (false). The trap prompt never reads it: the panel shows the
--     switch on this row, and it has no effect here.
--   * A pass set to "everything the owner has" (0021) reaches this feature once it is on, as
--     every later feature does; the owner can switch it off for one code in the passes panel.
--
-- No student or owner text is stored by this migration. Safe to run twice: both inserts do
-- nothing when the row exists, so a second run never undoes the owner's own settings.

insert into public.study_ai_features (id, name, enabled, mode, model, daily_cents, tag, beta)
select 'trap', 'Trap notes', false, 'owner', a.model, 10, a.tag, true
  from public.study_ai_features a
 where a.id = 'ask'
on conflict (id) do nothing;

insert into public.study_ai_features (id, name, enabled, mode, model, daily_cents, tag, beta)
values ('trap', 'Trap notes', false, 'owner', 'claude-sonnet-4-6', 10, 'ai-ask', true)
on conflict (id) do nothing;
