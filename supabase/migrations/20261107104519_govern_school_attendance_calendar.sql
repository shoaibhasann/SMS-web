begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

create table app_private.school_attendance_policy_versions(
 school_id uuid not null references public.schools(id),revision bigint not null check(revision between 1 and 2147483647),
 effective_from date not null check(isfinite(effective_from)),working_days integer[] not null,
 correction_window_days integer not null check(correction_window_days between 0 and 365),
 reason text not null check(char_length(reason) between 5 and 300),actor_id uuid not null references public.profiles(id),
 request_id uuid not null,created_at timestamptz not null default clock_timestamp(),primary key(school_id,revision),
 check(cardinality(working_days) between 1 and 7 and array_position(working_days,null) is null and working_days <@ array[0,1,2,3,4,5,6])
);
create index school_attendance_policy_effective on app_private.school_attendance_policy_versions(school_id,effective_from desc,revision desc);
create table app_private.school_attendance_day_exceptions(
 school_id uuid not null references public.schools(id),revision bigint not null check(revision between 1 and 2147483647),
 day date not null check(isfinite(day)),mode text not null check(mode in('holiday','working','inherit')),label text,
 reason text not null check(char_length(reason) between 5 and 300),actor_id uuid not null references public.profiles(id),
 request_id uuid not null,created_at timestamptz not null default clock_timestamp(),primary key(school_id,revision),
 check((mode='inherit' and label is null) or(mode<>'inherit' and label is not null and char_length(label) between 1 and 120))
);
create index school_attendance_exception_day on app_private.school_attendance_day_exceptions(school_id,day,revision desc);
create table app_private.school_attendance_calendar_receipts(
 actor_id uuid not null references public.profiles(id),request_id uuid not null,school_id uuid not null references public.schools(id),
 payload jsonb not null,response jsonb not null,created_at timestamptz not null default clock_timestamp(),primary key(actor_id,request_id)
);
create index school_attendance_receipts_school on app_private.school_attendance_calendar_receipts(school_id,created_at desc);
alter table app_private.school_attendance_policy_versions enable row level security;
alter table app_private.school_attendance_day_exceptions enable row level security;
alter table app_private.school_attendance_calendar_receipts enable row level security;
revoke all on app_private.school_attendance_policy_versions,app_private.school_attendance_day_exceptions,
 app_private.school_attendance_calendar_receipts from public,anon,authenticated,service_role;
-- Retain legacy records/read access, but never let Teacher-managed legacy rows decide the calendar.
revoke insert,update,delete,truncate,references,trigger on public.school_holidays from public,anon,authenticated,service_role;
alter table app_private.gate_events add column calendar_policy_revision bigint,add column calendar_exception_revision bigint;

create function app_private.attendance_calendar_revision(p_school_id uuid)
returns bigint language sql volatile security definer set search_path=''
as $$select greatest(coalesce((select max(revision) from app_private.school_attendance_policy_versions where school_id=p_school_id),0),
 coalesce((select max(revision) from app_private.school_attendance_day_exceptions where school_id=p_school_id),0));$$;

-- VOLATILE takes a fresh snapshot after a shared advisory-lock wait.
create function app_private.resolve_attendance_calendar_day(p_school_id uuid,p_day date)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare policy app_private.school_attendance_policy_versions%rowtype;exception app_private.school_attendance_day_exceptions%rowtype;
begin
 select * into policy from app_private.school_attendance_policy_versions where school_id=p_school_id and effective_from<=p_day
  order by effective_from desc,revision desc limit 1;
 if not found then return jsonb_build_object('day',p_day,'configured',false,'is_working',null,'source','unconfigured',
  'label',null,'policy_revision',null,'exception_revision',null,'correction_window_days',null);end if;
 select * into exception from app_private.school_attendance_day_exceptions where school_id=p_school_id and day=p_day order by revision desc limit 1;
 return jsonb_build_object('day',p_day,'configured',true,
  'is_working',case when exception.mode='holiday' then false when exception.mode='working' then true else extract(dow from p_day)::integer=any(policy.working_days) end,
  'source',case when exception.mode in('holiday','working') then 'exception' else 'weekday' end,
  'label',case when exception.mode in('holiday','working') then exception.label end,
  'policy_revision',policy.revision,'exception_revision',exception.revision,'correction_window_days',policy.correction_window_days);
end;$$;

create function app_private.attendance_calendar_actor(p_school_id uuid)
returns uuid language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.student_leave_actor();begin
 if not app_private.staff_mfa_allowed() then raise exception 'Verify your school authenticator.' using errcode='42501';end if;
 perform 1 from public.profiles where id=actor and school_id=p_school_id and is_active for share;
 if not found then raise exception 'Current school staff access is required.' using errcode='42501';end if;
 perform 1 from public.user_roles where user_id=actor and school_id=p_school_id and role in('school_admin','principal','teacher') order by id for share;
 if not found then raise exception 'Current school staff access is required.' using errcode='42501';end if;
 perform 1 from public.schools where id=p_school_id and is_active for share;
 if not found then raise exception 'Current school staff access is required.' using errcode='42501';end if;
 return actor;
end;$$;
create function app_private.attendance_calendar_can_edit(p_school_id uuid)
returns boolean language sql stable security definer set search_path=''
as $$select coalesce(auth.jwt()->>'aal'='aal2' and app_private.staff_mfa_allowed() and exists(select 1 from public.profiles p
 join public.user_roles r on r.user_id=p.id and r.school_id=p.school_id and r.role in('school_admin','principal')
 where p.id=auth.uid() and p.school_id=p_school_id and p.is_active) and app_private.has_live_school_session()
 and exists(select 1 from auth.sessions session join auth.mfa_factors factor on factor.id=session.factor_id
  and factor.user_id=session.user_id and factor.factor_type='totp' and factor.status='verified'
  where session.id=case when auth.jwt()->>'session_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   then(auth.jwt()->>'session_id')::uuid end and session.user_id=auth.uid() and session.aal='aal2'
   and(session.not_after is null or session.not_after>statement_timestamp())),false);$$;

create function app_private.get_school_attendance_calendar(p_school_id uuid,p_from date,p_to date)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.attendance_calendar_actor(p_school_id);begin
 if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from<date '0001-01-01' or p_to>date '9999-12-31'
  or p_to<p_from or p_to-p_from>365 then raise exception 'Choose an inclusive calendar range of up to 366 days.' using errcode='22023';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 return jsonb_build_object('user_id',actor,'school_id',p_school_id,'revision',app_private.attendance_calendar_revision(p_school_id),
  'can_edit',app_private.attendance_calendar_can_edit(p_school_id),'server_today',(statement_timestamp() at time zone 'Asia/Kolkata')::date,
  'timezone','Asia/Kolkata','from',p_from,'to',p_to,'history_limit',50,
  'policy_count',(select count(*) from app_private.school_attendance_policy_versions where school_id=p_school_id),
  'exception_count',(select count(*) from app_private.school_attendance_day_exceptions where school_id=p_school_id),
  'policies',coalesce((select jsonb_agg(to_jsonb(row) order by revision desc) from(select revision,effective_from,working_days,correction_window_days,reason,actor_id,created_at
   from app_private.school_attendance_policy_versions where school_id=p_school_id order by revision desc limit 50) row),'[]'::jsonb),
  'exceptions',coalesce((select jsonb_agg(to_jsonb(row) order by revision desc) from(select revision,day,mode,label,reason,actor_id,created_at
   from app_private.school_attendance_day_exceptions where school_id=p_school_id order by revision desc limit 50) row),'[]'::jsonb),
  'days',(select jsonb_agg(app_private.resolve_attendance_calendar_day(p_school_id,p_from+day) order by day) from generate_series(0,p_to-p_from) day));
end;$$;

create function app_private.save_school_attendance_calendar(p_school_id uuid,p_expected_revision bigint,p_kind text,p_day date,
 p_working_days integer[],p_window integer,p_mode text,p_label text,p_reason text,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);today date:=(statement_timestamp() at time zone 'Asia/Kolkata')::date;
 reason text:=btrim(p_reason);label text:=btrim(p_label);days integer[];payload jsonb;receipt app_private.school_attendance_calendar_receipts%rowtype;
 revision bigint;response jsonb;
begin
 if p_request_id is null or p_expected_revision is null or p_expected_revision not between 0 and 2147483646 or p_kind not in('policy','exception')
  or p_day is null or not isfinite(p_day) or p_day<date '0001-01-01' or p_day>date '9999-12-31'
  or reason is null or char_length(reason) not between 5 and 300 or reason ~ '[[:cntrl:]]' then
  raise exception 'Choose a date and a change reason of 5 to 300 characters.' using errcode='22023';end if;
 if p_kind='policy' then
  if p_working_days is null or cardinality(p_working_days) not between 1 and 7 or array_position(p_working_days,null) is not null
   or not p_working_days<@array[0,1,2,3,4,5,6] or p_window is null or p_window not between 0 and 365 then
   raise exception 'Choose unique working weekdays 0 to 6 and a correction window from 0 to 365 days.' using errcode='22023';end if;
  select array_agg(day order by day) into days from(select distinct unnest(p_working_days) as day) d;
  if cardinality(days)<>cardinality(p_working_days) then raise exception 'Working weekdays cannot repeat.' using errcode='22023';end if;
 else
  if p_mode is null or p_mode not in('holiday','working','inherit') or(p_mode='inherit' and p_label is not null)
   or(p_mode<>'inherit' and(label is null or char_length(label) not between 1 and 120 or label ~ '[[:cntrl:]]')) then
   raise exception 'Choose a holiday or working-day label of up to 120 characters, or inherit without a label.' using errcode='22023';end if;
 end if;
 payload:=jsonb_build_object('school_id',p_school_id,'expected_revision',p_expected_revision,'kind',p_kind,'day',p_day,'working_days',days,
  'window',p_window,'mode',p_mode,'label',label,'reason',reason);
 -- Serialize cross-school UUID reuse first, then the school-wide policy/evidence decision.
 perform pg_advisory_xact_lock(hashtextextended('school-attendance-calendar-request:'||actor::text||':'||p_request_id::text,0));
 select * into receipt from app_private.school_attendance_calendar_receipts where actor_id=actor and request_id=p_request_id;
 if found then
  if receipt.payload is distinct from payload then raise exception 'This calendar save ID already has a different payload.' using errcode='PT409';end if;
  return receipt.response||jsonb_build_object('replayed',true);
 end if;
 perform pg_advisory_xact_lock(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 today:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
 if p_day<today then raise exception 'Published past calendar dates cannot change.' using errcode='22023';end if;
 revision:=app_private.attendance_calendar_revision(p_school_id);
 if revision<>p_expected_revision then raise exception 'The school calendar changed. Reload its saved revision.' using errcode='PT409';end if;
 if p_day=today and(exists(select 1 from public.attendance where school_id=p_school_id and attendance_date=today)
  or exists(select 1 from app_private.gate_events where school_id=p_school_id and occurred_at>=today::timestamp at time zone 'Asia/Kolkata'
   and occurred_at<(today+1)::timestamp at time zone 'Asia/Kolkata')) then
  raise exception 'Today already has attendance or gate evidence. Schedule a future change.' using errcode='PT409';end if;
 if p_kind='exception' and not(app_private.resolve_attendance_calendar_day(p_school_id,p_day)->>'configured')::boolean then
  raise exception 'Configure an effective attendance policy for this day first.' using errcode='22023';end if;
 revision:=revision+1;
 if p_kind='policy' then
  insert into app_private.school_attendance_policy_versions(school_id,revision,effective_from,working_days,correction_window_days,reason,actor_id,request_id)
   values(p_school_id,revision,p_day,days,p_window,reason,actor,p_request_id);
  response:=jsonb_build_object('user_id',actor,'school_id',p_school_id,'revision',revision,'request_id',p_request_id,'kind',p_kind,
   'effective_from',p_day,'working_days',days,'correction_window_days',p_window,'replayed',false);
 else
  insert into app_private.school_attendance_day_exceptions(school_id,revision,day,mode,label,reason,actor_id,request_id)
   values(p_school_id,revision,p_day,p_mode,label,reason,actor,p_request_id);
  response:=jsonb_build_object('user_id',actor,'school_id',p_school_id,'revision',revision,'request_id',p_request_id,'kind',p_kind,
   'day',p_day,'mode',p_mode,'label',label,'replayed',false);
 end if;
 insert into app_private.school_attendance_calendar_receipts(actor_id,request_id,school_id,payload,response) values(actor,p_request_id,p_school_id,payload,response);
 return response;
end;$$;

create function app_private.save_school_attendance_policy(p_school_id uuid,p_expected_revision bigint,p_effective_from date,p_working_days integer[],p_correction_window_days integer,p_reason text,p_request_id uuid)
returns jsonb language sql security definer set search_path=''
as $$select app_private.save_school_attendance_calendar(p_school_id,p_expected_revision,'policy',p_effective_from,p_working_days,p_correction_window_days,null,null,p_reason,p_request_id);$$;
create function app_private.save_school_attendance_exception(p_school_id uuid,p_expected_revision bigint,p_day date,p_mode text,p_label text,p_reason text,p_request_id uuid)
returns jsonb language sql security definer set search_path=''
as $$select app_private.save_school_attendance_calendar(p_school_id,p_expected_revision,'exception',p_day,null,null,p_mode,p_label,p_reason,p_request_id);$$;

create function app_private.get_attendance_day_context(p_school_id uuid,p_year_id uuid,p_class_id uuid,p_section_id uuid,p_day date)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.attendance_calendar_actor(p_school_id);today date:=(statement_timestamp() at time zone 'Asia/Kolkata')::date;current_policy jsonb;begin
 if p_day is null or not isfinite(p_day) then raise exception 'Choose a finite attendance day.' using errcode='22023';end if;
 perform 1 from app_private.list_attendance_register_students(p_school_id,p_year_id,p_class_id,p_section_id,p_day) limit 1;
 perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 current_policy:=app_private.resolve_attendance_calendar_day(p_school_id,today);
 return app_private.resolve_attendance_calendar_day(p_school_id,p_day)||jsonb_build_object('user_id',actor,'school_id',p_school_id,
  'academic_year_id',p_year_id,'class_id',p_class_id,'section_id',p_section_id,'server_today',today,'timezone','Asia/Kolkata',
  'revision',app_private.attendance_calendar_revision(p_school_id),'can_mark_holiday',app_private.attendance_calendar_can_edit(p_school_id),
  'can_request_correction',p_day<today and app_private.teacher_owns_attendance_register(p_school_id,p_year_id,p_section_id,null)
   and(not(current_policy->>'configured')::boolean or today-p_day<=(current_policy->>'correction_window_days')::integer));
end;$$;

-- Native row writes cannot call an unchecked resolver or acquire Auth locks after a row lock.
create function app_private.attendance_calendar_native_day(p_school_id uuid,p_day date,p_holiday boolean)
returns jsonb language plpgsql security definer set search_path=''
as $$declare day jsonb;begin
 if not app_private.has_live_school_session() or not app_private.staff_mfa_allowed() or not exists(select 1 from public.profiles p
  join public.user_roles r on r.user_id=p.id and r.school_id=p.school_id and r.role in('school_admin','principal','teacher')
  join public.schools s on s.id=p.school_id and s.is_active where p.id=auth.uid() and p.school_id=p_school_id and p.is_active)
  or(p_holiday and not coalesce(app_private.attendance_calendar_can_edit(p_school_id),false)) then
  raise exception 'Only the current School Admin or Principal can decide a holiday.' using errcode='42501';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 day:=app_private.resolve_attendance_calendar_day(p_school_id,p_day);
 if(day->>'configured')::boolean and not(day->>'is_working')::boolean then
  raise exception 'Attendance cannot be marked on this closed school day. Use an independently reviewed correction if required.' using errcode='42501';end if;
 return day;
end;$$;
create function app_private.guard_attendance_calendar_native_write()
returns trigger language plpgsql security invoker set search_path=''
as $$begin
 if current_user in('authenticated','anon') then
  perform app_private.attendance_calendar_native_day(new.school_id,new.attendance_date,
   new.status='holiday' or(tg_op='UPDATE' and old.status='holiday'));
 end if;
 return new;
end;$$;
create trigger attendance_calendar_native_write before insert or update on public.attendance
 for each row execute function app_private.guard_attendance_calendar_native_write();

-- Surgical forward patches retain all roster, optimistic snapshot and gate provenance fences.
do $patch$declare definition text;original text;begin
 definition:=pg_get_functiondef('app_private.request_attendance_correction(uuid,uuid,uuid,uuid,date,uuid,bigint,public.attendance_status,text,uuid)'::regprocedure);
 original:=definition;
 definition:=replace(definition,'  if actor_id is null then',E'  actor_id:=app_private.attendance_calendar_actor(p_school_id);\n  if not exists(select 1 from public.user_roles where user_id=actor_id and school_id=p_school_id and role=\'teacher\') then\n    raise exception \'Current class-teacher access is required.\' using errcode=\'42501\';end if;\n  if actor_id is null then');
 definition:=replace(definition,'  if not app_private.lock_attendance_correction_scope(actor_id,',E'  perform pg_advisory_xact_lock_shared(hashtextextended(\'school-attendance-calendar:\'||p_school_id::text,0));\n  if (app_private.resolve_attendance_calendar_day(p_school_id,(statement_timestamp() at time zone \'Asia/Kolkata\')::date)->>\'configured\')::boolean\n    and (statement_timestamp() at time zone \'Asia/Kolkata\')::date-p_day > (app_private.resolve_attendance_calendar_day(p_school_id,(statement_timestamp() at time zone \'Asia/Kolkata\')::date)->>\'correction_window_days\')::integer then\n    raise exception \'The teacher correction request window has closed.\' using errcode=\'42501\';end if;\n  if p_status=\'holiday\' and not coalesce(app_private.attendance_calendar_can_edit(p_school_id),false) then\n    raise exception \'Only the School Admin or Principal can decide a holiday.\' using errcode=\'42501\';end if;\n  if not app_private.lock_attendance_correction_scope(actor_id,');
 definition:=replace(definition,'    before_record := pg_catalog.to_jsonb(existing_mark);',E'    if existing_mark.status=\'holiday\' and not coalesce(app_private.attendance_calendar_can_edit(p_school_id),false) then\n      raise exception \'Only the School Admin or Principal can change a holiday.\' using errcode=\'42501\';end if;\n    before_record := pg_catalog.to_jsonb(existing_mark);');
 if definition=original or position('teacher correction request window' in definition)=0 or position('Only the School Admin or Principal can change' in definition)=0 then raise exception 'Correction request patch contract changed.';end if;
 execute definition;

 definition:=pg_get_functiondef('app_private.review_attendance_correction(uuid,text,text)'::regprocedure);original:=definition;
 definition:=replace(definition,'  select * into correction from app_private.attendance_corrections',E'  select * into correction from app_private.attendance_corrections where id=p_request_id;\n  actor_id:=app_private.attendance_calendar_actor(correction.school_id);\n  if not exists(select 1 from public.user_roles where user_id=actor_id and school_id=correction.school_id and role in(\'school_admin\',\'principal\')) then\n    raise exception \'Current School Admin or Principal review access is required.\' using errcode=\'42501\';end if;\n  select * into correction from app_private.attendance_corrections');
 definition:=replace(definition,'  if p_decision = ''approved'' then',E'  if p_decision=\'approved\' and(correction.requested_status=\'holiday\' or correction.before_record->>\'status\'=\'holiday\') then\n    perform app_private.gate_office_actor(correction.school_id);end if;\n  if p_decision = \'approved\' then');
 if definition=original or position('Current School Admin or Principal review access' in definition)=0 then raise exception 'Correction review patch contract changed.';end if;
 execute definition;

 definition:=pg_get_functiondef('app_private.ingest_gate_attendance_event(uuid,text,text,text,text,timestamptz)'::regprocedure);original:=definition;
 definition:=replace(definition,'v_status text:=''held_review'';reason text;','calendar_day jsonb;v_status text:=''held_review'';reason text;');
 definition:=replace(definition,' select * into mapping from app_private.gate_student_mappings',E' perform pg_advisory_xact_lock_shared(hashtextextended(\'school-attendance-calendar:\'||device.school_id::text,0));\n calendar_day:=app_private.resolve_attendance_calendar_day(device.school_id,school_day);\n select * into mapping from app_private.gate_student_mappings');
 definition:=replace(definition,'elsif not(extract(dow from school_day)::integer=any(device.working_days)) then',E'elsif (case when(calendar_day->>\'configured\')::boolean then not(calendar_day->>\'is_working\')::boolean else not(extract(dow from school_day)::integer=any(device.working_days)) end) then');
 definition:=replace(definition,'attendance_id,attendance_status,status,reason)', 'attendance_id,attendance_status,status,reason,calendar_policy_revision,calendar_exception_revision)');
 definition:=replace(definition,'mark.id,mark.status,v_status,reason) returning * into event;', 'mark.id,mark.status,v_status,reason,(calendar_day->>''policy_revision'')::bigint,(calendar_day->>''exception_revision'')::bigint) returning * into event;');
 if definition=original or position('calendar_day jsonb' in definition)=0 or position('calendar_policy_revision,calendar_exception_revision)' in definition)=0 then raise exception 'Gate calendar patch contract changed.';end if;
 execute definition;

 definition:=pg_get_functiondef('app_private.get_attendance_submission_monitor(uuid)'::regprocedure);original:=definition;
 definition:=replace(definition,' STABLE',' VOLATILE');
 definition:=replace(definition,'  registers jsonb := ''[]''::jsonb;',E'  registers jsonb := \'[]\'::jsonb;\n  calendar_day jsonb;');
 definition:=replace(definition,'  select * into settings from app_private.attendance_submission_settings',E'  perform app_private.attendance_calendar_actor(p_school_id);\n  perform pg_advisory_xact_lock_shared(hashtextextended(\'school-attendance-calendar:\'||p_school_id::text,0));\n  calendar_day:=app_private.resolve_attendance_calendar_day(p_school_id,local_today);\n  select * into settings from app_private.attendance_submission_settings');
 definition:=replace(definition,'  if session_state = ''active'' then',E'  if session_state = \'active\' and not coalesce((calendar_day->>\'configured\')::boolean and not(calendar_day->>\'is_working\')::boolean,false) then');
 definition:=replace(definition,'''roster_issue_count'', roster_issue_count, ''sections'', registers)', '''calendar_day'',calendar_day,''roster_issue_count'', roster_issue_count, ''sections'', registers)');
 if definition=original or position('calendar_day jsonb' in definition)=0 or position('''calendar_day'',calendar_day' in definition)=0 then raise exception 'Attendance monitor patch contract changed.';end if;
 execute definition;
end;$patch$;
alter function public.get_attendance_submission_monitor(uuid) volatile;

create function public.get_school_attendance_calendar(p_school_id uuid,p_from date,p_to date)
returns jsonb language sql volatile security invoker set search_path='' as $$select app_private.get_school_attendance_calendar(p_school_id,p_from,p_to);$$;
create function public.get_attendance_day_context(p_school_id uuid,p_year_id uuid,p_class_id uuid,p_section_id uuid,p_day date)
returns jsonb language sql volatile security invoker set search_path='' as $$select app_private.get_attendance_day_context(p_school_id,p_year_id,p_class_id,p_section_id,p_day);$$;
create function public.save_school_attendance_policy(p_school_id uuid,p_expected_revision bigint,p_effective_from date,p_working_days integer[],p_correction_window_days integer,p_reason text,p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select app_private.save_school_attendance_policy(p_school_id,p_expected_revision,p_effective_from,p_working_days,p_correction_window_days,p_reason,p_request_id);$$;
create function public.save_school_attendance_exception(p_school_id uuid,p_expected_revision bigint,p_day date,p_mode text,p_label text,p_reason text,p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select app_private.save_school_attendance_exception(p_school_id,p_expected_revision,p_day,p_mode,p_label,p_reason,p_request_id);$$;

revoke all on function app_private.attendance_calendar_revision(uuid),app_private.resolve_attendance_calendar_day(uuid,date),
 app_private.attendance_calendar_actor(uuid),app_private.attendance_calendar_can_edit(uuid),
 app_private.save_school_attendance_calendar(uuid,bigint,text,date,integer[],integer,text,text,text,uuid),
 app_private.guard_attendance_calendar_native_write(),app_private.attendance_calendar_native_day(uuid,date,boolean)
 from public,anon,authenticated,service_role;
grant execute on function app_private.attendance_calendar_native_day(uuid,date,boolean) to authenticated;
do $permissions$declare signature text;begin
 foreach signature in array array['get_school_attendance_calendar(uuid,date,date)','get_attendance_day_context(uuid,uuid,uuid,uuid,date)',
  'save_school_attendance_policy(uuid,bigint,date,integer[],integer,text,uuid)','save_school_attendance_exception(uuid,bigint,date,text,text,text,uuid)'] loop
  execute 'revoke all on function public.'||signature||',app_private.'||signature||' from public,anon,authenticated,service_role';
  execute 'grant execute on function public.'||signature||',app_private.'||signature||' to authenticated';
 end loop;
end;$permissions$;
notify pgrst,'reload schema';
commit;
