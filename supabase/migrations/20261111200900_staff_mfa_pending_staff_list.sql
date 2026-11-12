begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- MFA-06: name the staff accounts that still block the school authenticator
-- policy, so an admin can chase enrollment or remove a stale staff role instead
-- of guessing from a count. Same staff selection as school_staff_mfa_counts;
-- capped at 200 rows. Counts, actor check and the save gate are unchanged.
create or replace function app_private.get_school_staff_mfa_policy(p_school_id uuid)
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
      left join public.profiles profile on profile.id=history.actor_id and profile.school_id=p_school_id),'[]'::jsonb),
    'pending',coalesce((select jsonb_agg(jsonb_build_object('profile_id',pending.id,'full_name',pending.full_name,
      'roles',pending.roles,'reason',pending.reason) order by pending.full_name nulls last,pending.id)
      from(select profile.id,nullif(left(btrim(profile.full_name),160),'') as full_name,
          array(select distinct role.role::text from public.user_roles role where role.user_id=profile.id
            and role.school_id=p_school_id and role.role not in('parent','student','super_admin') order by 1) as roles,
          -- Mirrors has_verified_staff_totp's identity checks; anonymous accounts fold into not_enrolled.
          case when account.id is null or account.deleted_at is not null then 'deleted'
            when account.banned_until>statement_timestamp() then 'banned'
            when account.email_confirmed_at is null and account.phone_confirmed_at is null then 'unconfirmed'
            else 'not_enrolled' end as reason
        from public.profiles profile left join auth.users account on account.id=profile.id
        where profile.is_active and exists(select 1 from public.user_roles role where role.user_id=profile.id
            and role.school_id=p_school_id and role.role not in('parent','student','super_admin'))
          and not app_private.has_verified_staff_totp(profile.id)
        order by 2 nulls last,1 limit 200) pending),'[]'::jsonb));
end;
$$;

revoke all on function app_private.get_school_staff_mfa_policy(uuid) from public,anon,authenticated,service_role;
grant execute on function app_private.get_school_staff_mfa_policy(uuid) to authenticated;

commit;
