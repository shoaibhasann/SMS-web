-- Students may type their registered mobile with +91, 91, a leading 0, spaces
-- or dashes. Compare the office capture's 10-digit form on both sides.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local search_path = pg_catalog;

-- Non-Indian legacy values keep their former exact-digits comparison.
create or replace function app_private.student_activation_mobile_key(p_value text)
returns text language sql immutable set search_path = ''
as $function$
  select coalesce(app_private.student_registered_mobile(digits), digits)
  from (select pg_catalog.regexp_replace(coalesce(p_value,''),'[^0-9]','','g') as digits) input;
$function$;

revoke all on function app_private.student_activation_mobile_key(text) from public,anon,authenticated,service_role;

create or replace function app_private.activate_student(
  p_admission_no text, p_dob date, p_mobile text
)
returns uuid language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  account_row auth.users%rowtype;
  profile_row public.profiles%rowtype;
  student_row public.students%rowtype;
  matched_ids uuid[];
  current_section_id uuid;
  current_class_id uuid;
  admission text := pg_catalog.btrim(p_admission_no);
  mobile text := pg_catalog.regexp_replace(coalesce(p_mobile,''),'[^0-9]','','g');
  mobile_key text := app_private.student_activation_mobile_key(p_mobile);
begin
  if actor_id is null then raise exception 'Authentication required'; end if;

  -- Keep verification/ban state stable, while remaining compatible with the
  -- FK key-share locks taken when a role is inserted. The profile lock also
  -- serializes claims for two different pupils by this one account.
  select u.* into account_row from auth.users u
  where u.id = actor_id for share;
  if not found or account_row.is_anonymous or account_row.deleted_at is not null
    or (account_row.banned_until is not null and account_row.banned_until > now())
    or (account_row.email_confirmed_at is null and account_row.phone_confirmed_at is null) then
    raise exception 'An active verified account is required';
  end if;

  select p.* into profile_row from public.profiles p
  where p.id = actor_id for no key update;
  if not found or not profile_row.is_active then
    raise exception 'An active verified account is required';
  end if;

  if admission is null or pg_catalog.length(admission) not between 1 and 64
    or admission ~ '[[:cntrl:]]' or p_dob is null
    or p_mobile is null or pg_catalog.length(p_mobile) not between 1 and 64
    or p_mobile ~ '[[:cntrl:]]' or pg_catalog.length(mobile) not between 10 and 15 then
    raise exception 'Student verification failed';
  end if;

  -- Admission numbers are only school-unique. Reject ambiguous proof across
  -- schools as well as casing/whitespace variants; LIMIT 1 is never a claim.
  select pg_catalog.array_agg(s.id order by s.id) into matched_ids
  from public.students s
  where pg_catalog.lower(pg_catalog.btrim(s.admission_no)) = pg_catalog.lower(admission)
    and s.dob = p_dob
    and app_private.student_activation_mobile_key(s.registered_mobile) = mobile_key;
  if coalesce(pg_catalog.cardinality(matched_ids),0) <> 1 then
    raise exception 'Student verification failed';
  end if;

  select s.* into student_row from public.students s
  where s.id = matched_ids[1] for no key update;
  -- Recheck proof after waiting on a concurrent pupil edit/claim.
  if not found
    or pg_catalog.lower(pg_catalog.btrim(student_row.admission_no)) <> pg_catalog.lower(admission)
    or student_row.dob is distinct from p_dob
    or app_private.student_activation_mobile_key(student_row.registered_mobile) <> mobile_key then
    raise exception 'Student verification failed';
  end if;

  if (profile_row.school_id is not null and profile_row.school_id <> student_row.school_id)
    or (student_row.profile_id is not null and student_row.profile_id <> actor_id)
    or exists (select 1 from public.students s where s.profile_id = actor_id and s.id <> student_row.id)
    or exists (select 1 from public.parents p where p.profile_id = actor_id)
    or exists (select 1 from public.teachers t where t.profile_id = actor_id)
    or exists (select 1 from public.user_roles r where r.user_id = actor_id
      and (r.role <> 'student'::public.app_role or r.school_id is distinct from student_row.school_id)) then
    raise exception 'This account cannot activate this student. Contact the school office';
  end if;

  -- A completed activation can be retried without mutating historical access,
  -- even after withdrawal. This branch cannot create/recreate a role or link.
  if student_row.profile_id = actor_id then
    if profile_row.school_id = student_row.school_id
      and exists (select 1 from public.user_roles r where r.user_id = actor_id
        and r.school_id = student_row.school_id and r.role = 'student'::public.app_role) then
      return student_row.id;
    end if;
    -- A missing role/context on an existing claim may be an office revocation.
    -- Verification proof cannot be used to restore that authority by oneself.
    raise exception 'This account cannot activate this student. Contact the school office';
  end if;

  if student_row.status <> 'active' then raise exception 'Student verification failed'; end if;
  select e.section_id,e.class_id into current_section_id,current_class_id
  from public.enrollments e
  join public.academic_years y on y.id = e.academic_year_id
    and y.school_id = student_row.school_id and y.is_current
  join public.classes c on c.id = e.class_id and c.school_id = student_row.school_id
  where e.student_id = student_row.id and e.status = 'active'
    and (e.section_id is null or exists (select 1 from public.sections section
      where section.id = e.section_id and section.class_id = c.id and section.school_id = student_row.school_id))
  for share of e,y,c;
  if not found then raise exception 'Student verification failed'; end if;
  if current_section_id is not null then
    perform 1 from public.sections section where section.id = current_section_id
      and section.class_id = current_class_id and section.school_id = student_row.school_id
    for share;
    if not found then raise exception 'Student verification failed'; end if;
  end if;

  update public.students set profile_id = actor_id where id = student_row.id;
  update public.profiles set school_id = student_row.school_id, updated_at = now()
  where id = actor_id and school_id is null;
  insert into public.user_roles(user_id,school_id,role)
  values (actor_id,student_row.school_id,'student'::public.app_role)
  on conflict (user_id,school_id,role) do nothing;

  return student_row.id;
end;
$function$;

revoke all on function app_private.activate_student(text,date,text) from public,anon,authenticated,service_role;
grant execute on function app_private.activate_student(text,date,text) to authenticated,service_role;

commit;
