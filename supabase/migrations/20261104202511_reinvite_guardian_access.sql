begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_private.guardian_access_audit add column was_primary boolean;
alter table app_private.guardian_invitations
  add column restores_revocation_id uuid references app_private.guardian_access_audit(id);

create function app_private.latest_guardian_access_revocation(
  p_school_id uuid, p_student_id uuid, p_guardian_user_id uuid
)
returns app_private.guardian_access_audit language sql stable set search_path = ''
as $$
  select a.* from app_private.guardian_access_audit a
  where a.school_id = p_school_id and a.student_id = p_student_id
    and a.guardian_profile_id = p_guardian_user_id and a.action = 'revoked'
  order by a.occurred_at desc, a.id desc
  limit 1;
$$;

-- Both invitation actions use the same enrollment check and pending-token rotation.
create function app_private.write_guardian_invitation(
  p_school_id uuid, p_student_id uuid, p_email text, p_actor_id uuid, p_revocation_id uuid
)
returns jsonb language plpgsql set search_path = ''
as $$
declare
  invite_token text;
  invitation app_private.guardian_invitations%rowtype;
begin
  if p_email is null or pg_catalog.length(p_email) > 254
    or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid guardian email address.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.students s
    join public.enrollments e on e.student_id = s.id and e.status = 'active'
    join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
    where s.id = p_student_id and s.school_id = p_school_id and s.status = 'active'
  ) then
    raise exception 'Choose an active student enrolled in the current year.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('guardian-invitation:' || p_student_id::text || ':' || p_email, 0)
  );
  update app_private.guardian_invitations
  set revoked_at = clock_timestamp()
  where student_id = p_student_id and email = p_email
    and accepted_at is null and revoked_at is null;

  invite_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into app_private.guardian_invitations
    (school_id, student_id, email, token_hash, created_by, expires_at, restores_revocation_id)
  values
    (p_school_id, p_student_id, p_email,
     pg_catalog.sha256(pg_catalog.convert_to(invite_token, 'UTF8')), p_actor_id,
     clock_timestamp() + interval '72 hours', p_revocation_id)
  returning * into invitation;

  return pg_catalog.jsonb_build_object(
    'id', invitation.id, 'token', invite_token, 'expires_at', invitation.expires_at
  );
end;
$$;

create or replace function app_private.issue_guardian_invitation(p_school_id uuid, p_student_id uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
begin
  if not app_private.can_manage_guardian_invitations(actor_id, p_school_id) then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode = '42501';
  end if;
  return app_private.write_guardian_invitation(
    p_school_id, p_student_id, pg_catalog.lower(pg_catalog.btrim(p_email)), actor_id, null
  );
end;
$$;

create function app_private.reinvite_guardian_access(p_school_id uuid, p_student_id uuid, p_revocation_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  removal app_private.guardian_access_audit%rowtype;
  current_removal app_private.guardian_access_audit%rowtype;
  recipient text;
begin
  if not app_private.is_guardian_access_admin(actor_id, p_school_id) then
    raise exception 'School administrator access is required.' using errcode = '42501';
  end if;

  select * into removal from app_private.guardian_access_audit a
  where a.id = p_revocation_id and a.school_id = p_school_id
    and a.student_id = p_student_id and a.action = 'revoked';
  if not found then
    raise exception 'The guardian removal does not belong to this student and school.' using errcode = '42501';
  end if;

  -- Same account lock as acceptance and removal, also serializing Auth email changes.
  select nullif(pg_catalog.lower(pg_catalog.btrim(u.email)), '') into recipient
  from auth.users u
  where u.id = removal.guardian_profile_id and u.email_confirmed_at is not null
    and not u.is_anonymous and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= clock_timestamp())
  for no key update;
  if recipient is null then
    raise exception 'This guardian needs an active account with a verified email.' using errcode = '22023';
  end if;

  perform 1 from public.parents p
  join public.profiles profile on profile.id = p.profile_id and profile.is_active
  where p.id = removal.parent_id and p.school_id = p_school_id and p.profile_id = removal.guardian_profile_id
    and (profile.school_id is null or profile.school_id = p_school_id)
    and not exists (
      select 1 from public.parents duplicate where duplicate.profile_id = p.profile_id and duplicate.id <> p.id
    )
    and not exists (
      select 1 from public.user_roles ur where ur.user_id = p.profile_id
        and (ur.role = 'super_admin' or ur.school_id is distinct from p_school_id)
    )
  for share of p, profile;
  if not found then
    raise exception 'This guardian no longer has an eligible account for this school.' using errcode = '22023';
  end if;

  current_removal := app_private.latest_guardian_access_revocation(p_school_id, p_student_id, removal.guardian_profile_id);
  if current_removal.id is distinct from removal.id or exists (
    select 1 from public.student_parents sp where sp.student_id = p_student_id and sp.parent_id = removal.parent_id
  ) then
    raise exception 'Guardian access changed. Reload the student and try again.' using errcode = '55000';
  end if;

  return app_private.write_guardian_invitation(p_school_id, p_student_id, recipient, actor_id, removal.id)
    || pg_catalog.jsonb_build_object('email', recipient);
end;
$$;

create function public.reinvite_guardian_access(p_school_id uuid, p_student_id uuid, p_revocation_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.reinvite_guardian_access(p_school_id, p_student_id, p_revocation_id); $$;

revoke all on function
  app_private.latest_guardian_access_revocation(uuid, uuid, uuid),
  app_private.write_guardian_invitation(uuid, uuid, text, uuid, uuid),
  app_private.reinvite_guardian_access(uuid, uuid, uuid),
  public.reinvite_guardian_access(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.reinvite_guardian_access(uuid, uuid, uuid),
  public.reinvite_guardian_access(uuid, uuid, uuid)
to authenticated;

create or replace function app_private.guard_guardian_invitation_recipient()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  accounts uuid[];
begin
  if tg_op = 'INSERT' then
    -- A normal MVCC read is deliberate. If an email update is in progress,
    -- attach the invite to the last committed owner rather than waiting for
    -- the address to become reusable or inverting the Auth/approval locks.
    select pg_catalog.array_agg(match.id order by match.id) into accounts from (
      select u.id from auth.users u
      where u.email = new.email and not u.is_anonymous and u.deleted_at is null
      order by u.id limit 2
    ) match;
    if pg_catalog.cardinality(accounts) > 1 then
      raise exception 'Resolve the guardian email account before issuing an invitation.' using errcode = '22023';
    end if;
    new.intended_user_id := accounts[1];
    if new.restores_revocation_id is not null then
      if not exists (
        select 1 from app_private.guardian_access_audit a
        where a.id = new.restores_revocation_id and a.action = 'revoked' and a.school_id = new.school_id
          and a.student_id = new.student_id and a.guardian_profile_id = new.intended_user_id
      ) then
        raise exception 'This guardian needs an active account with a verified email.' using errcode = '22023';
      end if;
    elsif new.intended_user_id is not null
      and (app_private.latest_guardian_access_revocation(new.school_id, new.student_id, new.intended_user_id)).id is not null
      and not exists (
        select 1 from public.student_parents sp join public.parents p on p.id = sp.parent_id
        where sp.student_id = new.student_id and p.school_id = new.school_id and p.profile_id = new.intended_user_id
      ) then
      raise exception 'A school administrator must re-invite this guardian from Manage linked guardians.' using errcode = '55000';
    end if;
  elsif old.accepted_at is null and new.accepted_at is not null
    and old.intended_user_id is not null and new.accepted_by is distinct from old.intended_user_id then
    raise exception 'Sign in with the verified account on the invitation.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function app_private.lookup_guardian_access(p_school_id uuid, p_admission_no text)
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
    'reinvitable_guardians', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) order by rows.name, rows.parent_id), '[]'::jsonb)
      from (
        select a.id as revocation_id, a.parent_id, profile.full_name as name,
          pg_catalog.lower(pg_catalog.btrim(u.email)) as email, a.relationship,
          pending.id as pending_invitation_id, pending.expires_at as pending_expires_at
        from (
          select distinct on (a.guardian_profile_id) a.*
          from app_private.guardian_access_audit a
          where a.school_id = p_school_id and a.student_id = student_record.id and a.action = 'revoked'
          order by a.guardian_profile_id, a.occurred_at desc, a.id desc
        ) a
        join public.parents p on p.id = a.parent_id and p.school_id = p_school_id and p.profile_id = a.guardian_profile_id
        join public.profiles profile on profile.id = p.profile_id and profile.is_active
        join auth.users u on u.id = profile.id and u.email_confirmed_at is not null
          and not u.is_anonymous and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= statement_timestamp())
        left join app_private.guardian_invitations pending on pending.student_id = student_record.id
          and pending.school_id = p_school_id and pending.email = pg_catalog.lower(pg_catalog.btrim(u.email))
          and pending.restores_revocation_id = a.id
          and pending.revoked_at is null and pending.accepted_at is null and pending.expires_at > statement_timestamp()
        where student_record.status = 'active'
          and exists (
            select 1 from public.enrollments e
            join public.academic_years y on y.id = e.academic_year_id and y.school_id = p_school_id and y.is_current
            where e.student_id = student_record.id and e.status = 'active'
          )
          and pg_catalog.lower(pg_catalog.btrim(u.email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
          and pg_catalog.length(pg_catalog.btrim(u.email)) <= 254
          and (profile.school_id is null or profile.school_id = p_school_id)
          and not exists (
            select 1 from public.parents duplicate where duplicate.profile_id = p.profile_id and duplicate.id <> p.id
          )
          and not exists (
            select 1 from public.user_roles ur where ur.user_id = p.profile_id
              and (ur.role = 'super_admin' or ur.school_id is distinct from p_school_id)
          )
          and not exists (
            select 1 from public.student_parents sp where sp.student_id = student_record.id and sp.parent_id = p.id
          )
        order by a.occurred_at desc, a.id desc limit 50
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

create or replace function app_private.revoke_guardian_access(
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
    (school_id, student_id, parent_id, guardian_profile_id, actor_id, action, relationship, was_primary, reason, occurred_at)
  values (p_school_id, p_student_id, p_parent_id, guardian_user_id, request_actor_id,
    'revoked', removed_link.relationship, removed_link.is_primary, reason_text, revoked_time);

  if guardian_user_id is not null then
    update app_private.guardian_invitations i set revoked_at = revoked_time
    where i.school_id = p_school_id and i.student_id = p_student_id
      and i.accepted_at is null and i.revoked_at is null and i.created_at <= revoked_time
      and (i.intended_user_id = guardian_user_id or (i.intended_user_id is null and (
        i.email = current_email or exists (
          select 1 from app_private.guardian_invitations history
          where history.school_id = p_school_id and history.student_id = p_student_id
            and history.accepted_by = guardian_user_id and history.email = i.email
        )
      )));

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
  latest_removal app_private.guardian_access_audit%rowtype;
  relationship_text text := 'guardian';
  is_primary_guardian boolean := false;
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
  where u.id = request_actor_id and u.email_confirmed_at is not null and not u.is_anonymous and u.deleted_at is null
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
  if invitation.email <> verified_email
    or (invitation.intended_user_id is not null and invitation.intended_user_id <> request_actor_id) then
    raise exception 'Sign in with the verified email on the invitation.' using errcode = '42501';
  end if;

  latest_removal := app_private.latest_guardian_access_revocation(invitation.school_id, invitation.student_id, request_actor_id);
  if latest_removal.occurred_at >= invitation.created_at then
    raise exception 'This guardian invitation is unavailable.';
  end if;

  perform 1 from public.students s
  join public.enrollments e on e.student_id = s.id and e.status = 'active'
  join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
  where s.id = invitation.student_id and s.school_id = invitation.school_id and s.status = 'active'
  for share of s, e, y;
  if not found
    or not app_private.can_manage_guardian_invitations(invitation.created_by, invitation.school_id)
    or (invitation.restores_revocation_id is not null
      and not app_private.is_guardian_access_admin(invitation.created_by, invitation.school_id)) then
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
  if invitation.restores_revocation_id is not null then
    if latest_removal.id is distinct from invitation.restores_revocation_id
      or linked_parent_id is distinct from latest_removal.parent_id
      or exists (
        select 1 from public.student_parents sp where sp.student_id = invitation.student_id and sp.parent_id = linked_parent_id
      ) then
      raise exception 'This guardian invitation is unavailable.';
    end if;
    relationship_text := coalesce(latest_removal.relationship, 'guardian');
    is_primary_guardian := coalesce(latest_removal.was_primary, false);
  elsif latest_removal.id is not null and not exists (
    select 1 from public.student_parents sp where sp.student_id = invitation.student_id and sp.parent_id = linked_parent_id
  ) then
    -- A regular invitation can have been issued before the recipient had this
    -- email. Only an administrator's fresh invitation can restore the pair.
    raise exception 'This guardian invitation is unavailable.';
  end if;
  if linked_parent_id is null then
    insert into public.parents (school_id, profile_id)
    values (invitation.school_id, request_actor_id) returning id into linked_parent_id;
  end if;
  insert into public.student_parents (student_id, parent_id, relationship, is_primary)
  values (invitation.student_id, linked_parent_id, relationship_text, is_primary_guardian)
  on conflict do nothing;

  get diagnostics linked_rows = row_count;
  if linked_rows = 0 and invitation.restores_revocation_id is not null then
    raise exception 'This guardian invitation is unavailable.';
  end if;
  if linked_rows = 1 then
    insert into app_private.guardian_access_audit
      (school_id, student_id, parent_id, guardian_profile_id, actor_id, action, relationship, was_primary)
    values (invitation.school_id, invitation.student_id, linked_parent_id, request_actor_id, request_actor_id,
      'linked', relationship_text, is_primary_guardian);
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

create or replace function app_private.guardian_import_pair_error(p_school_id uuid, p_student_id uuid, p_email text)
returns text language sql stable set search_path = ''
as $$
  select case
    when exists (
      select 1
      from public.student_parents link
      join public.parents p on p.id = link.parent_id and p.school_id = p_school_id
      join auth.users u on u.id = p.profile_id
      where link.student_id = p_student_id and (
        pg_catalog.lower(pg_catalog.btrim(u.email)) = p_email or exists (
          select 1 from app_private.guardian_invitations history
          where history.school_id = p_school_id and history.student_id = p_student_id
            and history.email = p_email and history.accepted_by = u.id
        )
      )
    ) then 'This guardian email is already linked to the student.'
    when exists (
      select 1 from auth.users u
      where u.email = p_email and not u.is_anonymous and u.deleted_at is null
        and (app_private.latest_guardian_access_revocation(p_school_id, p_student_id, u.id)).id is not null
    ) then 'A school administrator must re-invite this guardian from Manage linked guardians.'
    when exists (
      select 1 from app_private.guardian_invitations i
      where i.school_id = p_school_id and i.student_id = p_student_id and i.email = p_email
        and i.accepted_at is null and i.revoked_at is null and i.expires_at > clock_timestamp()
    ) then 'An active invitation already exists for this student and email.'
  end;
$$;

commit;
