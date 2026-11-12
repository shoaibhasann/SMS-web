begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- A read-only Office report must not stall register saves, gate scans, corrections or family reads,
-- which all take the shared form of the school-calendar fence. Calendar saves/imports still take the
-- exclusive form, so the calendar cannot change mid-report; marks may commit between pupils, and the
-- PDF export's before/after comparison already rejects a report that moved while it was prepared.
do $patch$declare definition text;original text;needle text;begin
 definition:=pg_get_functiondef('app_private.get_office_attendance_report(uuid,uuid,date,uuid,uuid)'::regprocedure);
 original:=definition;
 needle:=E' -- A short report snapshot fences governed manual/gate/correction writes, including new marks.\n perform pg_advisory_xact_lock(hashtextextended(\'school-attendance-calendar:\'||p_school_id::text,0));';
 if position(needle in definition)=0 or position('pg_advisory_xact_lock_shared' in definition)>0 then
  raise exception 'Office attendance report lock contract changed.';end if;
 definition:=replace(definition,needle,
  E' -- Shared fence: calendar saves/imports (exclusive) cannot change the calendar mid-report; marks may commit between pupils.\n perform pg_advisory_xact_lock_shared(hashtextextended(\'school-attendance-calendar:\'||p_school_id::text,0));');
 if definition=original or position('pg_advisory_xact_lock_shared(hashtextextended(''school-attendance-calendar:''' in definition)=0
  or position('pg_advisory_xact_lock(hashtextextended(''school-attendance-calendar:''' in definition)>0 then
  raise exception 'Office attendance report must take only the shared calendar fence.';end if;
 execute definition;
end;$patch$;

-- A class/section report skips the per-day work for pupils whose verified placement and move chain never
-- touch the scope; the days CTE would filter every day out and yield the same not_started value.
do $patch$declare definition text;original text;needle text;begin
 definition:=pg_get_functiondef('app_private.calculate_attendance_report_pupil(text,uuid,uuid,date,uuid,uuid,uuid,jsonb)'::regprocedure);
 original:=definition;
 needle:=E'\n with days as materialized(';
 if array_length(string_to_array(definition,needle),1)<>2 or position('Office scope never touches this pupil' in definition)>0
  or position(E'if enrollment_state is not null then return result' in definition)=0
  or position(E'if enrollment_state is not null then return result' in definition)>position(needle in definition) then
  raise exception 'Attendance report pupil kernel contract changed.';end if;
 definition:=replace(definition,needle,E'\n -- Office scope never touches this pupil: skip the per-day reads.\n'
  ||E' if p_office_school_id is not null and p_class_id is not null\n'
  ||E'  and not(placement.class_id=p_class_id and(p_section_id is null or placement.section_id=p_section_id))\n'
  ||E'  and not exists(select 1 from app_private.roster_placement_changes change where change.school_id=school\n'
  ||E'   and change.source_enrollment_id=placement.id and change.change_kind=\'move\' and change.source_class_id=p_class_id\n'
  ||E'   and(p_section_id is null or change.source_section_id=p_section_id)) then\n'
  ||E'  return result||jsonb_build_object(\'month_summary\',blank||jsonb_build_object(\'state\',\'not_started\'),\n'
  ||E'   \'year_summary\',blank||jsonb_build_object(\'state\',\'not_started\'));\n'
  ||E' end if;'||needle);
 if definition=original then raise exception 'Attendance report pupil kernel was not patched.';end if;
 execute definition;
end;$patch$;

-- A class/section report runs the per-pupil kernel only for pupils it can touch. A pupil is skipped only when
-- it is provably clean and out of scope: exactly one active enrollment in an active student in a valid class
-- and section outside the scope, no withdrawal row, no move, and a promotion/admission record the kernel
-- accepts. The kernel would return not_started for such a pupil and the relevant CTE would drop it, so the
-- report is unchanged; every other pupil (including unverified or unenrolled ones) still runs the kernel.
-- shortcut: these predicates mirror calculate_attendance_report_pupil; if its enrollment checks change, update both.
do $patch$declare definition text;original text;needle text;begin
 definition:=pg_get_functiondef('app_private.get_office_attendance_report(uuid,uuid,date,uuid,uuid)'::regprocedure);
 original:=definition;
 needle:=E' with reports as materialized(\n  select pupil,app_private.calculate_attendance_report_pupil(\'office\',pupil,year.id,month,p_school_id,p_class_id,p_section_id,calendar) as data from unnest(pupils) pupil\n ),relevant as materialized(';
 if array_length(string_to_array(definition,needle),1)<>2 or position('out_of_scope' in definition)>0 then
  raise exception 'Office attendance report kernel call contract changed.';end if;
 definition:=replace(definition,needle,
  E' with promotions as materialized(\n'
  ||E'  select change.destination_enrollment_id,count(distinct change.effective_date) as days,\n'
  ||E'   bool_and((change.school_id<>p_school_id or change.student_id is distinct from enrollment.student_id or change.destination_year_id<>year.id\n'
  ||E'    or not isfinite(change.effective_date) or change.effective_date not between year.start_date and year.end_date) is false) as clean\n'
  ||E'  from app_private.roster_placement_changes change left join public.enrollments enrollment on enrollment.id=change.destination_enrollment_id\n'
  ||E'  where p_class_id is not null and change.change_kind=\'promotion\' group by change.destination_enrollment_id\n'
  ||E' ),out_of_scope as materialized(\n'
  ||E'  select e.student_id from public.enrollments e\n'
  ||E'  join public.students s on s.id=e.student_id and s.school_id=p_school_id and s.status=\'active\'\n'
  ||E'  join public.classes c on c.id=e.class_id and c.school_id=p_school_id\n'
  ||E'  join public.sections sec on sec.id=e.section_id and sec.class_id=c.id and sec.school_id=p_school_id\n'
  ||E'  left join promotions promo on promo.destination_enrollment_id=e.id\n'
  ||E'  where p_class_id is not null and e.academic_year_id=year.id and e.status=\'active\'\n'
  ||E'   and not(e.class_id=p_class_id and(p_section_id is null or e.section_id=p_section_id))\n'
  ||E'   and not exists(select 1 from public.enrollments other where other.student_id=e.student_id and other.academic_year_id=year.id and other.id<>e.id)\n'
  ||E'   and not exists(select 1 from app_private.enrollment_withdrawals w where w.enrollment_id=e.id)\n'
  ||E'   and not exists(select 1 from app_private.roster_placement_changes m where m.change_kind=\'move\' and m.source_enrollment_id=e.id)\n'
  ||E'   and not exists(select 1 from app_private.roster_placement_changes m where m.change_kind=\'move\' and m.destination_enrollment_id=e.id)\n'
  ||E'   and coalesce(promo.clean,true) and coalesce(promo.days,0)<=1\n'
  ||E'   and case when s.admission_date is null then coalesce(promo.days,0)=1 else isfinite(s.admission_date) end\n'
  ||E' ),reports as materialized(\n'
  ||E'  select pupil,app_private.calculate_attendance_report_pupil(\'office\',pupil,year.id,month,p_school_id,p_class_id,p_section_id,calendar) as data from unnest(pupils) pupil'
  ||E' where not exists(select 1 from out_of_scope skip where skip.student_id=pupil)\n'
  ||E' ),relevant as materialized(');
 if definition=original then raise exception 'Office attendance report was not scope-filtered.';end if;
 execute definition;
end;$patch$;

revoke all on function app_private.calculate_attendance_report_pupil(text,uuid,uuid,date,uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function app_private.get_office_attendance_report(uuid,uuid,date,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function app_private.get_office_attendance_report(uuid,uuid,date,uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
