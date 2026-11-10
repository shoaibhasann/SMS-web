-- Synthetic activities for the two existing 2,000-pupil QA rosters and one APK test pupil.
-- Check the returned counts and zero push jobs in the default rollback before committing.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

select pg_advisory_xact_lock(hashtextextended('sms-academic-activity-qa:2026-11-10', 0));

create temporary table activity_seed_schools on commit drop as
select s.id as school_id, y.id as year_id, target.prefix, t.id as teacher_id, p.id as teacher_user
from (values
  ('7727a1bf-6330-4dbe-962e-b2bb50646c72'::uuid, 'ERP-FEE-CREDIT-QA-a852f1dc',
   'a1cc0cd2-ea75-4343-b500-049b4da4cc71'::uuid, 'SMSFCQA26', 'd8a104e5-4134-414e-952d-a1dcdaf848a3'::uuid),
  ('8389c2df-6df2-4e5b-94f2-951f4c6d6aa6'::uuid, 'SMS-MFA-cac57e88',
   'a6cc16b3-fc1d-45d4-873f-c78a176b0b3f'::uuid, 'SMSQA26', '6621b8b4-cc3e-4e65-97e2-d8c88f3f81b1'::uuid)
) target(school_id, code, year_id, prefix, teacher_id)
join public.schools s on s.id = target.school_id and s.code = target.code and s.is_active
join public.academic_years y on y.id = target.year_id and y.school_id = s.id and y.is_current
  and date '2026-11-02' >= y.start_date and date '2026-11-17' <= y.end_date
join public.teachers t on t.id = target.teacher_id and t.school_id = s.id
join public.profiles p on p.id = t.profile_id and p.school_id = s.id and p.is_active
join public.user_roles membership on membership.user_id = p.id and membership.school_id = s.id and membership.role = 'teacher';

create temporary table activity_seed_pupils on commit drop as
select scope.*, pupil.id as student_id, pupil.profile_id, enrollment.class_id, enrollment.section_id,
  class.sort_order as grade, coalesce(substring(pupil.admission_no from '^[^-]+-([0-9]{4})$')::integer, 0) as seq,
  pupil.id = 'f87d74ac-eca5-4540-ac7d-694c3b9ec30f' as apk
from pg_temp.activity_seed_schools scope
join public.students pupil on pupil.school_id = scope.school_id and pupil.status = 'active' and (
  (pupil.profile_id is null and pupil.admission_date <= date '2026-11-02'
    and pupil.admission_no ~ ('^' || scope.prefix || '-[0-9]{4}$')
    and right(pupil.admission_no, 4) between '0001' and '2000')
  or (scope.prefix = 'SMSQA26' and pupil.id = 'f87d74ac-eca5-4540-ac7d-694c3b9ec30f'
    and pupil.admission_no like 'ANDROID-APK-QA-%' and pupil.profile_id is not null))
join public.enrollments enrollment on enrollment.student_id = pupil.id and enrollment.academic_year_id = scope.year_id
  and enrollment.status = 'active'
join public.classes class on class.id = enrollment.class_id and class.school_id = scope.school_id and class.is_active
join public.sections section on section.id = enrollment.section_id and section.class_id = class.id and section.school_id = scope.school_id;

do $guard$
begin
  if current_user in ('anon', 'authenticated', 'service_role')
    or (select count(*) from pg_temp.activity_seed_schools) <> 2
    or (select count(*) from pg_temp.activity_seed_pupils) <> 4001
    or exists (select 1 from pg_temp.activity_seed_pupils where not apk group by prefix having count(distinct seq) <> 2000)
    or (select count(distinct section_id) from pg_temp.activity_seed_pupils where not apk) <> 120
    or not exists (
      select 1 from pg_temp.activity_seed_pupils pupil
      join public.student_parents link on link.student_id = pupil.student_id
      join public.parents parent on parent.id = link.parent_id and parent.school_id = pupil.school_id and parent.profile_id is not null
      where pupil.apk and pupil.section_id = '2f061800-0979-4891-ad03-dc1f6f28e8e0'
        and parent.id = 'b0c034a0-9db5-470e-ab32-3f60f64726ca'
    )
    or exists (
      select 1 from pg_temp.activity_seed_pupils pupil
      join public.enrollments placement on placement.section_id = pupil.section_id and placement.academic_year_id = pupil.year_id
        and placement.status = 'active'
      where pupil.apk and placement.student_id <> pupil.student_id
    )
    or exists (
      select 1 from pg_temp.activity_seed_pupils pupil
      join public.student_parents link on link.student_id = pupil.student_id
      join public.parents parent on parent.id = link.parent_id and parent.profile_id is not null
      where not pupil.apk or parent.id <> 'b0c034a0-9db5-470e-ab32-3f60f64726ca'
    )
    or (statement_timestamp() at time zone 'Asia/Kolkata')::date < date '2026-11-10'
  then
    raise exception 'Expected exactly two synthetic roster scopes and the isolated linked APK pupil.';
  end if;
end;
$guard$;

create temporary table activity_seed_days on commit drop as
select scope.school_id, day::date as school_day
from pg_temp.activity_seed_schools scope
cross join generate_series(date '2026-11-02', date '2026-11-10', interval '1 day') day
cross join lateral (select app_private.resolve_attendance_calendar_day(scope.school_id, day::date) as rule) calendar
where case when (calendar.rule->>'configured')::boolean then (calendar.rule->>'is_working')::boolean
  else extract(isodow from day) between 1 and 5 and not exists (
    select 1 from public.school_holidays holiday where holiday.school_id = scope.school_id
      and holiday.academic_year_id = scope.year_id and holiday.holiday_date = day::date
  ) end;

insert into public.attendance (id, school_id, academic_year_id, student_id, section_id, attendance_date, status, remarks, marked_by, created_at)
select md5('SMS-ACTIVITY-QA:' || pupil.student_id || ':' || dates.school_day)::uuid,
  pupil.school_id, pupil.year_id, pupil.student_id, pupil.section_id, dates.school_day,
  (case when pupil.apk then 'present' when sample.bucket < 3 then 'absent' when sample.bucket < 5 then 'late'
    when sample.bucket < 7 then 'leave' when sample.bucket = 7 then 'half_day' else 'present' end)::public.attendance_status,
  'SMS-ACTIVITY-QA · Synthetic attendance', pupil.teacher_user,
  (dates.school_day + time '09:00') at time zone 'Asia/Kolkata'
from pg_temp.activity_seed_pupils pupil
join pg_temp.activity_seed_days dates on dates.school_id = pupil.school_id and (not pupil.apk or dates.school_day = date '2026-11-10')
cross join lateral (select (pupil.seq * 37 + (dates.school_day - date '2026-11-02') * 13 + pupil.seq / 17) % 100 as bucket) sample
on conflict (student_id, attendance_date) do nothing;

create temporary table activity_seed_subjects on commit drop as
select scope.school_id, spec.code, spec.subject_name,
  md5('SMS-ACTIVITY-QA:subject:' || scope.school_id || ':' || spec.code)::uuid as subject_id
from pg_temp.activity_seed_schools scope cross join
  (values ('QA-DEMO-MATH', 'Mathematics · QA Demo'), ('QA-DEMO-ENG', 'English · QA Demo')) spec(code, subject_name);

insert into public.subjects (id, school_id, name, code, is_active)
select subject_id, school_id, subject_name, code, true from pg_temp.activity_seed_subjects
on conflict (id) do nothing;

create temporary table activity_seed_lessons on commit drop as
select placement.*, subject.subject_id, subject.code,
  md5('SMS-ACTIVITY-QA:log:' || placement.section_id || ':' || subject.code)::uuid as log_id,
  case subject.code
    when 'QA-DEMO-MATH' then
      case when grade <= 0 then 'Count and match objects' when grade <= 3 then 'Place value and addition'
        when grade <= 5 then 'Fractions in everyday life' when grade <= 8 then 'Ratios and percentages'
        when grade <= 10 then 'Linear equations' else 'Statistics and data interpretation' end
    else case when grade <= 0 then 'Sounds and picture words' when grade <= 3 then 'Build a short sentence'
        when grade <= 5 then 'Find the main idea' when grade <= 8 then 'Write a clear paragraph'
        when grade <= 10 then 'Support an argument' else 'Compare viewpoints in two texts' end
  end as topic,
  case subject.code when 'QA-DEMO-MATH' then date '2026-11-06' else date '2026-11-09' end as lesson_day
from (select distinct school_id, year_id, class_id, section_id, grade, teacher_id, teacher_user from pg_temp.activity_seed_pupils) placement
join pg_temp.activity_seed_subjects subject on subject.school_id = placement.school_id;

insert into public.teacher_subject_assignments (id, teacher_id, academic_year_id, class_id, section_id, subject_id, is_class_teacher)
select md5('SMS-ACTIVITY-QA:assignment:' || log_id)::uuid, teacher_id, year_id, class_id, section_id, subject_id, false
from pg_temp.activity_seed_lessons
on conflict do nothing;

insert into public.class_logs (id, school_id, academic_year_id, class_id, section_id, subject_id, teacher_id, log_date, topic, summary,
  status, published_at, published_by, created_at)
select log_id, school_id, year_id, class_id, section_id, subject_id, teacher_id, lesson_day, topic,
  'QA demo lesson. Review the example, complete the guided practice and explain your answer.',
  'published', (lesson_day + time '13:00') at time zone 'Asia/Kolkata', teacher_user, (lesson_day + time '10:00') at time zone 'Asia/Kolkata'
from pg_temp.activity_seed_lessons
on conflict (id) do nothing;

create temporary table activity_seed_work on commit drop as
select lesson.*, item.kind,
  md5('SMS-ACTIVITY-QA:work:' || lesson.log_id || ':' || item.kind)::uuid as work_id,
  case item.kind when 'classwork' then 'Guided practice: ' else 'Home practice: ' end || lesson.topic as title,
  case when item.kind = 'homework' then date '2026-11-17' end as due_date
from pg_temp.activity_seed_lessons lesson cross join (values ('classwork'), ('homework')) item(kind);

create temporary table activity_seed_new_work (id uuid primary key) on commit drop;
with inserted as (
  insert into public.class_activities (id, class_log_id, activity_type, title, description, due_date, max_marks, created_at)
  select work_id, log_id, kind::public.activity_type, title,
    case kind when 'classwork' then 'Work through two examples in class. Show each step in your notebook.'
      else 'Complete three examples at home and write one sentence explaining what you learned. QA demo work.' end,
    due_date, case when kind = 'homework' then 10 end, (lesson_day + time '13:00') at time zone 'Asia/Kolkata'
  from pg_temp.activity_seed_work
  on conflict (id) do nothing
  returning id
)
insert into pg_temp.activity_seed_new_work select id from inserted;

-- Leave the English task open and add a mix of submitted and graded maths examples.
insert into public.activity_submissions (id, activity_id, student_id, submitted_at, text_response, marks, feedback, status)
select md5('SMS-ACTIVITY-QA:submission:' || work.work_id || ':' || pupil.student_id)::uuid, work.work_id, pupil.student_id,
  timestamptz '2026-11-10 10:00:00+05:30',
  'QA demo submission. Completed the worked examples and checked the final answer.',
  case when pupil.apk or pupil.seq % 4 = 0 then 7 + pupil.seq % 4 end,
  case when pupil.apk or pupil.seq % 4 = 0 then 'Correct method. Label the final answer clearly.' end,
  case when pupil.apk or pupil.seq % 4 = 0 then 'graded' else 'submitted' end
from pg_temp.activity_seed_pupils pupil
join pg_temp.activity_seed_work work on work.section_id = pupil.section_id and work.kind = 'homework' and work.code = 'QA-DEMO-MATH'
where pupil.apk or pupil.seq % 4 in (0, 1)
on conflict (activity_id, student_id) do nothing;

-- The MFA roster already has fee demands. Only fill missing fee coverage in the other roster and the APK pupil.
create temporary table activity_seed_fee_structures on commit drop as
select distinct school_id, year_id, class_id,
  md5('SMS-ACTIVITY-QA:fee-structure:' || class_id)::uuid as structure_id,
  (2950 + greatest(grade, 0) * 110)::numeric as amount
from pg_temp.activity_seed_pupils
where prefix = 'SMSFCQA26' or apk;

insert into public.fee_structures (id, school_id, academic_year_id, class_id, name, frequency, amount, due_day)
select structure_id, school_id, year_id, class_id, 'Tuition · QA Demo', 'monthly', amount, 6
from pg_temp.activity_seed_fee_structures
on conflict (id) do nothing;

create temporary table activity_seed_dues on commit drop as
select pupil.school_id, pupil.student_id, pupil.seq, pupil.apk, structure.structure_id,
  md5('SMS-ACTIVITY-QA:fee:' || pupil.student_id || ':' || invoice.period)::uuid as fee_id,
  invoice.period, invoice.due_date, structure.amount,
  case when pupil.seq % 11 = 0 and not pupil.apk then 250 else 0 end as discount,
  case when invoice.period = '2026-10' and (pupil.apk or pupil.seq % 8 = 0) then 'paid'
    when invoice.period = '2026-10' and pupil.seq % 8 = 1 then 'partial' else 'pending' end as status
from pg_temp.activity_seed_pupils pupil
join pg_temp.activity_seed_fee_structures structure on structure.class_id = pupil.class_id and structure.school_id = pupil.school_id
cross join (values ('2026-10', date '2026-10-30'), ('2026-11', date '2026-11-06')) invoice(period, due_date)
where pupil.prefix = 'SMSFCQA26' or pupil.apk;

insert into public.student_fees (id, school_id, student_id, fee_structure_id, billing_period, due_date, amount, discount, status)
select fee_id, school_id, student_id, structure_id, period, due_date, amount, discount, status::public.payment_status
from pg_temp.activity_seed_dues
on conflict (id) do nothing;

create temporary table activity_seed_payments on commit drop as
select dues.*, md5('SMS-ACTIVITY-QA:payment:' || fee_id)::uuid as payment_id,
  case when apk then 'QA-ACT-APK' else 'QA-ACT-' || lpad(seq::text, 4, '0') end as receipt_no,
  case status when 'paid' then amount - discount else 1200 end as paid
from pg_temp.activity_seed_dues dues where status in ('paid', 'partial');

create temporary table activity_seed_new_payments (id uuid primary key) on commit drop;
with inserted as (
  insert into public.fee_payments (id, school_id, student_fee_id, student_id, receipt_no, amount, payment_method, status, paid_at)
  select payment_id, school_id, fee_id, student_id, receipt_no, paid, case when seq % 2 = 0 then 'cash' else 'upi' end,
    'paid', timestamptz '2026-11-10 09:00:00+05:30'
  from pg_temp.activity_seed_payments plan
  where not exists (select 1 from public.fee_payments payment where payment.id = plan.payment_id)
  returning id
)
insert into pg_temp.activity_seed_new_payments select id from inserted;

-- Let the demo inbox retain its normal history without delivering seed notifications to phones.
delete from app_private.family_push_jobs job
using (
  select 'homework_assigned' as kind, inserted.id, work.school_id
  from pg_temp.activity_seed_new_work inserted join pg_temp.activity_seed_work work on work.work_id = inserted.id and work.kind = 'homework'
  union all
  select 'fee_payment', inserted.id, payment.school_id
  from pg_temp.activity_seed_new_payments inserted join pg_temp.activity_seed_payments payment on payment.payment_id = inserted.id
) generated
where job.kind = generated.kind and job.event_id = generated.id and job.school_id = generated.school_id
  and job.created_at >= transaction_timestamp() and job.status = 'queued' and job.attempts = 0;

do $validate$
begin
  if (select count(*) from pg_temp.activity_seed_work work
      join public.class_activities activity on activity.id = work.work_id and activity.class_log_id = work.log_id
        and activity.activity_type::text = work.kind
      join public.class_logs log on log.id = work.log_id and log.school_id = work.school_id and log.section_id = work.section_id
        and log.academic_year_id = work.year_id and log.status = 'published') <> 484
    or exists (select 1 from pg_temp.activity_seed_pupils pupil where not exists (
      select 1 from public.attendance mark where mark.student_id = pupil.student_id and mark.school_id = pupil.school_id
        and mark.academic_year_id = pupil.year_id and mark.section_id = pupil.section_id
    ) or not exists (
      select 1 from public.student_fees fee where fee.student_id = pupil.student_id and fee.school_id = pupil.school_id
    ))
    or exists (select 1 from pg_temp.activity_seed_dues plan left join public.student_fees fee on fee.id = plan.fee_id
      where fee.id is null or (fee.school_id, fee.student_id, fee.fee_structure_id, fee.billing_period)
        is distinct from (plan.school_id, plan.student_id, plan.structure_id, plan.period))
    or exists (select 1 from pg_temp.activity_seed_payments plan
      where not app_private.coherent_office_fee_payment(plan.payment_id))
    or exists (
      select 1 from app_private.family_push_jobs job where job.event_id in (
        select work_id from pg_temp.activity_seed_work
        union all select payment_id from pg_temp.activity_seed_payments
        union all select fee_id from pg_temp.activity_seed_dues
      )
    )
    or exists (
      select 1 from app_private.guardian_absence_alerts alert
      join public.attendance mark on mark.id = alert.attendance_id where mark.remarks = 'SMS-ACTIVITY-QA · Synthetic attendance'
      union all
      select 1 from app_private.guardian_late_alerts alert
      join public.attendance mark on mark.id = alert.attendance_id where mark.remarks = 'SMS-ACTIVITY-QA · Synthetic attendance'
    )
  then raise exception 'Incomplete or mis-scoped QA demo activity, or an unexpected notification job.'; end if;
end;
$validate$;

select prefix || case when apk then ' Android QA' else '' end as cohort, count(*) as pupils,
  count(distinct section_id) as sections,
  (select count(*) from public.attendance mark join pg_temp.activity_seed_pupils p on p.student_id = mark.student_id
    where p.prefix = pupil.prefix and p.apk = pupil.apk) as attendance_marks,
  (select count(*) from pg_temp.activity_seed_work w
    where exists (select 1 from pg_temp.activity_seed_pupils p where p.section_id = w.section_id and p.prefix = pupil.prefix and p.apk = pupil.apk)) as classwork_and_homework,
  (select count(*) from public.activity_submissions submission
    join pg_temp.activity_seed_work w on w.work_id = submission.activity_id
    join pg_temp.activity_seed_pupils p on p.student_id = submission.student_id where p.prefix = pupil.prefix and p.apk = pupil.apk) as submissions,
  (select count(*) from public.student_fees fee join pg_temp.activity_seed_pupils p on p.student_id = fee.student_id
    where p.prefix = pupil.prefix and p.apk = pupil.apk) as fee_demands,
  (select count(*) from pg_temp.activity_seed_payments p where p.school_id = pupil.school_id and p.apk = pupil.apk) as qa_receipts,
  0 as push_jobs
from pg_temp.activity_seed_pupils pupil group by prefix, apk, school_id order by prefix, apk;

rollback; -- DRY RUN DEFAULT: replace only after verifying the returned counts.
