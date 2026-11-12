begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- A phone whose register acknowledgement was lost knows only its own installation id, not the device id.
-- Revokes the caller's own registration for that installation; another user's installation is never touched.
create function app_private.revoke_my_family_push_installation(p_role text, p_installation_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare actor uuid := app_private.family_notification_actor(p_role); device uuid;
begin
  if p_installation_id is null then raise exception 'Choose valid native device details.' using errcode = '22023'; end if;
  -- Waits for an in-flight registration of the same installation so its row is revoked, not missed.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family_push_installation:' || p_installation_id::text, 0));
  select id into device from app_private.family_push_devices
    where installation_id = p_installation_id and user_id = actor and recipient_role = p_role;
  if device is null then return false; end if;
  return app_private.revoke_my_family_push_device(p_role, device);
end;
$$;

create function public.revoke_my_family_push_installation(p_role text, p_installation_id uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select app_private.revoke_my_family_push_installation(p_role, p_installation_id); $$;

revoke all on function app_private.revoke_my_family_push_installation(text, uuid), public.revoke_my_family_push_installation(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function app_private.revoke_my_family_push_installation(text, uuid), public.revoke_my_family_push_installation(text, uuid)
  to authenticated;

commit;
