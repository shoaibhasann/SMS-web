begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.guardian_invitation_imports (
  school_id uuid not null references public.schools(id),
  request_id uuid not null,
  actor_id uuid not null,
  payload_hash bytea not null,
  delivery_salt bytea not null,
  invitations jsonb not null check (jsonb_array_length(invitations) between 1 and 50),
  created_at timestamptz not null default clock_timestamp(),
  primary key (school_id, request_id)
);

alter table app_private.guardian_invitation_imports enable row level security;
revoke all on table app_private.guardian_invitation_imports from public, anon, authenticated, service_role;

create function app_private.guardian_import_pair_error(p_school_id uuid, p_student_id uuid, p_email text)
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
      select 1 from app_private.guardian_invitations i
      where i.school_id = p_school_id and i.student_id = p_student_id and i.email = p_email
        and i.accepted_at is null and i.revoked_at is null and i.expires_at > clock_timestamp()
    ) then 'An active invitation already exists for this student and email.'
  end;
$$;

create function app_private.preview_guardian_invitation_import(p_school_id uuid, p_rows jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_school_id is null or not app_private.can_manage_guardian_invitations(auth.uid(), p_school_id) then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Provide a list of student admission numbers and guardian emails.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) not between 1 and 50
    or pg_catalog.octet_length(p_rows::text) > 65536 then
    raise exception 'Import between 1 and 50 guardian invitations at a time.' using errcode = '22023';
  end if;

  return (
    with input as (
      select ordinality::integer as row_number,
        case when pg_catalog.jsonb_typeof(value->'admissionNumber') = 'string'
          then pg_catalog.btrim(value->>'admissionNumber') end as admission_no,
        case when pg_catalog.jsonb_typeof(value->'email') = 'string'
          then pg_catalog.lower(pg_catalog.btrim(value->>'email')) end as email
      from pg_catalog.jsonb_array_elements(p_rows) with ordinality
    ), checked as (
      select input.*, s.id as student_id,
        case when s.id is not null then pg_catalog.concat_ws(' ', s.first_name, s.middle_name, s.last_name) end as student_name,
        case
          when input.admission_no is null or pg_catalog.length(input.admission_no) not between 1 and 64
            or input.admission_no ~ '[[:cntrl:]]' then 'Enter a valid admission number.'
          when input.email is null or pg_catalog.length(input.email) > 254
            or input.email ~ '[[:cntrl:]]'
            or input.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then 'Enter a valid guardian email address.'
          when count(*) over (partition by input.admission_no, input.email) > 1
            then 'This student and email pair is repeated in the CSV.'
          when s.id is null then 'No active student with this admission number was found in the current academic year.'
          else app_private.guardian_import_pair_error(p_school_id, s.id, input.email)
        end as error
      from input
      left join public.students s on s.school_id = p_school_id and s.admission_no = input.admission_no
        and s.status = 'active'
        and exists (
          select 1 from public.enrollments e
          join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
          where e.student_id = s.id and e.status = 'active'
        )
    )
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(checked) order by checked.row_number) from checked
  );
end;
$$;

create function app_private.guardian_import_token(p_delivery_key text, p_delivery_salt bytea, p_invitation_id uuid)
returns text language sql immutable strict set search_path = ''
as $$
  select pg_catalog.encode(extensions.hmac(
    p_delivery_salt || pg_catalog.uuid_send(p_invitation_id), pg_catalog.decode(p_delivery_key, 'hex'), 'sha256'
  ), 'hex');
$$;

create function app_private.import_guardian_invitations(
  p_school_id uuid, p_request_id uuid, p_delivery_key text, p_rows jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  payload_hash bytea;
  saved_import app_private.guardian_invitation_imports%rowtype;
  preview_rows jsonb;
  candidate record;
  current_year_id uuid;
  invite_id uuid;
  invite_expiry timestamptz;
  pair_error text;
  receipt_rows jsonb := '[]'::jsonb;
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')))
  for share of ur, p;
  if not found or p_school_id is null then
    raise exception 'You cannot manage guardian invitations for this school.' using errcode = '42501';
  end if;

  if p_request_id is null or p_delivery_key is null or p_delivery_key !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Review the file and start a valid guardian import request.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_rows) not between 1 and 50
    or pg_catalog.octet_length(p_rows::text) > 65536 then
    raise exception 'Import between 1 and 50 guardian invitations at a time.' using errcode = '22023';
  end if;

  payload_hash := pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(p_rows, p_delivery_key)::text, 'UTF8'));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'guardian-import:' || p_school_id::text || ':' || p_request_id::text, 0));
  select i.* into saved_import from app_private.guardian_invitation_imports i
  where i.school_id = p_school_id and i.request_id = p_request_id;

  if found then
    if saved_import.actor_id <> actor_id or saved_import.payload_hash <> payload_hash then
      raise exception 'This import request already has different data or belongs to another reviewer.' using errcode = '23505';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(saved_import.invitations) as item(row_data)
      left join app_private.guardian_invitations i on i.id = (item.row_data->>'id')::uuid
      where i.id is null or i.accepted_at is not null or i.revoked_at is not null or i.expires_at <= clock_timestamp()
        or not exists (
          select 1 from public.students s
          join public.enrollments e on e.student_id = s.id and e.status = 'active'
          join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id and y.is_current
          where s.id = i.student_id and s.school_id = i.school_id and s.status = 'active'
        )
    ) then
      raise exception 'This import already finished and at least one link is no longer available. Review the individual invitation histories.' using errcode = '55000';
    end if;
  else
    preview_rows := app_private.preview_guardian_invitation_import(p_school_id, p_rows);
    for candidate in select * from pg_catalog.jsonb_to_recordset(preview_rows)
      as rows(row_number integer, student_id uuid, error text)
      order by row_number
    loop
      if candidate.error is not null then
        raise exception 'Guardian import row %: %', candidate.row_number, candidate.error using errcode = '22023';
      end if;
      if (p_rows->(candidate.row_number - 1)->>'studentId') is distinct from candidate.student_id::text then
        raise exception 'Guardian import row % changed since preview. Review the CSV again.', candidate.row_number using errcode = '22023';
      end if;
    end loop;

    select y.id into current_year_id from public.academic_years y
    where y.school_id = p_school_id and y.is_current for share;
    if not found then
      raise exception 'Set the school current academic year before importing guardians.' using errcode = '22023';
    end if;
    saved_import.delivery_salt := extensions.gen_random_bytes(32);

    -- Match the lock used by individual invitations. Order by pupil and
    -- recipient so overlapping batches acquire their pair locks consistently.
    for candidate in select * from pg_catalog.jsonb_to_recordset(preview_rows)
      as rows(row_number integer, admission_no text, email text, student_id uuid, student_name text)
      order by student_id, email collate "C"
    loop
      perform 1 from public.students s
      join public.enrollments e on e.student_id = s.id and e.academic_year_id = current_year_id and e.status = 'active'
      where s.id = candidate.student_id and s.school_id = p_school_id
        and s.status = 'active' and s.admission_no = candidate.admission_no
      for share of s, e;
      if not found then
        raise exception 'Guardian import row % changed since preview. Review the CSV again.', candidate.row_number using errcode = '22023';
      end if;

      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'guardian-invitation:' || candidate.student_id::text || ':' || candidate.email, 0));
      pair_error := app_private.guardian_import_pair_error(p_school_id, candidate.student_id, candidate.email);
      if pair_error is not null then
        raise exception 'Guardian import row %: %', candidate.row_number, pair_error using errcode = '22023';
      end if;

      update app_private.guardian_invitations set revoked_at = clock_timestamp()
      where school_id = p_school_id and student_id = candidate.student_id and email = candidate.email
        and accepted_at is null and revoked_at is null and expires_at <= clock_timestamp();

      invite_id := pg_catalog.gen_random_uuid();
      insert into app_private.guardian_invitations (id, school_id, student_id, email, token_hash, created_by, expires_at)
      values (invite_id, p_school_id, candidate.student_id, candidate.email,
        pg_catalog.sha256(pg_catalog.convert_to(
          app_private.guardian_import_token(p_delivery_key, saved_import.delivery_salt, invite_id), 'UTF8'
        )), actor_id, clock_timestamp() + interval '72 hours')
      returning expires_at into invite_expiry;
      receipt_rows := receipt_rows || pg_catalog.jsonb_build_object(
        'row_number', candidate.row_number, 'id', invite_id, 'admission_no', candidate.admission_no,
        'email', candidate.email, 'student_id', candidate.student_id, 'student_name', candidate.student_name,
        'expires_at', invite_expiry
      );
    end loop;

    insert into app_private.guardian_invitation_imports (school_id, request_id, actor_id, payload_hash, delivery_salt, invitations)
    values (p_school_id, p_request_id, actor_id, payload_hash, saved_import.delivery_salt, receipt_rows)
    returning * into saved_import;
  end if;

  -- The database stores only token hashes. The exact initiating request can
  -- rederive delivery links using its client-held key and a private salt.
  return pg_catalog.jsonb_build_object('request_id', p_request_id, 'invitations', (
    select pg_catalog.jsonb_agg(item.row_data || pg_catalog.jsonb_build_object('token',
      app_private.guardian_import_token(p_delivery_key, saved_import.delivery_salt, (item.row_data->>'id')::uuid)
    ) order by (item.row_data->>'row_number')::integer)
    from pg_catalog.jsonb_array_elements(saved_import.invitations) as item(row_data)
  ));
end;
$$;

create function public.preview_guardian_invitation_import(p_school_id uuid, p_rows jsonb)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select app_private.preview_guardian_invitation_import(p_school_id, p_rows); $$;

create function public.import_guardian_invitations(p_school_id uuid, p_request_id uuid, p_delivery_key text, p_rows jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select app_private.import_guardian_invitations(p_school_id, p_request_id, p_delivery_key, p_rows); $$;

revoke all on function
  app_private.guardian_import_pair_error(uuid, uuid, text),
  app_private.guardian_import_token(text, bytea, uuid),
  app_private.preview_guardian_invitation_import(uuid, jsonb),
  public.preview_guardian_invitation_import(uuid, jsonb),
  app_private.import_guardian_invitations(uuid, uuid, text, jsonb),
  public.import_guardian_invitations(uuid, uuid, text, jsonb)
from public, anon, authenticated, service_role;

grant execute on function
  app_private.preview_guardian_invitation_import(uuid, jsonb),
  public.preview_guardian_invitation_import(uuid, jsonb),
  app_private.import_guardian_invitations(uuid, uuid, text, jsonb),
  public.import_guardian_invitations(uuid, uuid, text, jsonb)
to authenticated;

commit;
