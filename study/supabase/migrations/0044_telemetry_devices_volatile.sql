-- 0044_telemetry_devices_volatile.sql
--
-- 0043 marked admin_telemetry_devices stable, and every call then failed with "cannot execute
-- UPDATE in a read-only transaction": _auth_role stamps the session's last_seen when it checks
-- the token, and a stable function runs read only. The function reads study_reviews and nothing
-- else; the one write is that stamp. 0043 has been corrected for anyone running it fresh.
--
-- Safe to run twice.

alter function public.admin_telemetry_devices(text) volatile;

notify pgrst, 'reload schema';
