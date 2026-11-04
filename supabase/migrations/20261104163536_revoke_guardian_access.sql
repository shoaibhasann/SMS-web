begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Keep a durable audit trail even if a student, guardian or staff account is later removed.
create table app_private.guardian_access_audit (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  student_id uuid not null,
  parent_id uuid not null,
  guardian_profile_id uuid,
  actor_id uuid not null,
  action text not null check (action in ('linked', 'revoked')),
  relationship text,
  reason text,
  occurred_at timestamptz not null default clock_timestamp(),
  check ((action = 'linked' and reason is null)
    or (action = 'revoked' and reason is not null and char_length(btrim(reason)) between 5 and 500))
);

alter table app_private.guardian_access_audit enable row level security;
revoke all on app_private.guardian_access_audit from public, anon, authenticated, service_role;
create index guardian_access_audit_student_history
  on app_private.guardian_access_audit (school_id, student_id, occurred_at desc, id);
create index guardian_access_audit_invite_cutoff
  on app_private.guardian_access_audit (student_id, guardian_profile_id, occurred_at desc)
  where action = 'revoked';

create function app_private.is_guardian_access_admin(p_actor_id uuid, p_school_id uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id and p.is_active
    where ur.user_id = p_actor_id and ur.school_id = p_school_id and ur.role = 'school_admin'
  );
$$;
revoke all on function app_private.is_guardian_access_admin(uuid, uuid)
from public, anon, authenticated, service_role;

create function app_private.lookup_guardian_access(p_school_id uuid, p_admission_no text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  student_record public.students%rowtype;
begin
  if not app_private.is_guardian_access_admin(auth.uid(), p_school_id) then
    raise exception 'School administrator access is required.' using errcode = '42501';
  end if;

  -- A former student can still have an authorised guardian relationship.
  select * into student_record
  from public.students s
  where s.school_id = p_school_id and s.admission_no = pg_catalog.btrim(p_admission_no);
  if not found then return null; end if;

  return pg_catalog.jsonb_build_object(
    'student_id', student_record.id,
    'student_name', pg_catalog.concat_ws(' ', student_record.first_name, student_record.middle_name, student_record.last_name),
    'admission_no', student_record.admission_no,
    'guardians', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.parent_id), '[]'::jsonb)
      from (
        select p.id as parent_id, p.profile_id is not null as has_account,
          profile.full_name as name, u.email, sp.relationship
        from public.student_parents sp
        join public.parents p on p.id = sp.parent_id and p.school_id = p_school_id
        left join public.profiles profile on profile.id = p.profile_id
        left join auth.users u on u.id = p.profile_id
        where sp.student_id = student_record.id
      ) rows
    ),
    'events', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.occurred_at desc, rows.id), '[]'::jsonb)
      from (
        select a.id, a.action, a.reason, a.occurred_at, actor.full_name as actor_name, guardian.full_name as guardian_name
        from app_private.guardian_access_audit a
        left join public.profiles actor on actor.id = a.actor_id
        left join public.profiles guardian on guardian.id = a.guardian_profile_id
        where a.school_id = p_school_id and a.student_id = student_record.id
        order by a.occurred_at desc, a.id limit 50
      ) rows
    )
  );
end;
$$;

create function app_private.revoke_guardian_access(
  p_school_id uuid, p_student_id uuid, p_parent_id uuid, p_reason text
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare
  request_actor_id uuid := auth.uid();
  reason_text text := pg_catalog.btrim(p_reason);
  guardian_user_id uuid;
  current_email text;
  removed_link public.student_parents%rowtype;
  revoked_time timestamptz;
begin
  if not app_private.is_guardian_access_admin(request_actor_id, p_school_id) then
    raise exception 'School administrator access is required.' using errcode = '42501';
  end if;
  if reason_text is null or pg_catalog.char_length(reason_text) not between 5 and 500 then
    raise exception 'Enter a removal reason between 5 and 500 characters.' using errcode = '22023';
  end if;

  select p.profile_id into guardian_user_id
  from public.parents p
  join public.students s on s.id = p_student_id and s.school_id = p.school_id
  where p.id = p_parent_id and p.school_id = p_school_id;
  if not found then
    raise exception 'The guardian and student must belong to this school.' using errcode = '42501';
  end if;

  -- Acceptance uses the same account lock, so it cannot recreate the link
  -- while removal and invite invalidation are in progress.
  if guardian_user_id is not null then
    select pg_catalog.lower(pg_catalog.btrim(u.email)) into current_email
    from auth.users u where u.id = guardian_user_id for no key update;
  end if;

  perform 1
  from public.parents p
  join public.students s on s.id = p_student_id and s.school_id = p.school_id
  where p.id = p_parent_id and p.school_id = p_school_id
    and p.profile_id is not distinct from guardian_user_id
  for share of p, s;
  if not found then
    raise exception 'The guardian relationship changed. Reload the student and try again.';
  end if;

  delete from public.student_parents
  where student_id = p_student_id and parent_id = p_parent_id
  returning * into removed_link;
  if not found then return false; end if;

  revoked_time := clock_timestamp();
  insert into app_private.guardian_access_audit
    (school_id, student_id, parent_id, guardian_profile_id, actor_id, action, relationship, reason, occurred_at)
  values (p_school_id, p_student_id, p_parent_id, guardian_user_id, request_actor_id,
    'revoked', removed_link.relationship, reason_text, revoked_time);

  if guardian_user_id is not null then
    update app_private.guardian_invitations i set revoked_at = revoked_time
    where i.school_id = p_school_id and i.student_id = p_student_id
      and i.accepted_at is null and i.revoked_at is null and i.created_at <= revoked_time
      and (i.email = current_email or exists (
        select 1 from app_private.guardian_invitations history
        where history.school_id = p_school_id and history.student_id = p_student_id
          and history.accepted_by = guardian_user_id and history.email = i.email
      ));

    -- Parent-wide notices are keyed by the school role. Retain it only when
    -- the account still has a coherent relationship in that school.
    delete from public.user_roles ur
    where ur.user_id = guardian_user_id and ur.school_id = p_school_id and ur.role = 'parent'
      and not exists (
        select 1 from public.parents p
        join public.student_parents sp on sp.parent_id = p.id
        join public.students s on s.id = sp.student_id and s.school_id = p.school_id
        where p.profile_id = guardian_user_id and p.school_id = p_school_id
      );
  end if;

  return true;
end;
$$;

create function public.lookup_guardian_access(p_school_id uuid, p_admission_no text)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.lookup_guardian_access(p_school_id, p_admission_no); $$;

create function public.revoke_guardian_access(p_school_id uuid, p_student_id uuid, p_parent_id uuid, p_reason text)
returns boolean language sql security invoker set search_path = ''
as $$ select app_private.revoke_guardian_access(p_school_id, p_student_id, p_parent_id, p_reason); $$;

revoke all on function
  app_private.lookup_guardian_access(uuid, text),
  app_private.revoke_guardian_access(uuid, uuid, uuid, text),
  public.lookup_guardian_access(uuid, text),
  public.revoke_guardian_access(uuid, uuid, uuid, text)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.lookup_guardian_access(uuid, text),
  app_private.revoke_guardian_access(uuid, uuid, uuid, text),
  public.lookup_guardian_access(uuid, text),
  public.revoke_guardian_access(uuid, uuid, uuid, text)
to authenticated;

create or replace function app_private.accept_guardian_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  request_actor_id uuid := auth.uid();
  verified_email text;
  invitation app_private.guardian_invitations%rowtype;
  existing_profile public.profiles%rowtype;
  parent_ids uuid[];
  linked_parent_id uuid;
  linked_rows integer;
begin
  if request_actor_id is null then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;
  if p_token is null or pg_catalog.length(p_token) <> 64 or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  -- Serialize acceptances for the same account and prevent a concurrent email
  -- change. A second acceptance of the same token also locks the invitation.
  select pg_catalog.lower(pg_catalog.btrim(u.email)) into verified_email
  from auth.users u
  where u.id = request_actor_id and u.email_confirmed_at is not null and not u.is_anonymous
    and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if not found or verified_email is null then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;

  select * into invitation from app_private.guardian_invitations
  where token_hash = pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8'))
  for update;
  if not found or invitation.expires_at <= clock_timestamp()
    or invitation.revoked_at is not null or invitation.accepted_at is not null then
    raise exception 'This guardian invitation is unavailable.';
  end if;
  if invitation.email <> verified_email then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;

  -- This also invalidates older links sent to a different verified email
  -- on the same account, even if the old email could not be matched at removal.
  if exists (
    select 1 from app_private.guardian_access_audit a
    where a.student_id = invitation.student_id and a.guardian_profile_id = request_actor_id
      and a.action = 'revoked' and a.occurred_at >= invitation.created_at
  ) then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  perform 1 from public.students s
  join public.enrollments e on e.student_id = s.id and e.status = 'active'
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
  where s.id = invitation.student_id and s.school_id = invitation.school_id and s.status = 'active'
  for share of s, e, y;
  if not found or not app_private.can_manage_guardian_invitations(invitation.created_by, invitation.school_id) then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  select * into existing_profile from public.profiles where id = request_actor_id for update;
  if not found or not existing_profile.is_active
    or (existing_profile.school_id is not null and existing_profile.school_id <> invitation.school_id)
    or exists (
      select 1 from public.user_roles ur where ur.user_id = request_actor_id
        and (ur.role = 'super_admin' or ur.school_id is distinct from invitation.school_id)
    ) then
    raise exception 'This account cannot accept an invitation to this school.' using errcode = '42501';
  end if;

  select array(select p.id from public.parents p where p.profile_id = request_actor_id) into parent_ids;
  if pg_catalog.cardinality(parent_ids) > 1
    or exists (select 1 from public.parents p where p.id = any(parent_ids) and p.school_id <> invitation.school_id) then
    raise exception 'This account cannot accept an invitation to this school.' using errcode = '42501';
  end if;

  linked_parent_id := parent_ids[1];
  if linked_parent_id is null then
    insert into public.parents (school_id, profile_id)
    values (invitation.school_id, request_actor_id) returning id into linked_parent_id;
  end if;
  insert into public.student_parents (student_id, parent_id, relationship)
  values (invitation.student_id, linked_parent_id, 'guardian')
  on conflict do nothing;

  get diagnostics linked_rows = row_count;
  if linked_rows = 1 then
    insert into app_private.guardian_access_audit
      (school_id, student_id, parent_id, guardian_profile_id, actor_id, action, relationship)
    values (invitation.school_id, invitation.student_id, linked_parent_id, request_actor_id, request_actor_id, 'linked', 'guardian');
  end if;
  insert into public.user_roles (user_id, school_id, role)
  values (request_actor_id, invitation.school_id, 'parent')
  on conflict do nothing;
  update public.profiles set school_id = invitation.school_id
  where id = request_actor_id and school_id is null;

  update app_private.guardian_invitations
  set accepted_at = clock_timestamp(), accepted_by = request_actor_id where id = invitation.id;

  return pg_catalog.jsonb_build_object('school_id', invitation.school_id, 'student_id', invitation.student_id);
end;
$$;

commit;
