begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Year-end bulk path: stage the promotion of the pupils an office user reviewed
-- in one source section. Every pupil still goes through change_roster_placement,
-- so each keeps the per-pupil rules and its own audited placement row.
create function app_private.stage_section_promotions(
  p_school_id uuid, p_source_class_id uuid, p_source_section_id uuid, p_enrollment_ids uuid[],
  p_destination_academic_year_id uuid, p_destination_class_id uuid, p_destination_section_id uuid,
  p_reason text, p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  reason_text text := pg_catalog.btrim(pg_catalog.regexp_replace(p_reason, '[[:space:]]+', ' ', 'g'));
  pupil record;
  pupil_request uuid;
  staged integer := 0;
  already_staged integer := 0;
  failure_state text;
  failure_message text;
begin
  perform 1 from public.user_roles ur
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id = actor_id
    and ((ur.role = 'super_admin' and ur.school_id is null)
      or (ur.school_id = p_school_id and ur.role in ('school_admin', 'principal')));
  if not found or p_school_id is null then
    raise exception 'You cannot change placements for this school.' using errcode = '42501';
  end if;
  if p_request_id is null or reason_text is null or char_length(reason_text) not between 5 and 300
    or reason_text ~ '[[:cntrl:]]' then
    raise exception 'Enter a placement change reason between 5 and 300 characters.' using errcode = '22023';
  end if;
  if p_enrollment_ids is null or array_position(p_enrollment_ids, null) is not null
    or (select count(distinct x) from pg_catalog.unnest(p_enrollment_ids) x) not between 1 and 200 then
    raise exception 'Choose between 1 and 200 pupils to promote.' using errcode = '22023';
  end if;

  for pupil in
    select x.id, e.student_id, e.academic_year_id, s.admission_no
    from (select distinct u.id from pg_catalog.unnest(p_enrollment_ids) u(id)) x
    left join public.enrollments e on e.id = x.id
    left join public.students s on s.id = e.student_id and s.school_id = p_school_id
    order by x.id
  loop
    if pupil.admission_no is null then
      raise exception 'Pupil list changed. Reload the roster.' using errcode = '22023';
    end if;
    -- A retry of this batch replays the derived per-pupil request idempotently.
    pupil_request := pg_catalog.md5(p_request_id::text || ':' || pupil.id::text)::uuid;
    if not exists (
      select 1 from app_private.roster_placement_changes ch
      where ch.school_id = p_school_id and ch.request_id = pupil_request
    ) then
      -- Same rule as change_roster_placement's promotion path; without it the pupil's own source
      -- enrollment would count as an existing staging decision and the batch would no-op silently.
      if not exists (
        select 1 from public.academic_years d
        join public.academic_years src on src.id = pupil.academic_year_id and src.school_id = p_school_id
        where d.id = p_destination_academic_year_id and d.school_id = p_school_id
          and not d.is_current and d.start_date > src.end_date
      ) then
        raise exception 'Choose a later academic year that starts after the current year ends.' using errcode = '22023';
      end if;
      if exists (
        select 1 from public.enrollments d
        where d.student_id = pupil.student_id and d.academic_year_id = p_destination_academic_year_id
          and d.status in ('staged', 'active')
      ) then
        -- Keep an individual staging decision; revise it through Change placement.
        already_staged := already_staged + 1;
        continue;
      end if;
    end if;
    begin
      perform app_private.change_roster_placement(
        p_school_id, pupil.id, p_source_class_id, p_source_section_id,
        p_destination_academic_year_id, p_destination_class_id, p_destination_section_id, reason_text, pupil_request
      );
    exception when others then
      get stacked diagnostics failure_state = returned_sqlstate, failure_message = message_text;
      raise exception '%', 'Pupil ' || pupil.admission_no || ': ' || failure_message using errcode = failure_state;
    end;
    staged := staged + 1;
  end loop;

  return pg_catalog.jsonb_build_object('staged', staged, 'already_staged', already_staged);
end;
$function$;

create function public.stage_section_promotions(
  p_school_id uuid, p_source_class_id uuid, p_source_section_id uuid, p_enrollment_ids uuid[],
  p_destination_academic_year_id uuid, p_destination_class_id uuid, p_destination_section_id uuid,
  p_reason text, p_request_id uuid
)
returns jsonb language sql security invoker set search_path = ''
as $function$
  select app_private.stage_section_promotions(
    p_school_id, p_source_class_id, p_source_section_id, p_enrollment_ids,
    p_destination_academic_year_id, p_destination_class_id, p_destination_section_id, p_reason, p_request_id
  );
$function$;

revoke all on function
  app_private.stage_section_promotions(uuid, uuid, uuid, uuid[], uuid, uuid, uuid, text, uuid),
  public.stage_section_promotions(uuid, uuid, uuid, uuid[], uuid, uuid, uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.stage_section_promotions(uuid, uuid, uuid, uuid[], uuid, uuid, uuid, text, uuid),
  public.stage_section_promotions(uuid, uuid, uuid, uuid[], uuid, uuid, uuid, text, uuid)
to authenticated;

commit;
