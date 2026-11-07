-- Native TOTP is optional until enrolled or a school explicitly requires it.
-- After enrollment, all account roles honor it. HTTP SECURITY DEFINER RPCs are
-- covered by PostgREST's hook; restrictive RLS additionally covers Storage and
-- ordinary SQL table/view access. Credentialed database operators remain trusted.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $preflight$
begin
  if to_regclass('auth.mfa_factors') is null
    or not exists(select 1 from pg_attribute where attrelid='auth.sessions'::regclass
      and attname='aal' and not attisdropped)
    or not exists(select 1 from pg_attribute where attrelid='auth.sessions'::regclass
      and attname='factor_id' and not attisdropped) then
    raise exception 'The managed native MFA/session contract is required.';
  end if;
  if exists(select 1 from pg_db_role_setting settings join pg_roles role on role.oid=settings.setrole,
    lateral unnest(settings.setconfig) item where role.rolname='authenticator'
      and item like 'pgrst.db_pre_request=%'
      and item not in('pgrst.db_pre_request=','pgrst.db_pre_request=public.check_staff_mfa_request')) then
    raise exception 'An existing PostgREST pre-request hook must be composed and reviewed first.';
  end if;
  if exists(select 1 from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='public' and relation.relkind in('r','p') and not relation.relrowsecurity)
    or has_schema_privilege('authenticated','app_private','CREATE')
    or has_schema_privilege('anon','app_private','CREATE') then
    raise exception 'Governed RLS and the protected helper schema are required.';
  end if;
end;
$preflight$;

create table app_private.school_staff_mfa_policy(
  school_id uuid primary key references public.schools(id),
  required boolean not null default false,
  revision integer not null default 0 check(revision>=0)
);
create table app_private.school_staff_mfa_audit(
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  revision integer not null check(revision>0),
  required boolean not null,
  actor_id uuid not null,
  request_id uuid not null,
  reason text not null check(char_length(reason) between 5 and 300),
  changed_at timestamptz not null default clock_timestamp(),
  unique(school_id,revision),unique(actor_id,request_id)
);
create table app_private.school_staff_mfa_receipts(
  actor_id uuid not null,request_id uuid not null,
  school_id uuid not null references public.schools(id),
  payload jsonb not null,revision integer not null check(revision>=0),
  required boolean not null,changed boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id,request_id)
);
alter table app_private.school_staff_mfa_policy enable row level security;
alter table app_private.school_staff_mfa_audit enable row level security;
alter table app_private.school_staff_mfa_receipts enable row level security;
revoke all on app_private.school_staff_mfa_policy,app_private.school_staff_mfa_audit,
  app_private.school_staff_mfa_receipts from public,anon,authenticated,service_role;

-- Never select factor secrets. A verified credential on an unverified, banned
-- or deleted identity cannot satisfy rollout readiness.
create function app_private.has_verified_staff_totp(p_user_id uuid)
returns boolean language sql stable security definer set search_path=''
as $$
  select exists(select 1 from auth.users account where account.id=p_user_id
    and not coalesce(account.is_anonymous,false) and account.deleted_at is null
    and(account.banned_until is null or account.banned_until<=statement_timestamp())
    and(account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
    and exists(select 1 from auth.mfa_factors factor where factor.user_id=account.id
      and factor.factor_type='totp' and factor.status='verified'));
$$;

-- Nonrecursive because all identity/policy reads execute under the trusted
-- owner, never through the new table policies. JWT AAL2 alone is insufficient:
-- its exact live native session must still reference its owned verified factor.
create function app_private.staff_mfa_state()
returns jsonb language sql stable security definer set search_path=''
as $state$
  with identity as(select auth.uid() as user_id,auth.jwt() as claims),
  factors as(select count(*)::integer as total from auth.mfa_factors factor,identity
    where factor.user_id=identity.user_id and factor.factor_type='totp' and factor.status='verified'),
  membership as materialized(select role.role,role.school_id from public.user_roles role,identity
    where role.user_id=identity.user_id and(role.role<>'super_admin' or role.school_id is null)),
  requirement as(select factors.total,
    exists(select 1 from membership where role not in('parent','student')) as staff,
    exists(select 1 from membership role join public.schools school on school.id=role.school_id and school.is_active
      join app_private.school_staff_mfa_policy policy on policy.school_id=school.id and policy.required
      where role.role not in('parent','student','super_admin')) as policy_required,
    exists(select 1 from membership where role='super_admin' and school_id is null) as global_admin
    from factors),
  native as(select coalesce(case when identity.claims->>'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then exists(select 1 from auth.sessions session join auth.mfa_factors factor on factor.id=session.factor_id
      and factor.user_id=session.user_id and factor.factor_type='totp' and factor.status='verified'
      where session.id=(identity.claims->>'session_id')::uuid and session.user_id=identity.user_id
        and session.aal='aal2' and(session.not_after is null or session.not_after>statement_timestamp()))
    else false end,false) and app_private.has_live_school_session() as valid from identity),
  decision as(select identity.user_id,requirement.*,coalesce(identity.claims->>'aal'='aal2',false) as claims_aal2,
    native.valid as native_aal2,total>0 or policy_required or global_admin as required
    from identity,requirement,native)
  select jsonb_build_object('required',required,'staff',staff,'policy_required',policy_required,
    'verified_totp_count',total,'current_aal',case when claims_aal2 then 'aal2' else 'aal1' end,
    'allowed',case when claims_aal2 then native_aal2 else not required end,
    'action',case when claims_aal2 and not native_aal2 then 'sign_in'
      when not required or(claims_aal2 and native_aal2) then 'none'
      when total=0 then 'enroll' else 'challenge' end)
  from decision;
$state$;
create function app_private.staff_mfa_allowed()
returns boolean language sql stable security definer set search_path=''
as $$ select coalesce((app_private.staff_mfa_state()->>'allowed')::boolean,false); $$;

create function app_private.get_my_staff_mfa_status()
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare actor uuid:=auth.uid(); response jsonb;
begin
  if not app_private.has_live_school_session() then
    raise exception 'Sign in again with an active verified school account.' using errcode='42501'; end if;
  select app_private.staff_mfa_state()||jsonb_build_object('user_id',actor,'profile_school_id',profile.school_id,
    'roles',coalesce((select jsonb_agg(jsonb_build_object('role',role.role,'school_id',role.school_id)
      order by role.role,role.school_id) from public.user_roles role where role.user_id=actor
      and(role.role<>'super_admin' or role.school_id is null)),'[]'::jsonb)) into response
    from public.profiles profile where profile.id=actor;
  return response;
end;
$$;
create function public.get_my_staff_mfa_status()
returns jsonb language sql stable security invoker set search_path=''
as $$ select app_private.get_my_staff_mfa_status(); $$;

-- Read-only: PostgREST executes GET/HEAD inside a read-only transaction. The
-- sole path exception is a scalar own-status RPC, never a table or RLS bypass.
create function public.check_staff_mfa_request()
returns void language plpgsql security invoker set search_path=''
as $$
begin
  if current_setting('role',true) is distinct from 'authenticated' then return; end if;
  if current_setting('request.path',true) in('/rpc/get_my_staff_mfa_status','rpc/get_my_staff_mfa_status') then return; end if;
  if not app_private.staff_mfa_allowed() then
    raise exception 'Complete authenticator verification before accessing school data.' using errcode='42501'; end if;
end;
$$;

do $policies$
declare relation_record record;
begin
  for relation_record in select namespace.nspname,relation.relname from pg_class relation
    join pg_namespace namespace on namespace.oid=relation.relnamespace
    where(namespace.nspname='public' and relation.relkind in('r','p'))
      or(namespace.nspname='storage' and relation.relname='objects' and relation.relkind in('r','p'))
  loop
    execute format('create policy staff_mfa_required on %I.%I as restrictive for all to authenticated using ((select app_private.staff_mfa_allowed())) with check ((select app_private.staff_mfa_allowed()))',relation_record.nspname,relation_record.relname);
  end loop;
end;
$policies$;

create function app_private.staff_mfa_policy_actor(p_school_id uuid,p_edit boolean)
returns uuid language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.student_leave_actor();
begin
  if not app_private.staff_mfa_allowed() or p_school_id is null or p_edit is null then
    raise exception 'Verified school security access is required.' using errcode='42501'; end if;
  perform 1 from public.user_roles membership where membership.user_id=actor
    and((membership.role='super_admin' and membership.school_id is null)
      or(membership.school_id=p_school_id and(membership.role='school_admin' or(not p_edit and membership.role='principal'))))
    order by membership.id for share;
  if not found then raise exception 'Verified school security access is required.' using errcode='42501'; end if;
  if p_edit then
    if auth.jwt()->>'aal' is distinct from 'aal2' then
      raise exception 'Verify your authenticator before changing school security.' using errcode='42501'; end if;
    -- Hold the exact verified factor through the policy transaction, alongside
    -- student_leave_actor's native-session/Auth/profile identity locks.
    perform 1 from auth.mfa_factors factor join auth.sessions session on session.factor_id=factor.id
      where session.id=(auth.jwt()->>'session_id')::uuid and session.user_id=actor and session.aal='aal2'
        and factor.user_id=actor and factor.factor_type='totp' and factor.status='verified' for share of factor;
    if not found then raise exception 'Verify your authenticator before changing school security.' using errcode='42501'; end if;
    perform 1 from public.schools where id=p_school_id and is_active for update;
  else perform 1 from public.schools where id=p_school_id and is_active for share; end if;
  if not found then raise exception 'Verified school security access is required.' using errcode='42501'; end if;
  return actor;
end;
$$;
create function app_private.school_staff_mfa_counts(p_school_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  with staff as(select profile.id,app_private.has_verified_staff_totp(profile.id) as enrolled
    from public.profiles profile where profile.is_active and exists(select 1 from public.user_roles role
      where role.user_id=profile.id and role.school_id=p_school_id and role.role not in('parent','student','super_admin')))
  select jsonb_build_object('staff_count',count(*),'enrolled_staff_count',count(*) filter(where enrolled),
    'enrollment_required_count',count(*) filter(where not enrolled)) from staff;
$$;
create function app_private.get_school_staff_mfa_policy(p_school_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.staff_mfa_policy_actor(p_school_id,false);
begin
  return app_private.school_staff_mfa_counts(p_school_id)||jsonb_build_object('school_id',p_school_id,
    'required',coalesce((select required from app_private.school_staff_mfa_policy where school_id=p_school_id),false),
    'revision',coalesce((select revision from app_private.school_staff_mfa_policy where school_id=p_school_id),0),
    'can_manage',exists(select 1 from public.user_roles role where role.user_id=actor
      and((role.role='super_admin' and role.school_id is null) or(role.role='school_admin' and role.school_id=p_school_id))),
    'history',coalesce((select jsonb_agg(jsonb_build_object('id',history.id,'revision',history.revision,
      'required',history.required,'changed_at',history.changed_at,'actor_name',nullif(left(btrim(profile.full_name),160),''))
      order by history.revision desc) from(select * from app_private.school_staff_mfa_audit
        where school_id=p_school_id order by revision desc limit 10) history
      left join public.profiles profile on profile.id=history.actor_id and profile.school_id=p_school_id),'[]'::jsonb));
end;
$$;
create function app_private.save_school_staff_mfa_policy(p_school_id uuid,p_expected_revision integer,p_required boolean,p_request_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare actor uuid:=app_private.staff_mfa_policy_actor(p_school_id,true);
  receipt app_private.school_staff_mfa_receipts%rowtype;
  previous_required boolean; revision integer; changed boolean; payload jsonb;
begin
  if p_request_id is null or p_expected_revision is null or p_expected_revision<0 or p_required is null
    or p_reason is null or char_length(btrim(p_reason)) not between 5 and 300 or p_reason~'[[:cntrl:]]' then
    raise exception 'Reload security settings and enter a reason of 5 to 300 characters.' using errcode='22023'; end if;
  payload:=jsonb_build_object('school_id',p_school_id,'expected_revision',p_expected_revision,'required',p_required,'reason',p_reason);
  perform pg_advisory_xact_lock(hashtextextended('staff-mfa:'||actor::text||':'||p_request_id::text,0));
  select * into receipt from app_private.school_staff_mfa_receipts where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload<>payload then raise exception 'This security retry belongs to different input.' using errcode='40001'; end if;
    return jsonb_build_object('revision',receipt.revision,'required',receipt.required,'changed',receipt.changed,'replayed',true);
  end if;
  select policy.required,policy.revision into previous_required,revision from app_private.school_staff_mfa_policy policy where school_id=p_school_id;
  if not found then previous_required:=false; revision:=0; end if;
  if revision<>p_expected_revision then raise exception 'School security changed. Reload before saving.' using errcode='40001'; end if;
  if p_required then
    -- Serialize readiness against native factor removal/status changes. A deadlock
    -- victim rolls back safely and retries with the same actor/request receipt.
    perform 1 from auth.mfa_factors factor where factor.factor_type='totp' and factor.status='verified'
      and exists(select 1 from public.profiles profile where profile.id=factor.user_id and profile.is_active
        and exists(select 1 from public.user_roles membership where membership.user_id=profile.id
          and membership.school_id=p_school_id and membership.role not in('parent','student','super_admin')))
      order by factor.id for share;
  end if;
  if p_required and(app_private.school_staff_mfa_counts(p_school_id)->>'enrollment_required_count')::integer>0 then
    raise exception 'Every active staff account must verify an authenticator before enabling this policy.' using errcode='22023'; end if;
  changed:=previous_required is distinct from p_required;
  if changed then
    if revision=2147483647 then raise exception 'The security revision limit requires operator support.' using errcode='22023'; end if;
    revision:=revision+1;
    insert into app_private.school_staff_mfa_policy as policy(school_id,required,revision) values(p_school_id,p_required,revision)
      on conflict(school_id) do update set required=excluded.required,revision=excluded.revision;
    insert into app_private.school_staff_mfa_audit(school_id,revision,required,actor_id,request_id,reason)
      values(p_school_id,revision,p_required,actor,p_request_id,btrim(p_reason));
  end if;
  insert into app_private.school_staff_mfa_receipts(actor_id,request_id,school_id,payload,revision,required,changed)
    values(actor,p_request_id,p_school_id,payload,revision,p_required,changed);
  return jsonb_build_object('revision',revision,'required',p_required,'changed',changed,'replayed',false);
end;
$$;
create function public.get_school_staff_mfa_policy(p_school_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.get_school_staff_mfa_policy(p_school_id); $$;
create function public.save_school_staff_mfa_policy(p_school_id uuid,p_expected_revision integer,p_required boolean,p_request_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.save_school_staff_mfa_policy(p_school_id,p_expected_revision,p_required,p_request_id,p_reason); $$;

-- The same school mutex serializes enablement with membership grants and
-- reactivation. Existing native provider/admin operators retain their trusted
-- maintenance path; a SECURITY DEFINER owner is never mistaken for the caller.
create function app_private.guard_staff_mfa_membership()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
  if current_setting('role',true) not in('authenticated','anon') then return new; end if;
  if new.role in('parent','student') or(new.role='super_admin' and new.school_id is not null) then return new; end if;
  if new.role='super_admin' and new.school_id is null then
    perform 1 from auth.mfa_factors factor where factor.user_id=new.user_id
      and factor.factor_type='totp' and factor.status='verified' order by factor.id for share;
    if not app_private.has_verified_staff_totp(new.user_id) then
      raise exception 'Verify the target staff authenticator before granting this role.' using errcode='42501'; end if;
    return new;
  end if;
  perform 1 from public.schools where id=new.school_id for share;
  if exists(select 1 from app_private.school_staff_mfa_policy where school_id=new.school_id and required) then
    perform 1 from auth.mfa_factors factor where factor.user_id=new.user_id
      and factor.factor_type='totp' and factor.status='verified' order by factor.id for share;
    if not app_private.has_verified_staff_totp(new.user_id) then
      raise exception 'Verify the target staff authenticator before granting this role.' using errcode='42501'; end if;
  end if;
  return new;
end;
$$;
create trigger zz_guard_staff_mfa_membership before insert or update on public.user_roles
for each row execute function app_private.guard_staff_mfa_membership();
create function app_private.guard_staff_mfa_reactivation()
returns trigger language plpgsql security definer set search_path=''
as $$
declare scoped_school uuid;
begin
  if current_setting('role',true) not in('authenticated','anon') or not new.is_active or old.is_active then return new; end if;
  for scoped_school in select distinct role.school_id from public.user_roles role
    where role.user_id=new.id and role.school_id is not null and role.role not in('parent','student','super_admin') order by role.school_id
  loop
    perform 1 from public.schools school where school.id=scoped_school for share;
    if exists(select 1 from app_private.school_staff_mfa_policy policy where policy.school_id=scoped_school and policy.required) then
      perform 1 from auth.mfa_factors factor where factor.user_id=new.id
        and factor.factor_type='totp' and factor.status='verified' order by factor.id for share;
      if not app_private.has_verified_staff_totp(new.id) then
        raise exception 'Verify the staff authenticator before reactivating this account.' using errcode='42501'; end if;
    end if;
  end loop;
  if exists(select 1 from public.user_roles role where role.user_id=new.id and role.role='super_admin' and role.school_id is null) then
    perform 1 from auth.mfa_factors factor where factor.user_id=new.id
      and factor.factor_type='totp' and factor.status='verified' order by factor.id for share;
    if not app_private.has_verified_staff_totp(new.id) then
      raise exception 'Verify the staff authenticator before reactivating this account.' using errcode='42501'; end if;
  end if;
  return new;
end;
$$;
create trigger zz_guard_staff_mfa_reactivation before update of is_active on public.profiles
for each row execute function app_private.guard_staff_mfa_reactivation();

revoke all on function app_private.has_verified_staff_totp(uuid),app_private.staff_mfa_state(),app_private.staff_mfa_allowed(),
  app_private.get_my_staff_mfa_status(),public.get_my_staff_mfa_status(),public.check_staff_mfa_request(),
  app_private.staff_mfa_policy_actor(uuid,boolean),app_private.school_staff_mfa_counts(uuid),
  app_private.get_school_staff_mfa_policy(uuid),app_private.save_school_staff_mfa_policy(uuid,integer,boolean,uuid,text),
  public.get_school_staff_mfa_policy(uuid),public.save_school_staff_mfa_policy(uuid,integer,boolean,uuid,text),
  app_private.guard_staff_mfa_membership(),app_private.guard_staff_mfa_reactivation()
  from public,anon,authenticated,service_role;
grant execute on function app_private.staff_mfa_allowed(),app_private.get_my_staff_mfa_status(),public.get_my_staff_mfa_status(),
  app_private.get_school_staff_mfa_policy(uuid),app_private.save_school_staff_mfa_policy(uuid,integer,boolean,uuid,text),
  public.get_school_staff_mfa_policy(uuid),public.save_school_staff_mfa_policy(uuid,integer,boolean,uuid,text) to authenticated;
grant execute on function public.check_staff_mfa_request() to anon,authenticated,service_role;

alter role authenticator set pgrst.db_pre_request='public.check_staff_mfa_request';
notify pgrst,'reload config';
notify pgrst,'reload schema';
commit;
