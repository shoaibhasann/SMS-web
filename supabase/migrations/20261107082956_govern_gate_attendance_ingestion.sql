begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $contracts$begin
 if to_regprocedure('app_private.guardian_recovery_office(uuid)') is null
  or to_regclass('app_private.student_leave_requests') is null
  or to_regclass('app_private.attendance_corrections') is null
  or to_regclass('app_private.roster_placement_changes') is null
  or not exists(select 1 from pg_attribute where attrelid='public.attendance'::regclass and attname='revision' and not attisdropped)
  or has_schema_privilege('authenticated','app_private','CREATE')
  or has_schema_privilege('anon','app_private','CREATE') then
  raise exception 'The governed native identity, roster and attendance contracts are required.';
 end if;
end;$contracts$;

create table app_private.gate_devices(
 id uuid primary key,school_id uuid not null references public.schools(id),
 name text not null check(char_length(name) between 1 and 80),
 secret_hash bytea not null check(octet_length(secret_hash)=32),
 late_after time not null,working_days integer[] not null,
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default clock_timestamp(),
 revoked_at timestamptz,revoked_by uuid references public.profiles(id),revoke_reason text,
 check(cardinality(working_days) between 1 and 7 and working_days <@ array[0,1,2,3,4,5,6]),
 check((revoked_at is null and revoked_by is null and revoke_reason is null)
   or(revoked_at is not null and revoked_by is not null and char_length(revoke_reason) between 5 and 300))
);
create unique index gate_devices_one_active_school on app_private.gate_devices(school_id) where revoked_at is null;
create index gate_devices_school_history on app_private.gate_devices(school_id,created_at desc,id);

create table app_private.gate_student_mappings(
 id uuid primary key,device_id uuid not null references app_private.gate_devices(id),
 subject_id text not null check(subject_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 student_id uuid not null references public.students(id),valid_from date not null,
 created_by uuid not null references public.profiles(id),created_at timestamptz not null default clock_timestamp(),
 revoked_at timestamptz,revoked_by uuid references public.profiles(id),revoke_reason text,
 unique(device_id,subject_id),
 check((revoked_at is null and revoked_by is null and revoke_reason is null)
   or(revoked_at is not null and revoked_by is not null and char_length(revoke_reason) between 5 and 300))
);
create unique index gate_mappings_one_active_student on app_private.gate_student_mappings(device_id,student_id) where revoked_at is null;
create index gate_mappings_device_page on app_private.gate_student_mappings(device_id,created_at desc,id);

create table app_private.gate_events(
 id uuid primary key default gen_random_uuid(),device_id uuid not null references app_private.gate_devices(id),
 school_id uuid not null references public.schools(id),source_event_id text not null check(source_event_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
 subject_id text not null check(subject_id ~ '^[A-Za-z0-9._:-]{1,128}$'),direction text not null check(direction in('IN','OUT')),
 occurred_at timestamptz not null check(isfinite(occurred_at)),received_at timestamptz not null default clock_timestamp(),
 mapping_id uuid references app_private.gate_student_mappings(id),student_id uuid references public.students(id),
 attendance_id uuid references public.attendance(id),attendance_status public.attendance_status,
 status text not null check(status in('accepted','held_review')),reason text not null,
 unique(device_id,source_event_id)
);
create index gate_events_school_page on app_private.gate_events(school_id,received_at desc,id);
create index gate_events_device_rate on app_private.gate_events(device_id,received_at);

create table app_private.gate_attendance_days(
 student_id uuid not null references public.students(id),attendance_date date not null,
 school_id uuid not null references public.schools(id),device_id uuid not null references app_private.gate_devices(id),
 attendance_id uuid not null unique references public.attendance(id),attendance_revision bigint not null,
 first_in_at timestamptz not null,source_event_id text not null,
 primary key(student_id,attendance_date)
);
alter table app_private.gate_devices enable row level security;
alter table app_private.gate_student_mappings enable row level security;
alter table app_private.gate_events enable row level security;
alter table app_private.gate_attendance_days enable row level security;
revoke all on app_private.gate_devices,app_private.gate_student_mappings,app_private.gate_events,
 app_private.gate_attendance_days from public,anon,authenticated,service_role;

create function app_private.gate_office_actor(p_school_id uuid)
returns uuid language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.guardian_recovery_office(p_school_id);begin
 perform 1 from public.profiles where id=actor and school_id=p_school_id and is_active for share;
 if not found then
  raise exception 'Current native School Admin or Principal access is required.' using errcode='42501';
 end if;
 perform 1 from public.user_roles where user_id=actor and school_id=p_school_id and role in('school_admin','principal') order by id for share;
 if not found then raise exception 'Current native School Admin or Principal access is required.' using errcode='42501';end if;
 return actor;
end;$$;

create function app_private.create_gate_device(p_school_id uuid,p_device_id uuid,p_name text,p_secret text,p_late_after text,p_working_days integer[])
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);device app_private.gate_devices%rowtype;days integer[];begin
 if p_device_id is null or p_name is null or p_name<>btrim(p_name) or char_length(p_name) not between 1 and 80
  or p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{43}$' or p_late_after is null or p_late_after !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or p_working_days is null or cardinality(p_working_days) not between 1 and 7 or array_position(p_working_days,null) is not null
  or not p_working_days <@ array[0,1,2,3,4,5,6] then
  raise exception 'Enter a device ID, name, random 32-byte secret, HH:MM cutoff and working days 0 to 6.' using errcode='22023';
 end if;
 select array_agg(day order by day) into days from(select distinct unnest(p_working_days) as day) d;
 if cardinality(days)<>cardinality(p_working_days) then raise exception 'Working days cannot repeat.' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('gate-device-setup:'||p_school_id::text,0));
 select * into device from app_private.gate_devices where id=p_device_id for update;
 if found then
  if(device.school_id,device.name,device.secret_hash,device.late_after,device.working_days,device.created_by)
   is distinct from(p_school_id,p_name,sha256(convert_to(p_secret,'UTF8')),p_late_after::time,days,actor) then
   raise exception 'This device ID already has different setup.' using errcode='PT409';end if;
 else
  if exists(select 1 from app_private.gate_devices where school_id=p_school_id and revoked_at is null) then
   raise exception 'Revoke the active gate device before replacing it.' using errcode='PT409';end if;
  insert into app_private.gate_devices(id,school_id,name,secret_hash,late_after,working_days,created_by)
   values(p_device_id,p_school_id,p_name,sha256(convert_to(p_secret,'UTF8')),p_late_after::time,days,actor) returning * into device;
 end if;
 return jsonb_build_object('device_id',device.id,'school_id',device.school_id,'name',device.name,'timezone','Asia/Kolkata',
  'late_after',to_char(device.late_after,'HH24:MI'),'working_days',device.working_days,'revoked_at',device.revoked_at);
end;$$;

create function app_private.revoke_gate_device(p_device_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid;school uuid;device app_private.gate_devices%rowtype;begin
 select school_id into school from app_private.gate_devices where id=p_device_id;
 actor:=app_private.gate_office_actor(school);
 if p_reason is null or p_reason<>btrim(p_reason) or char_length(p_reason) not between 5 and 300 then
  raise exception 'Enter a revocation reason between 5 and 300 characters.' using errcode='22023';end if;
 select * into device from app_private.gate_devices where id=p_device_id for update;
 if device.revoked_at is null then
  update app_private.gate_devices set revoked_at=clock_timestamp(),revoked_by=actor,revoke_reason=p_reason where id=p_device_id returning * into device;
 end if;
 return jsonb_build_object('device_id',device.id,'revoked_at',device.revoked_at);
end;$$;

create function app_private.map_gate_student(p_device_id uuid,p_mapping_id uuid,p_subject_id text,p_student_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid;school uuid;device app_private.gate_devices%rowtype;mapping app_private.gate_student_mappings%rowtype;begin
 select school_id into school from app_private.gate_devices where id=p_device_id;
 actor:=app_private.gate_office_actor(school);
 if p_mapping_id is null or p_subject_id is null or p_subject_id !~ '^[A-Za-z0-9._:-]{1,128}$' or p_student_id is null then
  raise exception 'Enter a mapping ID, device subject and school pupil.' using errcode='22023';end if;
 select * into device from app_private.gate_devices where id=p_device_id for update;
 if device.revoked_at is not null then raise exception 'The gate device has been revoked.' using errcode='42501';end if;
 perform 1 from public.students where id=p_student_id and school_id=school and status='active' for share;
 if not found then raise exception 'Choose an active pupil in this school.' using errcode='42501';end if;
 select * into mapping from app_private.gate_student_mappings where id=p_mapping_id for update;
 if found then
  if(mapping.device_id,mapping.subject_id,mapping.student_id,mapping.created_by) is distinct from(p_device_id,p_subject_id,p_student_id,actor) then
   raise exception 'This mapping ID already has different setup.' using errcode='PT409';end if;
 else
  if exists(select 1 from app_private.gate_student_mappings where device_id=p_device_id
   and(subject_id=p_subject_id or(student_id=p_student_id and revoked_at is null))) then
   raise exception 'This subject was already assigned, or this pupil already has an active subject. Revoke and use a new subject for replacement.' using errcode='PT409';end if;
  insert into app_private.gate_student_mappings(id,device_id,subject_id,student_id,valid_from,created_by)
   values(p_mapping_id,p_device_id,p_subject_id,p_student_id,(clock_timestamp() at time zone 'Asia/Kolkata')::date,actor) returning * into mapping;
 end if;
 return jsonb_build_object('mapping_id',mapping.id,'device_id',mapping.device_id,'subject_id',mapping.subject_id,
  'student_id',mapping.student_id,'valid_from',mapping.valid_from,'revoked_at',mapping.revoked_at);
end;$$;

create function app_private.revoke_gate_student_mapping(p_mapping_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid;school uuid;device uuid;mapping app_private.gate_student_mappings%rowtype;begin
 select d.school_id,d.id into school,device from app_private.gate_student_mappings m join app_private.gate_devices d on d.id=m.device_id where m.id=p_mapping_id;
 actor:=app_private.gate_office_actor(school);
 if p_reason is null or p_reason<>btrim(p_reason) or char_length(p_reason) not between 5 and 300 then
  raise exception 'Enter a revocation reason between 5 and 300 characters.' using errcode='22023';end if;
 perform 1 from app_private.gate_devices where id=device for update;
 select * into mapping from app_private.gate_student_mappings where id=p_mapping_id for update;
 if mapping.revoked_at is null then
  update app_private.gate_student_mappings set revoked_at=clock_timestamp(),revoked_by=actor,revoke_reason=p_reason where id=p_mapping_id returning * into mapping;
 end if;
 return jsonb_build_object('mapping_id',mapping.id,'revoked_at',mapping.revoked_at);
end;$$;

create function app_private.get_gate_setup(p_school_id uuid,p_offset integer)
returns jsonb language plpgsql security definer set search_path=''
as $$begin
 perform app_private.gate_office_actor(p_school_id);
 if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Choose a valid page offset.' using errcode='22023';end if;
 return jsonb_build_object('school_id',p_school_id,'timezone','Asia/Kolkata','page_size',100,'offset',p_offset,
  'devices',(select coalesce(jsonb_agg(row),'[]') from(select id as device_id,name,to_char(late_after,'HH24:MI') as late_after,working_days,created_at,revoked_at
   from app_private.gate_devices where school_id=p_school_id order by created_at desc,id limit 100) row),
  'mapping_count',(select count(*) from app_private.gate_student_mappings m join app_private.gate_devices d on d.id=m.device_id where d.school_id=p_school_id),
  'mappings',(select coalesce(jsonb_agg(row),'[]') from(select m.id as mapping_id,m.device_id,m.subject_id,m.student_id,m.valid_from,m.revoked_at,
   s.admission_no,concat_ws(' ',s.first_name,s.middle_name,s.last_name) as student_name
   from app_private.gate_student_mappings m join app_private.gate_devices d on d.id=m.device_id join public.students s on s.id=m.student_id and s.school_id=d.school_id
   where d.school_id=p_school_id order by m.created_at desc,m.id limit 100 offset p_offset) row));
end;$$;

create function app_private.list_gate_events(p_school_id uuid,p_offset integer)
returns jsonb language plpgsql security definer set search_path=''
as $$begin
 perform app_private.gate_office_actor(p_school_id);
 if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Choose a valid page offset.' using errcode='22023';end if;
 return jsonb_build_object('school_id',p_school_id,'page_size',100,'offset',p_offset,
  'total_count',(select count(*) from app_private.gate_events where school_id=p_school_id),
  'events',(select coalesce(jsonb_agg(row),'[]') from(select id as receipt_id,device_id,source_event_id as event_id,subject_id,direction,occurred_at,received_at,
   student_id,attendance_id,attendance_status,status,reason from app_private.gate_events where school_id=p_school_id
   order by received_at desc,id limit 100 offset p_offset) row));
end;$$;

create function app_private.ingest_gate_attendance_event(p_device_id uuid,p_secret text,p_event_id text,p_subject_id text,p_direction text,p_occurred_at timestamptz)
returns jsonb language plpgsql security definer set search_path=''
as $$declare device app_private.gate_devices%rowtype;mapping app_private.gate_student_mappings%rowtype;
 previous app_private.gate_events%rowtype;event app_private.gate_events%rowtype;mark public.attendance%rowtype;
 provenance app_private.gate_attendance_days%rowtype;placement record;school_day date;today date;
 v_status text:='held_review';reason text;desired public.attendance_status;placement_count integer;
begin
 if current_setting('role',true) is distinct from 'service_role' then
  raise exception 'Gate connector authentication failed.' using errcode='42501';end if;
 if p_device_id is null or p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{43}$' then
  raise exception 'Gate connector authentication failed.' using errcode='42501';end if;
 -- One terminal serializes its bounded event stream and its revocation/rate window.
 select school_id into device.school_id from app_private.gate_devices where id=p_device_id;
 perform 1 from public.schools where id=device.school_id and is_active for share;
 if not found then raise exception 'Gate connector authentication failed.' using errcode='42501';end if;
 select * into device from app_private.gate_devices where id=p_device_id for update;
 if not found or device.revoked_at is not null or device.secret_hash<>sha256(convert_to(p_secret,'UTF8')) then
  raise exception 'Gate connector authentication failed.' using errcode='42501';end if;
 if p_event_id is null or p_event_id !~ '^[A-Za-z0-9._:-]{1,128}$' or p_subject_id is null or p_subject_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  or p_direction is null or p_direction not in('IN','OUT') or p_occurred_at is null or not isfinite(p_occurred_at) then
  raise exception 'Enter a bounded event ID, subject, IN/OUT direction and finite event time.' using errcode='22023';end if;
 select * into previous from app_private.gate_events where device_id=p_device_id and source_event_id=p_event_id;
 if found then
  if(previous.subject_id,previous.direction,previous.occurred_at) is distinct from(p_subject_id,p_direction,p_occurred_at) then
   raise exception 'This device event ID already has a different payload.' using errcode='PT409';end if;
  return jsonb_build_object('receipt_id',previous.id,'event_id',previous.source_event_id,'status',previous.status,'reason',previous.reason,
   'attendance_id',previous.attendance_id,'attendance_status',previous.attendance_status,'duplicate',true);
 end if;
 if(select count(*) from app_private.gate_events where device_id=p_device_id and received_at>clock_timestamp()-interval '1 minute')>=600 then
  raise exception 'The device event rate limit was reached. Retry the same event later.' using errcode='PT429';end if;
 today:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
 school_day:=(p_occurred_at at time zone 'Asia/Kolkata')::date;
 select * into mapping from app_private.gate_student_mappings where device_id=p_device_id and subject_id=p_subject_id and revoked_at is null for share;
 if not found then reason:='unknown_subject';
 elsif school_day<mapping.valid_from or school_day<today then reason:='historical_date';
 elsif school_day>today or p_occurred_at>clock_timestamp()+interval '2 minutes' then reason:='future_clock';
 elsif not(extract(dow from school_day)::integer=any(device.working_days)) then reason:='non_working_day';
 else
  perform 1 from public.academic_years where school_id=device.school_id and is_current order by id for share;
  perform 1 from public.students where id=mapping.student_id and school_id=device.school_id and status='active' for share;
  if not found then reason:='student_inactive';else
   -- Today-only ingestion never guesses a past class after a move or promotion.
   perform pg_advisory_xact_lock(hashtextextended('gate-attendance:'||mapping.student_id::text||':'||school_day::text,0));
   select count(*) into placement_count from public.enrollments e join public.academic_years y on y.id=e.academic_year_id
    and y.school_id=device.school_id and y.is_current and school_day between y.start_date and y.end_date
    join public.classes c on c.id=e.class_id and c.school_id=device.school_id and c.is_active
    join public.sections sec on sec.id=e.section_id and sec.class_id=c.id and sec.school_id=device.school_id
    where e.student_id=mapping.student_id and e.status='active';
   if placement_count<>1 then reason:='enrollment_unavailable';else
    select e.academic_year_id,e.class_id,e.section_id into placement from public.enrollments e join public.academic_years y on y.id=e.academic_year_id
     and y.school_id=device.school_id and y.is_current and school_day between y.start_date and y.end_date
     join public.classes c on c.id=e.class_id and c.school_id=device.school_id and c.is_active
     join public.sections sec on sec.id=e.section_id and sec.class_id=c.id and sec.school_id=device.school_id
     where e.student_id=mapping.student_id and e.status='active' for share of e,y,c,sec;
    perform 1 from app_private.student_leave_requests where student_id=mapping.student_id and school_day between start_date and end_date order by id for share;
    if placement.academic_year_id is null then reason:='enrollment_unavailable';
    elsif exists(select 1 from app_private.roster_placement_changes where student_id=mapping.student_id and effective_date=school_day) then reason:='roster_date_conflict';
    elsif exists(select 1 from app_private.student_leave_requests where student_id=mapping.student_id and status='approved' and school_day between start_date and end_date) then reason:='approved_leave';
    elsif exists(select 1 from app_private.attendance_corrections where student_id=mapping.student_id and attendance_date=school_day and state in('pending','approved')) then reason:='reviewed_attendance';
    elsif p_direction='OUT' then v_status:='accepted';reason:='recorded_out';
    else
     desired:=case when(p_occurred_at at time zone 'Asia/Kolkata')::time>device.late_after then 'late'::public.attendance_status else 'present'::public.attendance_status end;
     select * into mark from public.attendance where student_id=mapping.student_id and attendance_date=school_day for update;
     if not found then
      insert into public.attendance(school_id,academic_year_id,section_id,student_id,attendance_date,status,marked_by)
       values(device.school_id,placement.academic_year_id,placement.section_id,mapping.student_id,school_day,desired,null)
       on conflict(student_id,attendance_date) do nothing returning * into mark;
      if found then
       insert into app_private.gate_attendance_days(student_id,attendance_date,school_id,device_id,attendance_id,attendance_revision,first_in_at,source_event_id)
        values(mapping.student_id,school_day,device.school_id,p_device_id,mark.id,mark.revision,p_occurred_at,p_event_id);
       v_status:='accepted';reason:='marked_'||desired::text;
      else reason:='manual_or_changed_mark';end if;
     else
      select * into provenance from app_private.gate_attendance_days where student_id=mapping.student_id and attendance_date=school_day for update;
      if not found or(provenance.attendance_id,provenance.attendance_revision,provenance.school_id,provenance.device_id)
        is distinct from(mark.id,mark.revision,device.school_id,p_device_id)
       or(mark.school_id,mark.academic_year_id,mark.section_id) is distinct from(device.school_id,placement.academic_year_id,placement.section_id)
       or mark.marked_by is not null or mark.status not in('present','late') then reason:='manual_or_changed_mark';
      elsif p_occurred_at>=provenance.first_in_at then v_status:='accepted';reason:='already_marked';
      else
       if mark.status is distinct from desired then
        update public.attendance set status=desired where id=mark.id and revision=provenance.attendance_revision returning * into mark;
       end if;
       update app_private.gate_attendance_days set first_in_at=p_occurred_at,source_event_id=p_event_id,attendance_revision=mark.revision
        where student_id=mapping.student_id and attendance_date=school_day;
       v_status:='accepted';reason:='earlier_in_applied';
      end if;
     end if;
    end if;
   end if;
  end if;
 end if;
 insert into app_private.gate_events(device_id,school_id,source_event_id,subject_id,direction,occurred_at,mapping_id,student_id,attendance_id,attendance_status,status,reason)
  values(p_device_id,device.school_id,p_event_id,p_subject_id,p_direction,p_occurred_at,mapping.id,mapping.student_id,mark.id,mark.status,v_status,reason) returning * into event;
 return jsonb_build_object('receipt_id',event.id,'event_id',event.source_event_id,'status',event.status,'reason',event.reason,
  'attendance_id',event.attendance_id,'attendance_status',event.attendance_status,'duplicate',false);
end;$$;

create function public.create_gate_device(p_school_id uuid,p_device_id uuid,p_name text,p_secret text,p_late_after text,p_working_days integer[])
returns jsonb language sql security invoker set search_path='' as $$select app_private.create_gate_device(p_school_id,p_device_id,p_name,p_secret,p_late_after,p_working_days);$$;
create function public.revoke_gate_device(p_device_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path='' as $$select app_private.revoke_gate_device(p_device_id,p_reason);$$;
create function public.map_gate_student(p_device_id uuid,p_mapping_id uuid,p_subject_id text,p_student_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select app_private.map_gate_student(p_device_id,p_mapping_id,p_subject_id,p_student_id);$$;
create function public.revoke_gate_student_mapping(p_mapping_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path='' as $$select app_private.revoke_gate_student_mapping(p_mapping_id,p_reason);$$;
create function public.get_gate_setup(p_school_id uuid,p_offset integer default 0)
returns jsonb language sql security invoker set search_path='' as $$select app_private.get_gate_setup(p_school_id,p_offset);$$;
create function public.list_gate_events(p_school_id uuid,p_offset integer default 0)
returns jsonb language sql security invoker set search_path='' as $$select app_private.list_gate_events(p_school_id,p_offset);$$;
create function public.ingest_gate_attendance_event(p_device_id uuid,p_secret text,p_event_id text,p_subject_id text,p_direction text,p_occurred_at timestamptz)
returns jsonb language sql security invoker set search_path='' as $$select app_private.ingest_gate_attendance_event(p_device_id,p_secret,p_event_id,p_subject_id,p_direction,p_occurred_at);$$;

revoke all on function app_private.gate_office_actor(uuid) from public,anon,authenticated,service_role;
do $permissions$declare signature text;begin
 foreach signature in array array[
  'create_gate_device(uuid,uuid,text,text,text,integer[])','revoke_gate_device(uuid,text)',
  'map_gate_student(uuid,uuid,text,uuid)','revoke_gate_student_mapping(uuid,text)','get_gate_setup(uuid,integer)','list_gate_events(uuid,integer)'
 ] loop
  execute 'revoke all on function public.'||signature||',app_private.'||signature||' from public,anon,authenticated,service_role';
  execute 'grant execute on function public.'||signature||',app_private.'||signature||' to authenticated';
 end loop;
end;$permissions$;
revoke all on function public.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz),app_private.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz)
 from public,anon,authenticated,service_role;
grant execute on function public.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz),app_private.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz) to service_role;
notify pgrst,'reload schema';
commit;
