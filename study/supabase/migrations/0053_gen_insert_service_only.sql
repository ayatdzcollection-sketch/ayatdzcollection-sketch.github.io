-- 0053: gen_insert and _gen_sweep are for the server only (fix to 0052, 2026-09-26).
--
-- 0052 revoked them from public, but Supabase's default privileges also grant EXECUTE on every
-- new function in the public schema to anon and authenticated directly, so a visitor could call
-- gen_insert and add questions every student would see. Found by an anonymous probe right after
-- 0052 was applied, before any row existed (study_gen_items was empty). The sweep is harmless but
-- has no reason to be callable either. No em dashes and no en dashes.
revoke all on function public.gen_insert(text, text, text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.gen_insert(text, text, text, jsonb, bigint) to service_role;
revoke all on function public._gen_sweep(text) from public, anon, authenticated;
