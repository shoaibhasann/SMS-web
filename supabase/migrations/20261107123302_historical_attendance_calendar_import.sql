begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Historical imports fill explicit calendar gaps; retained pupil marks are never rewritten.
create table app_private.school_attendance_historical_days(
 school_id uuid not null references public.schools(id),day date not null check(isfinite(day)),
 academic_year_id uuid not null references public.academic_years(id),is_working boolean not null,
 label text not null check(char_length(label) between 1 and 120 and label !~ '[[:cntrl:]]'),
 revision bigint not null check(revision between 1 and 2147483647),actor_id uuid not null,
 request_id uuid not null,created_at timestamptz not null default clock_timestamp(),primary key(school_id,day),
 foreign key(actor_id,request_id) references app_private.school_attendance_calendar_receipts(actor_id,request_id)
);
create index school_attendance_historical_receipt on app_private.school_attendance_historical_days(actor_id,request_id);
create index school_attendance_historical_year on app_private.school_attendance_historical_days(academic_year_id);
alter table app_private.school_attendance_historical_days enable row level security;
revoke all on app_private.school_attendance_historical_days from public,anon,authenticated,service_role;

create or replace function app_private.attendance_calendar_revision(p_school_id uuid)
returns bigint language sql volatile security definer set search_path=''
as $$select greatest(coalesce((select max(revision) from app_private.school_attendance_policy_versions where school_id=p_school_id),0),
 coalesce((select max(revision) from app_private.school_attendance_day_exceptions where school_id=p_school_id),0),
 coalesce((select max(revision) from app_private.school_attendance_historical_days where school_id=p_school_id),0));$$;

create or replace function app_private.resolve_attendance_calendar_day(p_school_id uuid,p_day date)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare policy app_private.school_attendance_policy_versions%rowtype;exception app_private.school_attendance_day_exceptions%rowtype;
 imported app_private.school_attendance_historical_days%rowtype;
begin
 select * into policy from app_private.school_attendance_policy_versions where school_id=p_school_id and effective_from<=p_day
  order by effective_from desc,revision desc limit 1;
 if not found then
  select * into imported from app_private.school_attendance_historical_days where school_id=p_school_id and day=p_day;
  if found then return jsonb_build_object('day',p_day,'configured',true,'is_working',imported.is_working,'source','import',
   'label',imported.label,'policy_revision',null,'exception_revision',null,'correction_window_days',null,'import_revision',imported.revision);end if;
  return jsonb_build_object('day',p_day,'configured',false,'is_working',null,'source','unconfigured',
   'label',null,'policy_revision',null,'exception_revision',null,'correction_window_days',null);end if;
 select * into exception from app_private.school_attendance_day_exceptions where school_id=p_school_id and day=p_day order by revision desc limit 1;
 return jsonb_build_object('day',p_day,'configured',true,
  'is_working',case when exception.mode='holiday' then false when exception.mode='working' then true else extract(dow from p_day)::integer=any(policy.working_days) end,
  'source',case when exception.mode in('holiday','working') then 'exception' else 'weekday' end,
  'label',case when exception.mode in('holiday','working') then exception.label end,
  'policy_revision',policy.revision,'exception_revision',exception.revision,'correction_window_days',policy.correction_window_days);
end;$$;

create function app_private.historical_attendance_calendar_actor(p_school_id uuid,p_require_mfa boolean)
returns uuid language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.attendance_calendar_actor(p_school_id);begin
 perform 1 from public.user_roles where user_id=actor and school_id=p_school_id and role in('school_admin','principal') order by id for share;
 if not found then raise exception 'Only the School Admin or Principal can import historical calendar days.' using errcode='42501';end if;
 if p_require_mfa and(not app_private.attendance_calendar_can_edit(p_school_id) or not exists(
  select 1 from auth.sessions where id=(auth.jwt()->>'session_id')::uuid and user_id=actor and(not_after is null or not_after>clock_timestamp()))) then
  raise exception 'Verify your school authenticator before importing calendar days.' using errcode='42501';end if;
 return actor;
end;$$;

create function app_private.normalize_historical_attendance_calendar_rows(p_rows jsonb)
returns jsonb language plpgsql immutable security definer set search_path=''
as $$declare row jsonb;day date;normalized jsonb:='[]'::jsonb;begin
 if p_rows is null or jsonb_typeof(p_rows)<>'array' or octet_length(p_rows::text)>131072 then
  raise exception 'Provide 1 to 366 calendar rows, within 128 KB of normalized JSON.' using errcode='22023';end if;
 if jsonb_array_length(p_rows) not between 1 and 366 then
  raise exception 'Provide 1 to 366 calendar rows.' using errcode='22023';end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(row)<>'object' or(select count(*) from jsonb_object_keys(row))<>3
   or jsonb_typeof(row->'day') is distinct from 'string' or jsonb_typeof(row->'status') is distinct from 'string'
   or jsonb_typeof(row->'label') is distinct from 'string' or row->>'day' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   or row->>'status' not in('working','holiday') or char_length(btrim(row->>'label')) not between 1 and 120
   or row->>'label' ~ '[[:cntrl:]]' then
   raise exception 'Each row needs exactly day (YYYY-MM-DD), working/holiday status and a label of 1 to 120 characters.' using errcode='22023';end if;
  begin day:=(row->>'day')::date;
  exception when datetime_field_overflow or invalid_datetime_format then
   raise exception 'Use a valid calendar date in YYYY-MM-DD format.' using errcode='22023';end;
  if not isfinite(day) or day<date '0001-01-01' or day>date '9999-12-31' or to_char(day,'YYYY-MM-DD')<>row->>'day' then
   raise exception 'Use a valid calendar date in YYYY-MM-DD format.' using errcode='22023';end if;
  normalized:=normalized||jsonb_build_array(jsonb_build_object('day',day,'status',row->>'status','label',btrim(row->>'label')));
 end loop;
 return normalized;
end;$$;

create function app_private.get_historical_attendance_calendar_context(p_school_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.historical_attendance_calendar_actor(p_school_id,false);today date;begin
 perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 perform app_private.historical_attendance_calendar_actor(p_school_id,false);
 today:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
 return jsonb_build_object('user_id',actor,'school_id',p_school_id,'server_today',today,'timezone','Asia/Kolkata',
  'revision',app_private.attendance_calendar_revision(p_school_id),'can_import',app_private.attendance_calendar_can_edit(p_school_id),
  'years',coalesce((select jsonb_agg(to_jsonb(y) order by start_date desc,id) from(select id,name,start_date,end_date from public.academic_years
   where school_id=p_school_id and isfinite(start_date) and isfinite(end_date) and start_date>=date '0001-01-01'
   and end_date<=date '9999-12-31' and end_date>=start_date and end_date-start_date<=365 and start_date<today) y),'[]'::jsonb),
  'history_limit',10,'history',coalesce((select jsonb_agg(to_jsonb(h) order by created_at desc,request_id) from(
   select r.request_id,(r.payload->>'academic_year_id')::uuid as academic_year_id,(r.response->>'revision')::bigint as revision,
    (r.response->>'imported_rows')::integer as imported_rows,(r.response->>'working_rows')::integer as working_rows,
    (r.response->>'holiday_rows')::integer as holiday_rows,r.payload->>'reason' as reason,r.actor_id,r.created_at
   from app_private.school_attendance_calendar_receipts r where r.school_id=p_school_id and r.payload->>'kind'='historical_import'
   order by r.created_at desc,r.request_id limit 10) h),'[]'::jsonb));
end;$$;

create function app_private.preview_historical_attendance_calendar(p_school_id uuid,p_academic_year_id uuid,p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.historical_attendance_calendar_actor(p_school_id,true);normalized jsonb;
 year public.academic_years%rowtype;today date;rows jsonb;snapshot jsonb;begin
 normalized:=app_private.normalize_historical_attendance_calendar_rows(p_rows);
 perform pg_advisory_xact_lock_shared(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 perform app_private.historical_attendance_calendar_actor(p_school_id,true);
 select * into year from public.academic_years where id=p_academic_year_id and school_id=p_school_id for share;
 if not found then raise exception 'Choose an academic year from this school.' using errcode='42501';end if;
 if not isfinite(year.start_date) or not isfinite(year.end_date) or year.start_date<date '0001-01-01' or year.end_date>date '9999-12-31'
  or year.end_date<year.start_date or year.end_date-year.start_date>365 then
  raise exception 'Choose an academic year spanning 1 to 366 days.' using errcode='22023';end if;
 today:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
 with input as(select value as row,ordinality as row_number,count(*) over(partition by value->>'day') as duplicates
  from jsonb_array_elements(normalized) with ordinality),stats as(
   select a.attendance_date,count(*)::integer as attendance_count,count(distinct a.student_id)::integer as pupils_with_marks,
    count(*) filter(where a.status='present')::integer as present_count,count(*) filter(where a.status='absent')::integer as absent_count,
    count(*) filter(where a.status='late')::integer as late_count,count(*) filter(where a.status='half_day')::integer as half_day_count,
    count(*) filter(where a.status='leave')::integer as leave_count,count(*) filter(where a.status='holiday')::integer as holiday_count
   from public.attendance a where a.school_id=p_school_id and a.attendance_date in(select(row->>'day')::date from input) group by a.attendance_date)
 select jsonb_agg(jsonb_build_object('row_number',i.row_number,'day',i.row->>'day','status',i.row->>'status','label',i.row->>'label',
  'issue',case when i.duplicates>1 then 'Duplicate date in this CSV.' when(i.row->>'day')::date not between year.start_date and year.end_date then 'Date is outside the selected academic year.'
   when(i.row->>'day')::date>=today then 'Only dates before today can be imported.'
   when(app_private.resolve_attendance_calendar_day(p_school_id,(i.row->>'day')::date)->>'configured')::boolean then 'This date already has an approved calendar decision.' end,
  'attendance_count',coalesce(s.attendance_count,0),'pupils_with_marks',coalesce(s.pupils_with_marks,0),'present_count',coalesce(s.present_count,0),
  'absent_count',coalesce(s.absent_count,0),'late_count',coalesce(s.late_count,0),'half_day_count',coalesce(s.half_day_count,0),
  'leave_count',coalesce(s.leave_count,0),'holiday_count',coalesce(s.holiday_count,0)) order by i.row_number) into rows
 from input i left join stats s on s.attendance_date=(i.row->>'day')::date;
 snapshot:=jsonb_build_object('user_id',actor,'school_id',p_school_id,'academic_year_id',p_academic_year_id,'server_today',today,'timezone','Asia/Kolkata',
  'revision',app_private.attendance_calendar_revision(p_school_id),'can_import',not exists(select 1 from jsonb_array_elements(rows) r where r->>'issue' is not null),
  'rows',rows,'summary',jsonb_build_object('total_rows',jsonb_array_length(rows),
   'valid_rows',(select count(*) from jsonb_array_elements(rows) r where r->>'issue' is null),
   'working_rows',(select count(*) from jsonb_array_elements(rows) r where r->>'status'='working'),
   'holiday_rows',(select count(*) from jsonb_array_elements(rows) r where r->>'status'='holiday'),
   'attendance_records',(select coalesce(sum((r->>'attendance_count')::integer),0) from jsonb_array_elements(rows) r),
   'pupils_with_marks',(select count(distinct a.student_id) from public.attendance a where a.school_id=p_school_id
    and a.attendance_date in(select(r->>'day')::date from jsonb_array_elements(rows) r))));
 -- Bind the rendered impact, year bounds and exact normalized source, not just its date list.
 return snapshot||jsonb_build_object('preview_token',encode(sha256(convert_to((snapshot||jsonb_build_object('normalized_rows',normalized,
  'year_start',year.start_date,'year_end',year.end_date))::text,'UTF8')),'hex'));
end;$$;

create function app_private.import_historical_attendance_calendar(p_school_id uuid,p_academic_year_id uuid,p_rows jsonb,
 p_expected_revision bigint,p_preview_token text,p_acknowledge_impact boolean,p_reason text,p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.historical_attendance_calendar_actor(p_school_id,true);normalized jsonb;
 reason text:=btrim(p_reason);payload jsonb;receipt app_private.school_attendance_calendar_receipts%rowtype;preview jsonb;response jsonb;revision bigint;begin
 normalized:=app_private.normalize_historical_attendance_calendar_rows(p_rows);
 if p_request_id is null or p_expected_revision is null or p_expected_revision not between 0 and 2147483646
  or p_preview_token is null or p_preview_token !~ '^[a-f0-9]{64}$' or p_acknowledge_impact is distinct from true
  or reason is null or char_length(reason) not between 5 and 300 or reason ~ '[[:cntrl:]]' then
  raise exception 'Review the preview, acknowledge the attendance impact and provide a reason of 5 to 300 characters.' using errcode='22023';end if;
 payload:=jsonb_build_object('kind','historical_import','school_id',p_school_id,'academic_year_id',p_academic_year_id,'rows',normalized,
  'expected_revision',p_expected_revision,'preview_token',p_preview_token,'acknowledge_impact',p_acknowledge_impact,'reason',reason);
 perform pg_advisory_xact_lock(hashtextextended('school-attendance-calendar-request:'||actor::text||':'||p_request_id::text,0));
 perform app_private.historical_attendance_calendar_actor(p_school_id,true);
 select * into receipt from app_private.school_attendance_calendar_receipts where actor_id=actor and request_id=p_request_id;
 if found then
  if receipt.payload is distinct from payload then raise exception 'This calendar save ID already has a different payload.' using errcode='PT409';end if;
  return receipt.response||jsonb_build_object('replayed',true);end if;
 perform pg_advisory_xact_lock(hashtextextended('school-attendance-calendar:'||p_school_id::text,0));
 perform app_private.historical_attendance_calendar_actor(p_school_id,true);
 -- Freeze already-retained marks while the authoritative impact is rechecked; later corrections remain legitimate.
 perform 1 from public.attendance a where a.school_id=p_school_id
  and a.attendance_date in(select(r->>'day')::date from jsonb_array_elements(normalized) r) order by a.id for share;
 preview:=app_private.preview_historical_attendance_calendar(p_school_id,p_academic_year_id,normalized);
 if(preview->>'revision')::bigint<>p_expected_revision or preview->>'preview_token'<>p_preview_token then
  raise exception 'Calendar or attendance impact changed. Preview this file again.' using errcode='PT409';end if;
 if not(preview->>'can_import')::boolean then raise exception 'Resolve every calendar preview issue before importing.' using errcode='22023';end if;
 revision:=p_expected_revision+1;
 response:=jsonb_build_object('user_id',actor,'school_id',p_school_id,'academic_year_id',p_academic_year_id,'request_id',p_request_id,'revision',revision,
  'imported_rows',jsonb_array_length(normalized),'working_rows',preview->'summary'->'working_rows','holiday_rows',preview->'summary'->'holiday_rows','replayed',false);
 insert into app_private.school_attendance_calendar_receipts(actor_id,request_id,school_id,payload,response) values(actor,p_request_id,p_school_id,payload,response);
 insert into app_private.school_attendance_historical_days(school_id,day,academic_year_id,is_working,label,revision,actor_id,request_id)
 select p_school_id,(r->>'day')::date,p_academic_year_id,r->>'status'='working',r->>'label',revision,actor,p_request_id from jsonb_array_elements(normalized) r;
 return response;
end;$$;

create function public.get_historical_attendance_calendar_context(p_school_id uuid)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.get_historical_attendance_calendar_context(p_school_id);$$;
create function public.preview_historical_attendance_calendar(p_school_id uuid,p_academic_year_id uuid,p_rows jsonb)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.preview_historical_attendance_calendar(p_school_id,p_academic_year_id,p_rows);$$;
create function public.import_historical_attendance_calendar(p_school_id uuid,p_academic_year_id uuid,p_rows jsonb,
 p_expected_revision bigint,p_preview_token text,p_acknowledge_impact boolean,p_reason text,p_request_id uuid)
returns jsonb language sql volatile security invoker set search_path=''
as $$select app_private.import_historical_attendance_calendar(p_school_id,p_academic_year_id,p_rows,p_expected_revision,p_preview_token,p_acknowledge_impact,p_reason,p_request_id);$$;
revoke all on function app_private.historical_attendance_calendar_actor(uuid,boolean),
 app_private.normalize_historical_attendance_calendar_rows(jsonb) from public,anon,authenticated,service_role;
do $permissions$declare signature text;begin
 foreach signature in array array['get_historical_attendance_calendar_context(uuid)','preview_historical_attendance_calendar(uuid,uuid,jsonb)',
  'import_historical_attendance_calendar(uuid,uuid,jsonb,bigint,text,boolean,text,uuid)'] loop
  execute 'revoke all on function public.'||signature||',app_private.'||signature||' from public,anon,authenticated,service_role';
  execute 'grant execute on function public.'||signature||',app_private.'||signature||' to authenticated';end loop;
end;$permissions$;
notify pgrst,'reload schema';
commit;
