begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
set local search_path=pg_catalog;

-- The legacy table contains arbitrary diffs and client metadata. Its trusted
-- writers/history remain; school accounts use the curated read API instead.
revoke select on table public.audit_logs from public,anon,authenticated;
do $columns$
declare column_name text;
begin
  for column_name in select a.attname from pg_catalog.pg_attribute a
    where a.attrelid='public.audit_logs'::regclass and a.attnum>0 and not a.attisdropped loop
    execute pg_catalog.format('revoke select (%I) on public.audit_logs from public,anon,authenticated',column_name);
  end loop;
  if pg_catalog.has_table_privilege('authenticated','public.audit_logs','SELECT')
    or pg_catalog.has_any_column_privilege('authenticated','public.audit_logs','SELECT')
    or pg_catalog.has_table_privilege('anon','public.audit_logs','SELECT')
    or pg_catalog.has_any_column_privilege('anon','public.audit_logs','SELECT') then
    raise exception 'Review inherited legacy audit privileges before exposing school history.';
  end if;
end;
$columns$;

create function app_private.list_school_audit_events(
  p_school_id uuid,p_from date,p_to date,p_module text default null,
  p_cursor_at timestamptz default null,p_cursor_key text default null,p_limit integer default 50
)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  actor uuid:=app_private.student_leave_actor();
  session_text text:=auth.jwt()->>'session_id';
  from_at timestamptz;
  until_at timestamptz;
  response jsonb;
begin
  if session_text is null or session_text!~'^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then
    raise exception 'A current verified school session is required.' using errcode='42501';
  end if;
  perform 1 from auth.sessions s where s.id=session_text::uuid and s.user_id=actor
    and(s.not_after is null or s.not_after>statement_timestamp()) for share;
  if not found or p_school_id is null or not app_private.legacy_office_reader(p_school_id,false)
    or not exists(select 1 from public.schools school where school.id=p_school_id) then
    raise exception 'School administrator or principal access is required.' using errcode='42501';
  end if;
  perform 1 from public.user_roles membership where membership.user_id=actor
    and((membership.school_id=p_school_id and membership.role in('school_admin','principal'))
      or(membership.school_id is null and membership.role='super_admin')) order by membership.id for share;
  if not found then raise exception 'School access is no longer available.' using errcode='42501'; end if;

  if p_from is null or p_to is null or not pg_catalog.isfinite(p_from) or not pg_catalog.isfinite(p_to)
    or p_from<'0001-01-01'::date or p_to>'9999-12-31'::date or p_from>p_to or p_to-p_from>365
    or p_limit is null or p_limit not between 1 and 100
    or(p_module is not null and p_module not in('guardians','attendance','roster','student-leave','results','timetable'))
    or(p_cursor_at is null)<>(p_cursor_key is null) then
    raise exception 'Choose valid ordered dates within 366 days, a supported module and a page size from 1 to 100.' using errcode='22023';
  end if;
  from_at:=pg_catalog.timezone('Asia/Kolkata',p_from::timestamp);
  until_at:=pg_catalog.timezone('Asia/Kolkata',(p_to+1)::timestamp);
  if p_cursor_at is not null and(not pg_catalog.isfinite(p_cursor_at) or p_cursor_at<from_at or p_cursor_at>=until_at
    or pg_catalog.char_length(p_cursor_key)>128
    or p_cursor_key!~'^[a-z_]+:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?:[a-z_]+$') then
    raise exception 'Refresh the audit history before using this page reference.' using errcode='22023';
  end if;

  with events(id,occurred_at,actor_id,module,action,record_label) as(
    select 'guardian_access:'||a.id||':'||a.action,a.occurred_at,a.actor_id,'guardians',
      case a.action when 'linked' then 'Guardian linked' else 'Guardian access revoked' end,
      'Guardian access record '||pg_catalog.left(a.id::text,8)
    from app_private.guardian_access_audit a where a.school_id=p_school_id
    union all
    select 'guardian_contact:'||a.id||':'||a.action,a.occurred_at,a.actor_id,'guardians',
      case a.action when 'email_changed' then 'Guardian email changed' when 'mobile_verified' then 'Guardian mobile verified'
        when 'mobile_removed' then 'Guardian mobile removed' else 'Guardian mobile synchronized' end,
      'Guardian contact record '||pg_catalog.left(a.id::text,8)
    from app_private.guardian_contact_audit a where a.school_id=p_school_id
    union all
    select 'attendance_cutoff:'||a.id||':changed',a.changed_at,a.changed_by,'attendance','Attendance cutoff changed',
      'Cutoff revision '||a.revision::text
    from app_private.attendance_submission_settings_audit a where a.school_id=p_school_id
    union all
    select 'attendance_correction:'||a.id||':submitted',a.requested_at,a.requested_by,'attendance','Attendance correction requested',
      'Correction record '||pg_catalog.left(a.id::text,8)
    from app_private.attendance_corrections a where a.school_id=p_school_id
    union all
    select 'attendance_correction:'||a.id||':reviewed',a.reviewed_at,a.reviewed_by,'attendance',
      case a.state when 'approved' then 'Attendance correction approved' else 'Attendance correction rejected' end,
      'Correction record '||pg_catalog.left(a.id::text,8)
    from app_private.attendance_corrections a where a.school_id=p_school_id and a.reviewed_at is not null
    union all
    select 'roster_placement:'||a.request_id||':changed',a.changed_at,a.changed_by,'roster',
      case a.change_kind when 'promotion' then 'Student promotion staged' else 'Student placement changed' end,
      'Placement record '||pg_catalog.left(a.request_id::text,8)
    from app_private.roster_placement_changes a where a.school_id=p_school_id
    union all
    select 'enrollment_withdrawal:'||a.enrollment_id||':withdrawn',a.withdrawn_at,a.withdrawn_by,'roster','Student enrollment withdrawn',
      'Withdrawal record '||pg_catalog.left(a.enrollment_id::text,8)
    from app_private.enrollment_withdrawals a where a.school_id=p_school_id
    union all
    select 'academic_year:'||a.academic_year_id||':activated',a.activated_at,a.actor_id,'roster','Academic session activated',
      'Session record '||pg_catalog.left(a.academic_year_id::text,8)
    from app_private.academic_year_activations a where a.school_id=p_school_id
    union all
    select 'student_leave:'||a.id||':submitted',a.created_at,a.requester_id,'student-leave','Student leave requested',
      'Leave request '||pg_catalog.left(a.id::text,8)
    from app_private.student_leave_requests a where a.school_id=p_school_id
    union all
    select 'student_leave:'||a.id||':reviewed',a.reviewed_at,a.reviewed_by,'student-leave',
      case a.status when 'approved' then 'Student leave approved' else 'Student leave rejected' end,
      'Leave request '||pg_catalog.left(a.id::text,8)
    from app_private.student_leave_requests a where a.school_id=p_school_id and a.reviewed_at is not null
    union all
    select 'assessment_result:'||a.id||':submitted',a.requested_at,a.requested_by,'results','Result publication requested',
      'Publication request '||pg_catalog.left(a.id::text,8)
    from app_private.assessment_result_submissions a where a.school_id=p_school_id
    union all
    select 'assessment_result:'||a.id||':reviewed',a.reviewed_at,a.reviewed_by,'results',
      case a.status when 'published' then 'Assessment results published' when 'cancelled' then 'Publication request cancelled'
        else 'Publication request rejected' end,
      'Publication request '||pg_catalog.left(a.id::text,8)
    from app_private.assessment_result_submissions a where a.school_id=p_school_id and a.reviewed_at is not null
    union all
    select 'timetable:'||a.actor_id||':'||a.request_id||':'||case a.operation when 'remove' then 'removed' else 'saved' end,
      a.created_at,a.actor_id,'timetable',case when a.operation='remove' then 'Timetable period removed'
        when a.before_record is null then 'Timetable period created' else 'Timetable period updated' end,
      'Period record '||pg_catalog.left(a.period_id::text,8)
    from app_private.timetable_write_receipts a
    where a.payload->>'school'=p_school_id::text and a.after_record->>'school_id'=p_school_id::text
      and a.after_record->>'id'=a.period_id::text
      and(a.before_record is null or(a.before_record->>'school_id'=p_school_id::text and a.before_record->>'id'=a.period_id::text))
  ), page as materialized(
    select e.* from events e where e.occurred_at>=from_at and e.occurred_at<until_at
      and(p_module is null or e.module=p_module)
      and(p_cursor_at is null or(e.occurred_at,e.id collate "C")<(p_cursor_at,p_cursor_key collate "C"))
    order by e.occurred_at desc,e.id collate "C" desc limit p_limit+1
  ), visible as materialized(
    select * from page order by occurred_at desc,id collate "C" desc limit p_limit
  )
  select pg_catalog.jsonb_build_object(
    'events',coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id',v.id,'occurred_at',v.occurred_at,
      'actor_name',nullif(pg_catalog.left(pg_catalog.btrim(actor_profile.full_name),160),''),
      'module',v.module,'action',v.action,'record_label',v.record_label)
      order by v.occurred_at desc,v.id collate "C" desc)
      from visible v left join public.profiles actor_profile on actor_profile.id=v.actor_id and actor_profile.school_id=p_school_id),'[]'::jsonb),
    'next_cursor',case when(select count(*) from page)>p_limit then(
      select pg_catalog.jsonb_build_object('occurred_at',v.occurred_at,'key',v.id)
      from visible v order by v.occurred_at asc,v.id collate "C" asc limit 1) else null end
  ) into response;
  return response;
end;
$function$;

create function public.list_school_audit_events(
  p_school_id uuid,p_from date,p_to date,p_module text default null,
  p_cursor_at timestamptz default null,p_cursor_key text default null,p_limit integer default 50
)
returns jsonb language sql security invoker set search_path=''
as $$ select app_private.list_school_audit_events(p_school_id,p_from,p_to,p_module,p_cursor_at,p_cursor_key,p_limit); $$;

revoke all on function app_private.list_school_audit_events(uuid,date,date,text,timestamptz,text,integer),
  public.list_school_audit_events(uuid,date,date,text,timestamptz,text,integer) from public,anon,authenticated,service_role;
grant execute on function app_private.list_school_audit_events(uuid,date,date,text,timestamptz,text,integer),
  public.list_school_audit_events(uuid,date,date,text,timestamptz,text,integer) to authenticated;

notify pgrst,'reload schema';
commit;
