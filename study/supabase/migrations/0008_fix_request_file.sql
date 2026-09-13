-- Fix: admin_request_file could not read any file.
--
-- Run this in the Supabase dashboard SQL editor, after 0007_requests.sql. It replaces one
-- function and changes nothing else.
--
-- substring on bytea takes integer positions, and 0007 passed p_offset + 1 as bigint, so
-- every call failed with "function pg_catalog.substring(bytea, bigint, integer) does not
-- exist". The positions are cast to int; files are capped at 20 MB, far inside int range.

create or replace function public.admin_request_file(p_token text, p_file uuid, p_offset bigint, p_len int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; v_data bytea;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;

  select data into v_data from public.study_request_files where id = p_file;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  return jsonb_build_object(
    'ok', true,
    'b64', encode(substring(v_data from (greatest(coalesce(p_offset, 0), 0) + 1)::int for least(coalesce(p_len, 0), 2000000)::int), 'base64'),
    'total', octet_length(v_data)
  );
end $$;
