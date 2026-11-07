begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Native gate policy, ingestion, immutable receipts and canonical attendance are unchanged.
create or replace function app_private.create_gate_device(p_school_id uuid,p_device_id uuid,p_name text,p_secret text,p_late_after text,p_working_days integer[])
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);device app_private.gate_devices%rowtype;days integer[];begin
 if p_device_id is null or p_name is null or p_name<>btrim(p_name) or char_length(p_name) not between 1 and 80
  or p_name ~ '[[:cntrl:]]' or p_name ~ U&'[\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069]'
  or p_secret is null or p_secret !~ '^[A-Za-z0-9_-]{43}$' or p_late_after is null or p_late_after !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or p_working_days is null or cardinality(p_working_days) not between 1 and 7 or array_position(p_working_days,null) is not null
  or not p_working_days <@ array[0,1,2,3,4,5,6] then
  raise exception 'Enter a device ID, name, random 32-byte secret, HH:MM cutoff and working days 0 to 6.' using errcode='22023';
 end if;
 select array_agg(day order by day) into days from(select distinct unnest(p_working_days) as day) d;
 if cardinality(days)<>cardinality(p_working_days) then raise exception 'Working days cannot repeat.' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('gate-device-setup:'||p_school_id::text,0));
 perform app_private.gate_office_actor(p_school_id);
 select * into device from app_private.gate_devices where id=p_device_id for update;
 perform app_private.gate_office_actor(p_school_id);
 if device.id is not null then
  if(device.school_id,device.name,device.secret_hash,device.late_after,device.working_days,device.created_by)
   is distinct from(p_school_id,p_name,sha256(convert_to(p_secret,'UTF8')),p_late_after::time,days,actor) then
   raise exception 'This device ID already has different setup.' using errcode='PT409';end if;
 else
  if exists(select 1 from app_private.gate_devices where school_id=p_school_id and revoked_at is null) then
   raise exception 'Revoke the active gate device before replacing it.' using errcode='PT409';end if;
  insert into app_private.gate_devices(id,school_id,name,secret_hash,late_after,working_days,created_by)
   values(p_device_id,p_school_id,p_name,sha256(convert_to(p_secret,'UTF8')),p_late_after::time,days,actor) returning * into device;
 end if;
 perform app_private.gate_office_actor(p_school_id);
 return jsonb_build_object('user_id',actor,'device_id',device.id,'school_id',device.school_id,'name',device.name,'timezone','Asia/Kolkata',
  'late_after',to_char(device.late_after,'HH24:MI'),'working_days',device.working_days,'revoked_at',device.revoked_at);
end;$$;

create or replace function app_private.revoke_gate_device(p_device_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid;school uuid;device app_private.gate_devices%rowtype;begin
 select school_id into school from app_private.gate_devices where id=p_device_id;
 actor:=app_private.gate_office_actor(school);
 if p_reason is null or p_reason<>btrim(p_reason) or char_length(p_reason) not between 5 and 300
  or p_reason ~ '[[:cntrl:]]' or p_reason ~ U&'[\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069]' then
  raise exception 'Enter a revocation reason between 5 and 300 characters.' using errcode='22023';end if;
 select * into device from app_private.gate_devices where id=p_device_id for update;
 if not found or device.school_id is distinct from school then raise exception 'The school gate device is unavailable.' using errcode='42501';end if;
 perform app_private.gate_office_actor(school);
 if device.revoked_at is null then
  update app_private.gate_devices set revoked_at=clock_timestamp(),revoked_by=actor,revoke_reason=p_reason where id=p_device_id returning * into device;
 end if;
 perform app_private.gate_office_actor(school);
 return jsonb_build_object('user_id',actor,'school_id',school,'device_id',device.id,'revoked_at',device.revoked_at);
end;$$;

create or replace function app_private.map_gate_student(p_device_id uuid,p_mapping_id uuid,p_subject_id text,p_student_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid;school uuid;device app_private.gate_devices%rowtype;mapping app_private.gate_student_mappings%rowtype;begin
 select school_id into school from app_private.gate_devices where id=p_device_id;
 actor:=app_private.gate_office_actor(school);
 if p_mapping_id is null or p_subject_id is null or p_subject_id !~ '^[A-Za-z0-9._:-]{1,128}$' or p_student_id is null then
  raise exception 'Enter a mapping ID, device subject and school pupil.' using errcode='22023';end if;
 select * into device from app_private.gate_devices where id=p_device_id for update;
 if not found or device.school_id is distinct from school then raise exception 'The school gate device is unavailable.' using errcode='42501';end if;
 perform app_private.gate_office_actor(school);
 if device.revoked_at is not null then raise exception 'The gate device has been revoked.' using errcode='42501';end if;
 perform 1 from public.students where id=p_student_id and school_id=school and status='active' for share;
 if not found then raise exception 'Choose an active pupil in this school.' using errcode='42501';end if;
 perform app_private.gate_office_actor(school);
 select * into mapping from app_private.gate_student_mappings where id=p_mapping_id for update;
 perform app_private.gate_office_actor(school);
 if mapping.id is not null then
  if(mapping.device_id,mapping.subject_id,mapping.student_id,mapping.created_by) is distinct from(p_device_id,p_subject_id,p_student_id,actor) then
   raise exception 'This mapping ID already has different setup.' using errcode='PT409';end if;
 else
  if exists(select 1 from app_private.gate_student_mappings where device_id=p_device_id
   and(subject_id=p_subject_id or(student_id=p_student_id and revoked_at is null))) then
   raise exception 'This subject was already assigned, or this pupil already has an active subject. Revoke and use a new subject for replacement.' using errcode='PT409';end if;
  insert into app_private.gate_student_mappings(id,device_id,subject_id,student_id,valid_from,created_by)
   values(p_mapping_id,p_device_id,p_subject_id,p_student_id,(clock_timestamp() at time zone 'Asia/Kolkata')::date,actor) returning * into mapping;
 end if;
 perform app_private.gate_office_actor(school);
 return jsonb_build_object('user_id',actor,'school_id',school,'mapping_id',mapping.id,'device_id',mapping.device_id,'subject_id',mapping.subject_id,
  'student_id',mapping.student_id,'valid_from',mapping.valid_from,'revoked_at',mapping.revoked_at);
end;$$;

create or replace function app_private.revoke_gate_student_mapping(p_mapping_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid;school uuid;device uuid;mapping app_private.gate_student_mappings%rowtype;begin
 select d.school_id,d.id into school,device from app_private.gate_student_mappings m join app_private.gate_devices d on d.id=m.device_id where m.id=p_mapping_id;
 actor:=app_private.gate_office_actor(school);
 if p_reason is null or p_reason<>btrim(p_reason) or char_length(p_reason) not between 5 and 300
  or p_reason ~ '[[:cntrl:]]' or p_reason ~ U&'[\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069]' then
  raise exception 'Enter a revocation reason between 5 and 300 characters.' using errcode='22023';end if;
 perform 1 from app_private.gate_devices where id=device and school_id=school for update;
 if not found then raise exception 'The school gate device is unavailable.' using errcode='42501';end if;
 perform app_private.gate_office_actor(school);
 select * into mapping from app_private.gate_student_mappings where id=p_mapping_id for update;
 if not found or mapping.device_id is distinct from device then raise exception 'The school gate mapping is unavailable.' using errcode='42501';end if;
 perform app_private.gate_office_actor(school);
 if mapping.revoked_at is null then
  update app_private.gate_student_mappings set revoked_at=clock_timestamp(),revoked_by=actor,revoke_reason=p_reason where id=p_mapping_id returning * into mapping;
 end if;
 perform app_private.gate_office_actor(school);
 return jsonb_build_object('user_id',actor,'school_id',school,'mapping_id',mapping.id,'revoked_at',mapping.revoked_at);
end;$$;

create or replace function app_private.get_gate_setup(p_school_id uuid,p_offset integer)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);result jsonb;begin
 if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Choose a valid page offset.' using errcode='22023';end if;
 result:=jsonb_build_object('user_id',actor,'school_id',p_school_id,'timezone','Asia/Kolkata','page_size',100,'offset',p_offset,
  'device_count',(select count(*) from app_private.gate_devices where school_id=p_school_id),
  'devices',(select coalesce(jsonb_agg(row),'[]') from(select id as device_id,name,to_char(late_after,'HH24:MI') as late_after,working_days,created_at,revoked_at
   from app_private.gate_devices where school_id=p_school_id order by(revoked_at is null) desc,created_at desc,id limit 100) row),
  'mapping_count',(select count(*) from app_private.gate_student_mappings m join app_private.gate_devices d on d.id=m.device_id where d.school_id=p_school_id),
  'mappings',(select coalesce(jsonb_agg(row),'[]') from(select m.id as mapping_id,m.device_id,m.subject_id,m.student_id,m.valid_from,m.revoked_at,
   s.admission_no,concat_ws(' ',s.first_name,s.middle_name,s.last_name) as student_name
   from app_private.gate_student_mappings m join app_private.gate_devices d on d.id=m.device_id join public.students s on s.id=m.student_id and s.school_id=d.school_id
   where d.school_id=p_school_id order by m.created_at desc,m.id limit 100 offset p_offset) row));
 if actor is distinct from app_private.gate_office_actor(p_school_id) then raise exception 'Your school gate access changed.' using errcode='42501';end if;
 return result;
end;$$;

create or replace function app_private.list_gate_events(p_school_id uuid,p_offset integer)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);result jsonb;begin
 if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Choose a valid page offset.' using errcode='22023';end if;
 result:=jsonb_build_object('user_id',actor,'school_id',p_school_id,'page_size',100,'offset',p_offset,
  'device_count',(select count(*) from app_private.gate_devices where school_id=p_school_id),
  'total_count',(select count(*) from app_private.gate_events where school_id=p_school_id),
  'events',(select coalesce(jsonb_agg(row),'[]') from(select e.id as receipt_id,e.device_id,e.source_event_id as event_id,e.subject_id,e.direction,e.occurred_at,e.received_at,
   e.student_id,e.attendance_id,e.attendance_status,e.status,e.reason,d.name as device_name,
   case when s.id is not null then concat_ws(' ',s.first_name,s.middle_name,s.last_name) end as student_name,s.admission_no
   from app_private.gate_events e left join app_private.gate_devices d on d.id=e.device_id and d.school_id=e.school_id
   left join public.students s on s.id=e.student_id and s.school_id=e.school_id where e.school_id=p_school_id
   order by e.received_at desc,e.id limit 100 offset p_offset) row));
 if actor is distinct from app_private.gate_office_actor(p_school_id) then raise exception 'Your school gate access changed.' using errcode='42501';end if;
 return result;
end;$$;

create function app_private.search_gate_pupils(p_school_id uuid,p_query text,p_offset integer default 0)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);query text:=btrim(p_query);result jsonb;begin
 if query is null or char_length(query) not between 2 and 80 or query ~ '[[:cntrl:]]'
  or query ~ U&'[\007F-\009F\061C\200E\200F\2028-\202E\2066-\2069]'
  or p_offset is null or p_offset<0 or p_offset>1000000 then
  raise exception 'Search with 2 to 80 characters and a valid page offset.' using errcode='22023';end if;
 with matches as materialized(
  select s.id as student_id,btrim(concat_ws(' ',nullif(btrim(s.first_name),''),nullif(btrim(s.middle_name),''),nullif(btrim(s.last_name),''))) as student_name,s.admission_no
  from public.students s where s.school_id=p_school_id and s.status='active'
   and(strpos(lower(s.admission_no),lower(query))>0 or strpos(lower(concat_ws(' ',nullif(btrim(s.first_name),''),nullif(btrim(s.middle_name),''),nullif(btrim(s.last_name),''))),lower(query))>0)
 ) select jsonb_build_object('user_id',actor,'school_id',p_school_id,'query',query,'offset',p_offset,'page_size',25,
  'total_count',(select count(*) from matches),'pupils',coalesce((select jsonb_agg(row) from(
   select * from matches order by student_name,admission_no,student_id limit 25 offset p_offset) row),'[]'::jsonb)) into result;
 if actor is distinct from app_private.gate_office_actor(p_school_id) then raise exception 'Your school gate access changed.' using errcode='42501';end if;
 return result;
end;$$;
create function public.search_gate_pupils(p_school_id uuid,p_query text,p_offset integer default 0)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.search_gate_pupils(p_school_id,p_query,p_offset);$$;
revoke all on function app_private.search_gate_pupils(uuid,text,integer),public.search_gate_pupils(uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function app_private.search_gate_pupils(uuid,text,integer),public.search_gate_pupils(uuid,text,integer) to authenticated;
notify pgrst,'reload schema';
commit;
