create or replace view public.student_missed_activities as
select
 a.student_id,
 a.attendance_date,
 cl.id as class_log_id,
 cl.subject_id,
 cl.teacher_id,
 cl.topic,
 cl.summary,
 ca.id as activity_id,
 ca.activity_type,
 ca.title,
 ca.description,
 ca.due_date,
 ca.attachment_url,
 ca.max_marks
from public.attendance a
join public.class_logs cl
  on cl.school_id=a.school_id
 and cl.section_id=a.section_id
 and cl.log_date=a.attendance_date
join public.class_activities ca on ca.class_log_id=cl.id
where a.status='absent';

create index if not exists attendance_missed_lookup_idx on public.attendance(student_id,attendance_date,status,section_id);
create index if not exists class_logs_missed_lookup_idx on public.class_logs(section_id,log_date,subject_id);
create index if not exists class_activities_log_idx on public.class_activities(class_log_id);