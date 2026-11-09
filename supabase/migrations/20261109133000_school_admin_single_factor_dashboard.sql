begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.school_staff_mfa_policy
  add column allow_admin_single_factor_dashboard boolean not null default false;

-- Native AMR records several different verification flows as otp. Bind only
-- sessions returned by the app's verified admin email-code endpoint.
create table app_private.school_admin_dashboard_email_sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  school_id uuid not null
);
alter table app_private.school_admin_dashboard_email_sessions enable row level security;
revoke all on app_private.school_admin_dashboard_email_sessions from public, anon, authenticated, service_role;

create function app_private.school_admin_dashboard_eligible_school(
  p_user_id uuid, p_session_id uuid, p_record_email_otp boolean
)
returns uuid language sql stable security definer set search_path = ''
as $$
  select school.id
  from auth.sessions session
  join auth.users account on account.id = session.user_id and account.email_confirmed_at is not null
  join public.profiles profile on profile.id = account.id and profile.is_active
  join public.schools school on school.id = profile.school_id and school.is_active
  join app_private.school_staff_mfa_policy policy on policy.school_id = school.id and policy.allow_admin_single_factor_dashboard
  cross join lateral (
    select min(first_method.authentication_method) as authentication_method
    from (
      select method.authentication_method from auth.mfa_amr_claims method
      where method.session_id = session.id
      order by method.created_at fetch first 1 row with ties
    ) first_method
    having count(*) = 1
  ) first_factor
  where session.id = p_session_id and session.user_id = p_user_id and session.aal = 'aal1'
    and (session.not_after is null or session.not_after > statement_timestamp())
    and app_private.has_verified_staff_totp(account.id)
    and exists (
      select 1 from public.user_roles membership where membership.user_id = account.id
        and membership.school_id = school.id and membership.role = 'school_admin'
    )
    and not exists (
      select 1 from public.user_roles membership where membership.user_id = account.id
        and (membership.school_id is distinct from school.id or membership.role <> 'school_admin')
    )
    and (
      (first_factor.authentication_method = 'password' and not p_record_email_otp)
      or (first_factor.authentication_method = 'otp' and (
        p_record_email_otp or exists (
          select 1 from app_private.school_admin_dashboard_email_sessions approved
          where approved.session_id = session.id and approved.school_id = school.id
        )
      ))
    );
$$;

create function app_private.school_admin_dashboard_school()
returns uuid language sql stable security definer set search_path = ''
as $$
  select case when auth.jwt()->>'aal' = 'aal1'
    and auth.jwt()->>'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  then app_private.school_admin_dashboard_eligible_school(auth.uid(), (auth.jwt()->>'session_id')::uuid, false) end;
$$;

create function app_private.allow_school_admin_email_otp_dashboard(p_user_id uuid, p_session_id uuid)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare school uuid := app_private.school_admin_dashboard_eligible_school(p_user_id, p_session_id, true);
begin
  if school is null then
    return false;
  end if;
  insert into app_private.school_admin_dashboard_email_sessions(session_id, school_id) values (p_session_id, school)
    on conflict (session_id) do nothing;
  return exists (
    select 1 from app_private.school_admin_dashboard_email_sessions approved
    where approved.session_id = p_session_id and approved.school_id = school
  );
end;
$$;

create function public.allow_school_admin_email_otp_dashboard(p_user_id uuid, p_session_id uuid)
returns boolean language sql security invoker set search_path = ''
as $$ select app_private.allow_school_admin_email_otp_dashboard(p_user_id, p_session_id); $$;

create or replace function app_private.get_my_staff_mfa_status()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare actor uuid := auth.uid(); response jsonb;
begin
  if not app_private.has_live_school_session() then
    raise exception 'Sign in again with an active verified school account.' using errcode = '42501';
  end if;
  select app_private.staff_mfa_state() || jsonb_build_object(
    'user_id', actor, 'profile_school_id', profile.school_id,
    'dashboard_allowed', app_private.school_admin_dashboard_school() is not null,
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', role.role, 'school_id', role.school_id)
      order by role.role, role.school_id) from public.user_roles role where role.user_id = actor
      and (role.role <> 'super_admin' or role.school_id is null)), '[]'::jsonb)) into response
    from public.profiles profile where profile.id = actor;
  return response;
end;
$$;

create function app_private.get_my_school_admin_dashboard_summary()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  school uuid := app_private.school_admin_dashboard_school();
  school_date date := timezone('Asia/Kolkata', statement_timestamp())::date;
begin
  if school is null then
    raise exception 'This dashboard requires a verified school administrator.' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
      'date', school_date,
      'students', (select count(*) from public.students where school_id = school),
      'teachers', (select count(*) from public.teachers where school_id = school),
      'classes', (select count(*) from public.classes where school_id = school),
      'sections', (select count(*) from public.sections where school_id = school),
      'attendance_today', count(*),
      'absent_today', count(*) filter (where attendance.status = 'absent')
    )
    from public.attendance attendance where attendance.school_id = school and attendance.attendance_date = school_date
  );
end;
$$;

create function public.get_my_school_admin_dashboard_summary()
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.get_my_school_admin_dashboard_summary(); $$;

create or replace function public.check_staff_mfa_request()
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if current_setting('role', true) is distinct from 'authenticated' then return; end if;
  if current_setting('request.path', true) in (
    '/rpc/get_my_staff_mfa_status', 'rpc/get_my_staff_mfa_status',
    '/rpc/get_my_school_admin_dashboard_summary', 'rpc/get_my_school_admin_dashboard_summary'
  ) then return; end if;
  if not app_private.staff_mfa_allowed() then
    raise exception 'Complete authenticator verification before accessing school data.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function app_private.school_admin_dashboard_eligible_school(uuid, uuid, boolean),
  app_private.school_admin_dashboard_school(), app_private.allow_school_admin_email_otp_dashboard(uuid, uuid),
  public.allow_school_admin_email_otp_dashboard(uuid, uuid), app_private.get_my_school_admin_dashboard_summary(),
  public.get_my_school_admin_dashboard_summary() from public, anon, authenticated, service_role;
grant execute on function app_private.allow_school_admin_email_otp_dashboard(uuid, uuid),
  public.allow_school_admin_email_otp_dashboard(uuid, uuid) to service_role;
grant execute on function app_private.get_my_school_admin_dashboard_summary(),
  public.get_my_school_admin_dashboard_summary() to authenticated;

notify pgrst, 'reload schema';
commit;
