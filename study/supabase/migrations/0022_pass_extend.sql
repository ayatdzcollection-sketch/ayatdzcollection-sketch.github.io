-- 0022_pass_extend.sql
--
-- Changing when a live code ends, without ending it and making a new one.
--
--   * extend_hours adds to the end a code already has, rather than counting from now, so
--     pressing "one more hour" at 5:30 on a code that ends at 6:00 leaves it ending at 7:00. On a
--     code that has already lapsed it counts from now instead, which is the only reading that
--     makes sense for bringing one back. A code with no end at all is left alone: adding an hour
--     to "never" is not an extension, and the panel asks for a time instead.
--   * when 'local' takes a wall clock time the owner typed and reads it in their own zone, so a
--     device with a wrong clock cannot move a code's end. Nothing here trusts a browser's idea of
--     now: the only thing that crosses is the text the owner typed.
--   * Everything else about an end stays as it was in 0019 and 0021: morning, hours from now,
--     none, now, and an explicit instant.
--
-- Safe to run twice.

create or replace function public.admin_pass_set(p_token text, p_pass jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare v_role text; p public.study_ai_passes; v_when text; v_feats text[]; v_exp timestamptz; v_hours numeric;
        v_name text; v_on boolean; v_from timestamptz;
begin
  v_role := public._auth_role(p_token);
  if coalesce(v_role, '') <> 'admin' then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_pass is null or jsonb_typeof(p_pass) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'bad_pass');
  end if;

  select * into p from public.study_ai_passes where id = (p_pass ->> 'id')::bigint for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;

  if p_pass ? 'enabled' then
    if jsonb_typeof(p_pass -> 'enabled') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'enabled');
    end if;
    p.enabled := (p_pass ->> 'enabled')::boolean;
  end if;

  if p_pass ? 'all_features' then
    if jsonb_typeof(p_pass -> 'all_features') <> 'boolean' then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'all_features');
    end if;
    p.all_features := (p_pass ->> 'all_features')::boolean;
  end if;

  if p_pass ? 'feature' then
    v_name := left(trim(coalesce(p_pass ->> 'feature', '')), 21);
    if v_name = '' or not (v_name = 'textbook' or exists (select 1 from public.study_ai_features f where f.id = v_name)) then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'feature');
    end if;
    v_on := coalesce((p_pass ->> 'on')::boolean, false);
    if v_on then
      p.denied := array_remove(coalesce(p.denied, '{}'), v_name);
      if not (v_name = any (coalesce(p.features, '{}'))) then
        p.features := coalesce(p.features, '{}') || v_name;
      end if;
    else
      if not (v_name = any (coalesce(p.denied, '{}'))) then
        p.denied := coalesce(p.denied, '{}') || v_name;
      end if;
      p.features := array_remove(coalesce(p.features, '{}'), v_name);
    end if;
  end if;

  if p_pass ? 'label' then p.label := left(trim(coalesce(p_pass ->> 'label', p.label)), 60); end if;
  if p_pass ? 'note'  then p.note  := left(trim(coalesce(p_pass ->> 'note', '')), 200); end if;

  if jsonb_typeof(p_pass -> 'add_cents') = 'number' then
    p.budget_microcents := greatest(0, least(
      p.budget_microcents + ((p_pass ->> 'add_cents')::numeric * 1000000)::bigint,
      10000::bigint * 1000000));
  end if;
  if jsonb_typeof(p_pass -> 'budget_cents') = 'number' then
    p.budget_microcents := (greatest(0, least((p_pass ->> 'budget_cents')::numeric, 10000)) * 1000000)::bigint;
  end if;

  if p_pass ? 'daily_cents' then
    if jsonb_typeof(p_pass -> 'daily_cents') = 'null' then p.daily_cents := null;
    elsif jsonb_typeof(p_pass -> 'daily_cents') = 'number' then
      p.daily_cents := greatest(0, least((p_pass ->> 'daily_cents')::int, 10000));
    else return jsonb_build_object('ok', false, 'error', 'range', 'field', 'daily_cents'); end if;
  end if;

  if jsonb_typeof(p_pass -> 'per_minute') = 'number' then
    p.per_minute := greatest(1, least((p_pass ->> 'per_minute')::int, 60));
  end if;

  if jsonb_typeof(p_pass -> 'features') = 'array' then
    v_feats := public._ai_pass_feats(p_pass -> 'features');
    if v_feats is null or array_length(v_feats, 1) is null then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'features');
    end if;
    p.features := v_feats;
    p.denied := '{}';
  end if;

  if coalesce((p_pass ->> 'revive')::boolean, false) then
    v_when := lower(trim(coalesce(p_pass ->> 'when', '')));
    if v_when not in ('morning', 'hours', 'at', 'local') then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'when');
    end if;
    p.revoked_at := null;
    p.enabled := true;
  end if;

  /* Add to the end it already has. A code that has lapsed counts from now; a code with no end is
     left alone, because "never" plus an hour is not an extension. */
  if jsonb_typeof(p_pass -> 'extend_hours') = 'number' then
    if p.expires_at is null then
      return jsonb_build_object('ok', false, 'error', 'range', 'field', 'extend_hours');
    end if;
    v_hours := greatest(-720, least((p_pass ->> 'extend_hours')::numeric, 720));
    v_from := greatest(p.expires_at, now());
    p.expires_at := v_from + (v_hours * interval '1 hour');
  end if;

  if p_pass ? 'when' then
    v_when := lower(trim(coalesce(p_pass ->> 'when', '')));
    if v_when = 'morning' then p.expires_at := public._ai_pass_morning();
    elsif v_when = 'hours' then
      v_hours := greatest(0.25, least(coalesce((p_pass ->> 'hours')::numeric, 3), 720));
      p.expires_at := now() + (v_hours * interval '1 hour');
    elsif v_when = 'local' then
      /* A wall clock time the owner typed, read in their own zone. The browser's clock plays no
         part: only the characters they typed cross the wire. */
      begin
        p.expires_at := (left(trim(coalesce(p_pass ->> 'local', '')), 19)::timestamp at time zone 'America/Detroit');
      exception when others then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'local');
      end;
      if p.expires_at is null then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'local');
      end if;
    elsif v_when = 'none' then p.expires_at := null;
    elsif v_when = 'now' then p.expires_at := now();
    else
      if not (p_pass ? 'expires_at') then
        return jsonb_build_object('ok', false, 'error', 'range', 'field', 'when');
      end if;
      v_exp := (p_pass ->> 'expires_at')::timestamptz;
      if v_exp is null then return jsonb_build_object('ok', false, 'error', 'range', 'field', 'expires_at'); end if;
      p.expires_at := v_exp;
    end if;
  end if;

  if coalesce((p_pass ->> 'revoke')::boolean, false) then
    p.revoked_at := now();
    p.enabled := false;
  end if;

  update public.study_ai_passes
     set label = p.label, note = p.note, enabled = p.enabled, features = p.features, denied = p.denied,
         all_features = p.all_features, budget_microcents = p.budget_microcents, daily_cents = p.daily_cents,
         per_minute = p.per_minute, expires_at = p.expires_at, revoked_at = p.revoked_at
   where id = p.id;

  if p.revoked_at is not null then
    update public.study_sessions set revoked = true where pass_id = p.id and not revoked;
  end if;

  select * into p from public.study_ai_passes where id = p.id;
  return jsonb_build_object('ok', true, 'pass', jsonb_build_object(
    'id', p.id, 'label', p.label, 'enabled', p.enabled, 'live', public._ai_pass_live(p.*),
    'features', to_jsonb(p.features), 'denied', to_jsonb(p.denied), 'all_features', p.all_features,
    'may_ask', public._ai_pass_may(p.*, 'ask'), 'may_book', public._ai_pass_may(p.*, 'textbook'),
    'expires_at', p.expires_at, 'revoked_at', p.revoked_at,
    'daily_cents', p.daily_cents, 'per_minute', p.per_minute,
    'budget_cents', round(p.budget_microcents::numeric / 1000000, 2),
    'spent_cents', round(public._ai_pass_spent(p.id)::numeric / 1000000, 2),
    'left_cents', round(greatest(p.budget_microcents - public._ai_pass_spent(p.id), 0)::numeric / 1000000, 2)),
    'now', now());
exception when others then
  return jsonb_build_object('ok', false, 'error', 'rejected');
end $$;

revoke all on function public.admin_pass_set(text, jsonb) from public;
grant execute on function public.admin_pass_set(text, jsonb) to anon;
