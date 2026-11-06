begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table public.schools add column settings_revision integer not null default 0 check(settings_revision>=0);

-- School identity/status and opaque legacy settings are not a generic client write surface.
revoke insert,update,delete,truncate,references,trigger on public.schools from public,anon,authenticated;
revoke all on public.school_settings from public,anon,authenticated;
do $privileges$
declare col text;
begin
  for col in select attname from pg_attribute where attrelid='public.schools'::regclass and attnum>0 and not attisdropped loop
    execute format('revoke insert (%I),update (%I),references (%I) on public.schools from public,anon,authenticated',col,col,col);
  end loop;
  for col in select attname from pg_attribute where attrelid='public.school_settings'::regclass and attnum>0 and not attisdropped loop
    execute format('revoke select (%I),insert (%I),update (%I),references (%I) on public.school_settings from public,anon,authenticated',col,col,col,col);
  end loop;
  if has_table_privilege('authenticated','public.schools','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('authenticated','public.schools','INSERT,UPDATE,REFERENCES')
    or has_table_privilege('anon','public.schools','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('anon','public.schools','INSERT,UPDATE,REFERENCES')
    or has_table_privilege('authenticated','public.school_settings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('authenticated','public.school_settings','SELECT,INSERT,UPDATE,REFERENCES')
    or has_table_privilege('anon','public.school_settings','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    or has_any_column_privilege('anon','public.school_settings','SELECT,INSERT,UPDATE,REFERENCES') then
    raise exception 'Review inherited school settings privileges before enabling the governed editor.';
  end if;
end;
$privileges$;

create table app_private.school_settings_receipts(
  actor_id uuid not null,
  request_id uuid not null,
  school_id uuid not null references public.schools(id),
  payload jsonb not null,
  revision integer not null check(revision>=0),
  changed boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(actor_id,request_id)
);
create table app_private.school_settings_audit(
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id),
  revision integer not null check(revision>0),
  actor_id uuid not null,
  request_id uuid not null,
  before_details jsonb not null,
  after_details jsonb not null,
  changed_fields text[] not null check(cardinality(changed_fields)>0),
  reason text not null check(char_length(reason) between 5 and 300),
  changed_at timestamptz not null default clock_timestamp(),
  unique(school_id,revision),
  unique(actor_id,request_id)
);
alter table app_private.school_settings_receipts enable row level security;
alter table app_private.school_settings_audit enable row level security;
revoke all on app_private.school_settings_receipts,app_private.school_settings_audit from public,anon,authenticated,service_role;

create function app_private.school_settings_actor(p_school_id uuid,p_edit boolean)
returns uuid language plpgsql security definer set search_path=''
as $function$
declare actor uuid:=app_private.student_leave_actor();
begin
  if p_school_id is null or p_edit is null then raise exception 'Verified school settings access is required.' using errcode='42501'; end if;
  perform 1 from public.user_roles membership
    where membership.user_id=actor and((membership.role='super_admin' and membership.school_id is null)
      or(membership.school_id=p_school_id and(membership.role='school_admin' or(not p_edit and membership.role='principal'))))
    order by membership.id for share;
  if not found then raise exception 'Verified school settings access is required.' using errcode='42501'; end if;
  -- Lock once in the mode the operation needs; two writers never upgrade competing shared locks.
  if p_edit then perform 1 from public.schools school where school.id=p_school_id and school.is_active for update;
  else perform 1 from public.schools school where school.id=p_school_id and school.is_active for share; end if;
  if not found then raise exception 'Verified school settings access is required.' using errcode='42501'; end if;
  return actor;
end;
$function$;

create function app_private.get_school_settings(p_school_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare actor uuid:=app_private.school_settings_actor(p_school_id,false); response jsonb;
begin
  with years as materialized(select * from public.academic_years where school_id=p_school_id and is_current),
  current_year as materialized(select * from years where(select count(*) from years)=1),
  classes as materialized(select * from public.classes where school_id=p_school_id and is_active),
  sections as materialized(select section.* from public.sections section join classes class on class.id=section.class_id
    where section.school_id=p_school_id),
  linked_teachers as materialized(
    select teacher.id from public.teachers teacher
    join public.profiles profile on profile.id=teacher.profile_id and profile.school_id=p_school_id and profile.is_active
    join auth.users account on account.id=profile.id and not coalesce(account.is_anonymous,false) and account.deleted_at is null
      and(account.banned_until is null or account.banned_until<=statement_timestamp())
      and(account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
    where teacher.school_id=p_school_id and exists(select 1 from public.user_roles membership
      where membership.user_id=profile.id and membership.school_id=p_school_id and membership.role='teacher')
  ), assignments as materialized(
    select assignment.* from public.teacher_subject_assignments assignment
    join current_year year on year.id=assignment.academic_year_id
    join linked_teachers teacher on teacher.id=assignment.teacher_id
    join classes class on class.id=assignment.class_id
    join public.subjects subject on subject.id=assignment.subject_id and subject.school_id=p_school_id and subject.is_active
    where assignment.section_id is null or exists(select 1 from sections section
      where section.id=assignment.section_id and section.class_id=assignment.class_id)
  ), enrollments as materialized(
    select enrollment.*,pupil.school_id=p_school_id and pupil.status='active' and class.id is not null
      and section.id is not null and section.class_id=enrollment.class_id as valid
    from public.enrollments enrollment join current_year year on year.id=enrollment.academic_year_id
    join public.students pupil on pupil.id=enrollment.student_id
    left join classes class on class.id=enrollment.class_id
    left join sections section on section.id=enrollment.section_id
    where enrollment.status='active'
  ), roster as materialized(select * from enrollments where valid is true),
  linked_students as materialized(
    select distinct roster.student_id from roster
    join public.student_parents link on link.student_id=roster.student_id
    join public.parents guardian on guardian.id=link.parent_id and guardian.school_id=p_school_id
    join public.profiles profile on profile.id=guardian.profile_id and profile.school_id=p_school_id and profile.is_active
    join auth.users account on account.id=profile.id and not coalesce(account.is_anonymous,false) and account.deleted_at is null
      and(account.banned_until is null or account.banned_until<=statement_timestamp())
      and(account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
    where exists(select 1 from public.user_roles membership
      where membership.user_id=profile.id and membership.school_id=p_school_id and membership.role='parent')
  ), history as materialized(select * from app_private.school_settings_audit where school_id=p_school_id
    order by revision desc limit 10)
  select jsonb_build_object(
    'school',jsonb_build_object('id',school.id,'name',school.name,'code',school.code,'board',school.board,
      'affiliation_no',school.affiliation_no,'address',school.address,'city',school.city,'state',school.state,
      'pincode',school.pincode,'phone',school.phone,'email',school.email,'website',school.website,'timezone',school.timezone,
      'revision',school.settings_revision),
    'can_edit',exists(select 1 from public.user_roles membership where membership.user_id=actor
      and((membership.role='super_admin' and membership.school_id is null) or(membership.role='school_admin' and membership.school_id=p_school_id))),
    'setup',jsonb_build_object('school_day',(statement_timestamp() at time zone 'Asia/Kolkata')::date,
      'current_year',(select jsonb_build_object('id',id,'name',name,'start_date',start_date,'end_date',end_date) from current_year),
      'current_year_count',(select count(*) from years),'active_classes',(select count(*) from classes),
      'sections',(select count(*) from sections),'classes_without_sections',(select count(*) from classes class
        where not exists(select 1 from sections section where section.class_id=class.id)),
      'active_subjects',(select count(*) from public.subjects where school_id=p_school_id and is_active),
      'teachers',(select count(*) from public.teachers where school_id=p_school_id),
      'linked_teachers',(select count(*) from linked_teachers),'teaching_assignments',(select count(*) from assignments),
      'sections_without_class_teacher',(select count(*) from sections section where not exists(select 1 from assignments assignment
        where assignment.is_class_teacher and assignment.class_id=section.class_id
          and(assignment.section_id is null or assignment.section_id=section.id))),
      'enrolled_students',(select count(*) from roster),'invalid_enrollments',(select count(*) from enrollments where valid is not true),
      'linked_students',(select count(*) from linked_students),
      'pending_guardian_invitations',(select count(*) from app_private.guardian_invitations invitation
        join roster on roster.student_id=invitation.student_id where invitation.school_id=p_school_id
        and invitation.accepted_at is null and invitation.revoked_at is null and invitation.expires_at>statement_timestamp()),
      'today_attendance',(select count(*) from public.attendance attendance join roster on roster.student_id=attendance.student_id
        where attendance.school_id=p_school_id and attendance.academic_year_id=roster.academic_year_id
          and attendance.attendance_date=(statement_timestamp() at time zone 'Asia/Kolkata')::date)),
    'history',coalesce((select jsonb_agg(jsonb_build_object('id',history.id,'revision',history.revision,
      'changed_at',history.changed_at,'actor_name',nullif(left(btrim(profile.full_name),160),''),'changed_fields',history.changed_fields)
      order by history.revision desc) from history left join public.profiles profile
      on profile.id=history.actor_id and profile.school_id=p_school_id),'[]'::jsonb)) into response
  from public.schools school where school.id=p_school_id;
  return response;
end;
$function$;

create function app_private.save_school_settings(p_school_id uuid,p_expected_revision integer,p_request_id uuid,p_details jsonb,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  actor uuid:=app_private.school_settings_actor(p_school_id,true);
  previous public.schools%rowtype;
  receipt app_private.school_settings_receipts%rowtype;
  fields text[]:=array['name','board','affiliation_no','address','city','state','pincode','phone','email','website'];
  field text; value text; normalized jsonb:='{}'; before_details jsonb; changed_fields text[];
  reason text:=btrim(p_reason); payload jsonb;
  revision integer; changed boolean; authority text;
begin
  if p_request_id is null or p_expected_revision is null or p_expected_revision<0
    or reason is null or char_length(reason) not between 5 and 300 or reason~'[[:cntrl:]]'
    or p_details is null or jsonb_typeof(p_details)<>'object' then
    raise exception 'Reload school settings and enter valid details with a change reason.' using errcode='22023'; end if;
  if(select count(*) from jsonb_object_keys(p_details))<>cardinality(fields)
    or exists(select 1 from jsonb_object_keys(p_details) key where not key=any(fields)) then
    raise exception 'Only the supported school profile fields may be changed.' using errcode='22023'; end if;
  foreach field in array fields loop
    if jsonb_typeof(p_details->field) not in('string','null') then
      raise exception 'Enter school profile fields as text or empty values.' using errcode='22023'; end if;
    value:=nullif(btrim(p_details->>field),'');
    if field='address' then value:=replace(replace(value,E'\r\n',E'\n'),E'\r',E'\n'); end if;
    if (case when field='address' then replace(value,E'\n','') else value end)~'[[:cntrl:]]'
      or char_length(value)>(case field when 'name' then 160 when 'address' then 1000
        when 'phone' then 24 when 'email' then 254 when 'website' then 300 else 100 end) then
      raise exception 'A school profile field contains unsupported characters or is too long.' using errcode='22023'; end if;
    if field='name' and(value is null or char_length(value)<2) then raise exception 'Enter a school name of 2 to 160 characters.' using errcode='22023'; end if;
    if field='board' and value is not null and value not in('CBSE','UP_BOARD') then raise exception 'Choose an available school board.' using errcode='22023'; end if;
    if field='pincode' and value is not null and value!~'^[0-9]{6}$' then raise exception 'Enter a six-digit pincode.' using errcode='22023'; end if;
    if field='phone' and value is not null and(value!~'^\+?[0-9][0-9 ()-]*$'
      or char_length(regexp_replace(value,'[^0-9]','','g')) not between 7 and 15) then
      raise exception 'Enter a valid school office phone number.' using errcode='22023'; end if;
    if field='email' and value is not null then
      if value!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid school email address.' using errcode='22023'; end if;
      value:=lower(value);
    end if;
    if field='website' and value is not null then
      authority:=substring(value from '^https://([^/?#]+)');
      if value~'[[:space:]\\]' or authority is null or authority!~'^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'
        or(authority~':[0-9]+$' and split_part(authority,':',2)::integer not between 1 and 65535) then
        raise exception 'Use an HTTPS website without credentials or spaces.' using errcode='22023'; end if;
    end if;
    normalized:=normalized||jsonb_build_object(field,value);
  end loop;
  payload:=jsonb_build_object('school_id',p_school_id,'expected_revision',p_expected_revision,'details',p_details,'reason',p_reason);
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,0));
  select * into receipt from app_private.school_settings_receipts where actor_id=actor and request_id=p_request_id;
  if found then
    if receipt.payload<>payload then raise exception 'This settings retry belongs to different input.' using errcode='PT409'; end if;
    return jsonb_build_object('revision',receipt.revision,'changed',receipt.changed,'replayed',true);
  end if;
  select * into previous from public.schools where id=p_school_id;
  if previous.settings_revision<>p_expected_revision then raise exception 'School settings changed. Reload before saving.' using errcode='PT409'; end if;
  select jsonb_object_agg(item.key,item.value) into before_details from jsonb_each(to_jsonb(previous)) item where item.key=any(fields);
  select coalesce(array_agg(item.field order by item.field),'{}'::text[]) into changed_fields from unnest(fields) item(field)
    where before_details->item.field is distinct from normalized->item.field;
  changed:=cardinality(changed_fields)>0; revision:=previous.settings_revision;
  if changed then
    if revision=2147483647 then raise exception 'The school settings revision limit requires administrator support.' using errcode='22023'; end if;
    revision:=revision+1;
    update public.schools set name=normalized->>'name',board=(normalized->>'board')::public.board_type,
      affiliation_no=normalized->>'affiliation_no',address=normalized->>'address',city=normalized->>'city',state=normalized->>'state',
      pincode=normalized->>'pincode',phone=normalized->>'phone',email=normalized->>'email',website=normalized->>'website',
      settings_revision=revision,updated_at=clock_timestamp() where id=p_school_id;
    insert into app_private.school_settings_audit(school_id,revision,actor_id,request_id,before_details,after_details,changed_fields,reason)
      values(p_school_id,revision,actor,p_request_id,before_details,normalized,changed_fields,reason);
  end if;
  insert into app_private.school_settings_receipts(actor_id,request_id,school_id,payload,revision,changed)
    values(actor,p_request_id,p_school_id,payload,revision,changed);
  return jsonb_build_object('revision',revision,'changed',changed,'replayed',false);
end;
$function$;

create function public.get_school_settings(p_school_id uuid)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.get_school_settings(p_school_id); $$;
create function public.save_school_settings(p_school_id uuid,p_expected_revision integer,p_request_id uuid,p_details jsonb,p_reason text)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.save_school_settings(p_school_id,p_expected_revision,p_request_id,p_details,p_reason); $$;
revoke all on function app_private.school_settings_actor(uuid,boolean),app_private.get_school_settings(uuid),
  app_private.save_school_settings(uuid,integer,uuid,jsonb,text),public.get_school_settings(uuid),
  public.save_school_settings(uuid,integer,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function app_private.get_school_settings(uuid),app_private.save_school_settings(uuid,integer,uuid,jsonb,text),
  public.get_school_settings(uuid),public.save_school_settings(uuid,integer,uuid,jsonb,text) to authenticated;

notify pgrst,'reload schema';
commit;
