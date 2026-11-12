begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Late alert policy and historical calendar import histories name their actor (same-school profile only),
-- like the school settings and MFA policy histories. Bodies are otherwise unchanged; create or replace keeps grants.
create or replace function app_private.get_school_late_alert_settings(p_school_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$declare actor uuid:=app_private.gate_office_actor(p_school_id);result jsonb;begin
 select jsonb_build_object('user_id',actor,'school_id',p_school_id,
  'enabled',coalesce((select enabled from app_private.school_late_alert_policy_versions where school_id=p_school_id order by version desc limit 1),false),
  'version',coalesce((select max(version) from app_private.school_late_alert_policy_versions where school_id=p_school_id),0),
  'history',coalesce((select jsonb_agg(to_jsonb(row) order by row.version desc) from(
   select v.version,v.enabled,v.reason,v.actor_id,nullif(left(btrim(profile.full_name),160),'') as actor_name,v.created_at
   from app_private.school_late_alert_policy_versions v
   left join public.profiles profile on profile.id=v.actor_id and profile.school_id=p_school_id
   where v.school_id=p_school_id order by v.version desc limit 20)row),'[]'::jsonb)) into result;
 if actor is distinct from app_private.gate_office_actor(p_school_id) then raise exception 'Your school access changed.' using errcode='42501';end if;
 return result;
end;$$;

create or replace function app_private.get_historical_attendance_calendar_context(p_school_id uuid)
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
    (r.response->>'holiday_rows')::integer as holiday_rows,r.payload->>'reason' as reason,r.actor_id,
    nullif(left(btrim(profile.full_name),160),'') as actor_name,r.created_at
   from app_private.school_attendance_calendar_receipts r
   left join public.profiles profile on profile.id=r.actor_id and profile.school_id=p_school_id
   where r.school_id=p_school_id and r.payload->>'kind'='historical_import'
   order by r.created_at desc,r.request_id limit 10) h),'[]'::jsonb));
end;$$;

notify pgrst,'reload schema';
commit;
