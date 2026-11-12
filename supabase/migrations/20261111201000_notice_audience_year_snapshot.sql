-- gap3#1: a class/section/teacher-targeted notice keeps the cohort of the academic
-- year that was current when it was published. activate_academic_year is the only
-- path that switches is_current and it logs every switch in
-- app_private.academic_year_activations, so the publication year is derived from that
-- log (no backfill). Role-only and whole-school notices keep the current-year rule.
-- The pupil must still hold an active current-year enrollment, so a pupil withdrawn
-- after activation (their old-year enrollment stays 'active') loses old notices too.
-- Copied from 20261104113103_secure_notice_audiences.sql (can_read_notice_audience) and
-- 20261109181045_native_announcement_push.sql (eligible_family_notice_sources,
-- family_notice_push_recipients); only the audience-year match changes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Serves both notice_audience_year lookups (latest switch at/before, first switch after).
create index academic_year_activations_school_activated_idx
  on app_private.academic_year_activations (school_id, activated_at);

-- Year current at p_published_at: the latest switch at or before it, else the year
-- the first later switch left, else (never switched / unpublished) the current year.
create function app_private.notice_audience_year(p_school_id uuid, p_published_at timestamptz)
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select a.academic_year_id from app_private.academic_year_activations a
      where a.school_id = p_school_id and a.activated_at <= p_published_at
      order by a.activated_at desc limit 1),
    (select a.previous_year_id from app_private.academic_year_activations a
      where a.school_id = p_school_id and a.activated_at > p_published_at
      order by a.activated_at limit 1),
    (select y.id from public.academic_years y where y.school_id = p_school_id and y.is_current limit 1)
  );
$$;
revoke all on function app_private.notice_audience_year(uuid, timestamptz) from public, anon, authenticated, service_role;

create function app_private.can_read_notice_audience(p_school_id uuid, p_audience jsonb, p_published_at timestamptz)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  roles jsonb := p_audience->'roles';
  target_class_id uuid;
  target_section_id uuid;
  target_teacher_id uuid;
  audience_year_id uuid;
begin
  if actor_id is null or not app_private.notice_audience_is_valid(p_school_id, p_audience) then
    return false;
  end if;
  if p_audience = '[]'::jsonb then
    roles := '["student","parent","teacher","staff"]'::jsonb;
  end if;

  if not exists (
    select 1 from public.user_roles ur
    where ur.user_id = actor_id and ur.school_id = p_school_id and (
      (ur.role in ('student', 'parent', 'teacher') and roles ? ur.role::text)
      or (ur.role in ('accountant', 'reception_staff') and roles ? 'staff')
    )
  ) then
    return false;
  end if;

  target_class_id := (p_audience->>'class_id')::uuid;
  target_section_id := (p_audience->>'section_id')::uuid;
  target_teacher_id := (p_audience->>'teacher_id')::uuid;
  if target_class_id is null and target_section_id is null and target_teacher_id is null then
    return true;
  end if;
  -- Resolve once: inside the join qual this definer function could run per student/enrollment row.
  audience_year_id := app_private.notice_audience_year(p_school_id, p_published_at);

  return exists (
    select 1
    from public.students s
    join public.enrollments e on e.student_id = s.id and e.status = 'active'
    join public.academic_years y on y.id = e.academic_year_id and y.school_id = s.school_id
      and y.id = audience_year_id
    join public.classes c on c.id = e.class_id and c.school_id = s.school_id
    left join public.sections section on section.id = e.section_id
      and section.school_id = s.school_id and section.class_id = e.class_id
    where s.school_id = p_school_id and s.status = 'active'
      and (e.section_id is null or section.id is not null)
      and exists (
        select 1 from public.enrollments ce
        join public.academic_years cy on cy.id = ce.academic_year_id and cy.school_id = s.school_id and cy.is_current
        where ce.student_id = s.id and ce.status = 'active'
      )
      and (target_class_id is null or e.class_id = target_class_id)
      and (target_section_id is null or e.section_id = target_section_id)
      and (target_teacher_id is null or exists (
        select 1 from public.teacher_subject_assignments a
        where a.teacher_id = target_teacher_id and a.academic_year_id = y.id and a.class_id = e.class_id
          and (a.section_id is null or a.section_id = e.section_id)
      ))
      and (
        (roles ? 'student' and s.profile_id = actor_id
          and app_private.has_school_roles(p_school_id, array['student']::public.app_role[]))
        or (roles ? 'parent'
          and app_private.has_school_roles(p_school_id, array['parent']::public.app_role[])
          and exists (
            select 1
            from public.student_parents link
            join public.parents p on p.id = link.parent_id and p.school_id = s.school_id
            where link.student_id = s.id and p.profile_id = actor_id
          ))
      )
  );
end;
$$;

revoke all on function app_private.can_read_notice_audience(uuid, jsonb, timestamptz)
from public, anon, authenticated, service_role;
grant execute on function app_private.can_read_notice_audience(uuid, jsonb, timestamptz) to authenticated;

alter policy notices_school_read on public.notices
using (
  published_at <= now() and (expires_at is null or expires_at > now())
  and app_private.can_read_notice_audience(school_id, audience, published_at)
);
drop function app_private.can_read_notice_audience(uuid, jsonb);

create or replace function app_private.eligible_family_notice_sources(p_role text, p_notice_id uuid default null)
returns table (id uuid, title text, content text, published_at timestamptz)
language sql stable security invoker set search_path = ''
as $$
  with actor as materialized (
    select profile.id, profile.school_id
    from public.profiles profile
    join public.schools school on school.id = profile.school_id and school.is_active
    where profile.id = auth.uid() and profile.is_active
      and p_role in ('student', 'parent')
      and exists (
        select 1 from public.user_roles membership
        where membership.user_id = profile.id and membership.school_id = school.id and membership.role::text = p_role
      )
  ), owned_pupils as materialized (
    select student.id, actor.school_id from actor
    join public.students student on student.profile_id = actor.id and student.school_id = actor.school_id
    where p_role = 'student' and student.status = 'active'
    union all
    select student.id, actor.school_id from actor
    join public.parents guardian on guardian.profile_id = actor.id and guardian.school_id = actor.school_id
    join public.student_parents link on link.parent_id = guardian.id
    join public.students student on student.id = link.student_id and student.school_id = actor.school_id
    where p_role = 'parent' and student.status = 'active'
  ), placement as materialized (
    select enrollment.academic_year_id, enrollment.class_id, enrollment.section_id, year.is_current
    from owned_pupils pupil
    join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.status = 'active'
    join public.academic_years year on year.id = enrollment.academic_year_id and year.school_id = pupil.school_id
    join public.classes class on class.id = enrollment.class_id and class.school_id = pupil.school_id and class.is_active
    left join public.sections section on section.id = enrollment.section_id and section.class_id = class.id and section.school_id = pupil.school_id
    where (enrollment.section_id is null or section.id is not null)
      and exists (
        select 1 from public.enrollments current_enrollment
        join public.academic_years current_year on current_year.id = current_enrollment.academic_year_id
          and current_year.school_id = pupil.school_id and current_year.is_current
        where current_enrollment.student_id = pupil.id and current_enrollment.status = 'active'
      )
  )
  select notice.id, regexp_replace(notice.title, '^[[:space:]]+|[[:space:]]+$', '', 'g'), notice.content, notice.published_at
  from actor
  join public.notices notice on notice.school_id = actor.school_id
  join app_private.family_notice_publications publication on publication.notice_id = notice.id and publication.school_id = actor.school_id
  where (p_notice_id is null or notice.id = p_notice_id)
    and isfinite(notice.published_at) and notice.published_at <= statement_timestamp()
    and (notice.expires_at is null or notice.expires_at > statement_timestamp())
    and notice.title ~ '[^[:space:]]'
    and app_private.notice_audience_is_valid(notice.school_id, notice.audience)
    and exists (
      select 1 from placement
      where case when notice.audience ?| array['class_id', 'section_id', 'teacher_id']
          then placement.academic_year_id = app_private.notice_audience_year(notice.school_id, notice.published_at)
          else placement.is_current end
        and app_private.family_notice_matches_placement(
        notice.audience, p_role, placement.academic_year_id, placement.class_id, placement.section_id
      )
    );
$$;

create or replace function app_private.family_notice_push_recipients(p_notice_id uuid, p_user_id uuid, p_role text)
returns table (user_id uuid, recipient_role text, school_id uuid, expires_at timestamptz, published_at timestamptz)
language sql volatile security invoker set search_path = ''
as $$
  with event as materialized (
    select notice.school_id, notice.audience, notice.published_at,
      least(notice.published_at + interval '24 hours', notice.expires_at) as expires_at,
      app_private.notice_audience_year(notice.school_id, notice.published_at) as audience_year_id
    from app_private.family_notice_publications publication
    join public.notices notice on notice.id = publication.notice_id and notice.school_id = publication.school_id
    join public.schools school on school.id = notice.school_id and school.is_active
    where publication.notice_id = p_notice_id and isfinite(notice.published_at)
      and (p_user_id is null or notice.published_at <= statement_timestamp())
      and (notice.expires_at is null or notice.expires_at > statement_timestamp())
      and notice.title ~ '[^[:space:]]'
      and app_private.notice_audience_matches_school(notice.school_id, notice.audience)
  )
  select recipient.user_id, recipient.recipient_role, event.school_id, event.expires_at, event.published_at
  from event
  cross join lateral (
    select p_user_id as user_id, p_role as recipient_role where p_user_id is not null
    union all
    select distinct device.user_id, device.recipient_role
    from app_private.family_push_devices device
    join app_private.family_push_preferences pref
      on pref.user_id = device.user_id and pref.recipient_role = device.recipient_role and pref.enabled
    where p_user_id is null and device.school_id = event.school_id and device.revoked_at is null
      and device.last_seen_at > statement_timestamp() - interval '90 days'
  ) recipient
  join public.profiles profile on profile.id = recipient.user_id and profile.school_id = event.school_id and profile.is_active
  join auth.users account on account.id = profile.id and not account.is_anonymous and account.deleted_at is null
    and (account.banned_until is null or account.banned_until <= statement_timestamp())
    and (account.email_confirmed_at is not null or account.phone_confirmed_at is not null)
  where recipient.recipient_role in ('student', 'parent')
    and exists (
      select 1 from public.user_roles membership
      where membership.user_id = recipient.user_id and membership.school_id = event.school_id
        and membership.role::text = recipient.recipient_role
    )
    and exists (
      select 1
      from (
        select student.id from public.students student
        where recipient.recipient_role = 'student' and student.profile_id = recipient.user_id
          and student.school_id = event.school_id
        union all
        select link.student_id from public.parents guardian
        join public.student_parents link on link.parent_id = guardian.id
        where recipient.recipient_role = 'parent' and guardian.profile_id = recipient.user_id
          and guardian.school_id = event.school_id
      ) owned
      join public.students pupil on pupil.id = owned.id and pupil.school_id = event.school_id and pupil.status = 'active'
      join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.status = 'active'
      join public.academic_years year on year.id = enrollment.academic_year_id and year.school_id = event.school_id
        and case when event.audience ?| array['class_id', 'section_id', 'teacher_id']
          then year.id = event.audience_year_id else year.is_current end
      join public.classes class on class.id = enrollment.class_id and class.school_id = event.school_id and class.is_active
      left join public.sections section on section.id = enrollment.section_id and section.class_id = class.id and section.school_id = event.school_id
      where (enrollment.section_id is null or section.id is not null)
        and exists (
          select 1 from public.enrollments current_enrollment
          join public.academic_years current_year on current_year.id = current_enrollment.academic_year_id
            and current_year.school_id = event.school_id and current_year.is_current
          where current_enrollment.student_id = pupil.id and current_enrollment.status = 'active'
        )
        and app_private.family_notice_matches_placement(event.audience, recipient.recipient_role, year.id, class.id, section.id)
    );
$$;

revoke all on function app_private.family_notice_push_recipients(uuid, uuid, text)
  from public, anon, authenticated, service_role;

commit;
