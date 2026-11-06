insert into public.role_permissions(role,permission_id)
select x.role,p.id from public.permissions p cross join (values
('super_admin'::app_role),('school_admin'::app_role),('principal'::app_role),('teacher'::app_role),('accountant'::app_role),('reception_staff'::app_role),('parent'::app_role),('student'::app_role)
) x(role)
where (x.role='super_admin')
   or (x.role='school_admin')
   or (x.role='principal' and p.code in ('dashboard.view','academics.view','academics.manage','attendance.view','attendance.manage','exams.view','exams.manage','fees.view','reports.view','communication.manage','students.view','teachers.view','parents.view'))
   or (x.role='teacher' and p.code in ('dashboard.view','academics.view','academics.manage','attendance.view','attendance.manage','exams.view','exams.manage','students.view','parents.view','reports.view'))
   or (x.role='accountant' and p.code in ('dashboard.view','fees.view','fees.manage','reports.view','students.view','parents.view'))
   or (x.role='reception_staff' and p.code in ('dashboard.view','students.view','students.manage','parents.view','parents.manage','teachers.view','attendance.view','reports.view'))
   or (x.role='parent' and p.code in ('dashboard.view','academics.view','attendance.view','exams.view','fees.view','reports.view','students.view'))
   or (x.role='student' and p.code in ('dashboard.view','academics.view','attendance.view','exams.view','fees.view','reports.view'))
on conflict do nothing;