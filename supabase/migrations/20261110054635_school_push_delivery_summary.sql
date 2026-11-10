begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create index family_push_jobs_school_pending
  on app_private.family_push_jobs(school_id, expires_at)
  where status in ('queued', 'leased');

create index family_push_jobs_school_finished
  on app_private.family_push_jobs(school_id, finished_at)
  where status in ('accepted', 'failed', 'cancelled');

create function app_private.get_school_push_delivery_summary(p_school_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  observed_at timestamptz := statement_timestamp();
begin
  if actor is null or not exists (
    select 1 from public.profiles profile
    join public.schools school on school.id = profile.school_id and school.is_active
    join public.user_roles membership on membership.user_id = profile.id
      and membership.school_id = school.id and membership.role in ('school_admin', 'principal')
    where profile.id = actor and profile.is_active and school.id = p_school_id
  ) then
    raise exception 'Current School Admin or Principal access is required.' using errcode = '42501';
  end if;

  if auth.jwt()->>'aal' is distinct from 'aal2' or not app_private.staff_mfa_allowed() then
    raise exception 'Verify your authenticator to view mobile push delivery.' using errcode = '42501';
  end if;

  return (
    select jsonb_build_object('counts', jsonb_build_object(
      'queued', count(*) filter (where job.status = 'queued' or (job.status = 'leased' and job.lease_until <= observed_at)),
      'leased', count(*) filter (where job.status = 'leased' and job.lease_until > observed_at),
      'accepted', count(*) filter (where job.status = 'accepted'),
      'failed', count(*) filter (where job.status = 'failed'),
      'cancelled', count(*) filter (where job.status = 'cancelled')
    ))
    from app_private.family_push_jobs job
    where job.school_id = p_school_id
      and ((job.status in ('queued', 'leased') and job.expires_at > observed_at)
        or (job.status in ('accepted', 'failed', 'cancelled') and job.finished_at >= observed_at - interval '7 days'))
  );
end;
$$;

create function public.get_school_push_delivery_summary(p_school_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.get_school_push_delivery_summary(p_school_id); $$;

revoke all on function app_private.get_school_push_delivery_summary(uuid),
  public.get_school_push_delivery_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function app_private.get_school_push_delivery_summary(uuid),
  public.get_school_push_delivery_summary(uuid) to authenticated;

notify pgrst, 'reload schema';
commit;
