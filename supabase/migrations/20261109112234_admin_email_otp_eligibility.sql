begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function public.find_admin_email_otp_user(p_email text)
returns uuid
language sql stable strict security definer set search_path = ''
as $eligibility$
  with matches as materialized (
    select account.id, account.email_confirmed_at
    from auth.users account
    where lower(account.email) = nullif(lower(btrim(p_email)), '')
    limit 2
  )
  select account.id
  from matches account
  join public.profiles profile on profile.id = account.id and profile.is_active
  join public.schools school on school.id = profile.school_id and school.is_active
  where (select count(*) from matches) = 1
    and account.email_confirmed_at is not null
    and exists (
      select 1 from public.user_roles membership
      where membership.user_id = account.id
        and membership.school_id = school.id
        and membership.role = 'school_admin'
    )
    and app_private.has_verified_staff_totp(account.id);
$eligibility$;

revoke all on function public.find_admin_email_otp_user(text) from public, anon, authenticated, service_role;
grant execute on function public.find_admin_email_otp_user(text) to service_role;

-- An admin's email code remains a first factor even if the authenticator
-- disappears between code delivery and native verification.
create or replace function app_private.staff_mfa_state()
returns jsonb language sql stable security definer set search_path = ''
as $state$
  with identity as (
    select auth.uid() as user_id, auth.jwt() as claims,
      case when auth.jwt()->>'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then (auth.jwt()->>'session_id')::uuid end as session_id
  ),
  factors as (
    select count(*)::integer as total from auth.mfa_factors factor, identity
    where factor.user_id = identity.user_id and factor.factor_type = 'totp' and factor.status = 'verified'
  ),
  membership as materialized (
    select role.role, role.school_id from public.user_roles role, identity
    where role.user_id = identity.user_id and (role.role <> 'super_admin' or role.school_id is null)
  ),
  requirement as (
    select factors.total,
      exists(select 1 from membership where role not in ('parent','student')) as staff,
      exists(select 1 from membership role join public.schools school on school.id = role.school_id and school.is_active
        join app_private.school_staff_mfa_policy policy on policy.school_id = school.id and policy.required
        where role.role not in ('parent','student','super_admin')) as policy_required,
      exists(select 1 from membership where role = 'super_admin' and school_id is null) as global_admin,
      exists(select 1 from membership role
        join public.schools school on school.id = role.school_id and school.is_active
        join public.profiles profile on profile.id = identity.user_id and profile.is_active and profile.school_id = school.id
        where role.role = 'school_admin')
        and coalesce((
          select method.authentication_method = 'otp'
          from auth.sessions session join auth.mfa_amr_claims method on method.session_id = session.id
          where session.id = identity.session_id and session.user_id = identity.user_id
          order by method.created_at, (method.authentication_method = 'otp') desc
          limit 1
        ), false) as admin_otp
    from factors, identity
  ),
  native as (
    select exists(select 1 from auth.sessions session join auth.mfa_factors factor on factor.id = session.factor_id
        and factor.user_id = session.user_id and factor.factor_type = 'totp' and factor.status = 'verified'
        where session.id = identity.session_id and session.user_id = identity.user_id
          and session.aal = 'aal2' and (session.not_after is null or session.not_after > statement_timestamp()))
      and app_private.has_live_school_session() as valid
    from identity
  ),
  decision as (
    select requirement.*, coalesce(identity.claims->>'aal' = 'aal2', false) as claims_aal2,
      native.valid as native_aal2, total > 0 or policy_required or global_admin or admin_otp as required
    from identity, requirement, native
  )
  select jsonb_build_object('required',required,'staff',staff,'policy_required',policy_required,
    'verified_totp_count',total,'current_aal',case when claims_aal2 then 'aal2' else 'aal1' end,
    'allowed',case when claims_aal2 then native_aal2 else not required end,
    'action',case when claims_aal2 and not native_aal2 then 'sign_in'
      when not required or (claims_aal2 and native_aal2) then 'none'
      when admin_otp and total = 0 then 'sign_in'
      when total = 0 then 'enroll' else 'challenge' end)
  from decision;
$state$;

commit;
