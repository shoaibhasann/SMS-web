create extension if not exists pgcrypto;

create type public.app_role as enum ('super_admin','school_admin','principal','teacher','accountant','reception_staff','parent','student');
create type public.board_type as enum ('CBSE','UP_BOARD');
create type public.attendance_status as enum ('present','absent','late','half_day','leave');
create type public.admission_status as enum ('enquiry','application','document_verification','interview','approved','rejected','admitted');
create type public.payment_status as enum ('pending','paid','partial','failed','refunded');
create type public.notification_channel as enum ('whatsapp','sms','email','push');
create type public.notification_status as enum ('queued','sent','delivered','failed','read');
create type public.activity_type as enum ('classwork','homework','assignment','project','practical','activity','event','test','exam','study_material','notice');
create type public.exam_status as enum ('draft','scheduled','ongoing','completed','published');
create type public.document_status as enum ('pending','verified','rejected');

create table public.schools (
 id uuid primary key default gen_random_uuid(), name text not null, code text unique, affiliation_no text,
 board public.board_type, address text, city text, state text, pincode text, phone text, email text,
 website text, logo_url text, primary_color text, secondary_color text, timezone text not null default 'Asia/Kolkata',
 settings jsonb not null default '{}'::jsonb, is_active boolean not null default true,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.academic_years (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, name text not null, start_date date not null, end_date date not null, is_current boolean not null default false, created_at timestamptz not null default now(), unique(school_id,name));
create table public.classes (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, name text not null, sort_order int not null default 0, is_active boolean not null default true, unique(school_id,name));
create table public.streams (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, name text not null, unique(school_id,name));
create table public.sections (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, class_id uuid not null references public.classes(id) on delete cascade, name text not null, room text, capacity int, unique(class_id,name));
create table public.subjects (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, code text, name text not null, description text, is_practical boolean not null default false, is_active boolean not null default true, unique(school_id,name));

create table public.profiles (id uuid primary key references auth.users(id) on delete cascade, school_id uuid references public.schools(id) on delete set null, full_name text, phone text, email text, avatar_url text, is_active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.user_roles (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, school_id uuid references public.schools(id) on delete cascade, role public.app_role not null, created_at timestamptz not null default now(), unique(user_id,school_id,role));
create table public.permissions (id uuid primary key default gen_random_uuid(), code text unique not null, name text not null, module text not null, description text);
create table public.role_permissions (role public.app_role not null, permission_id uuid not null references public.permissions(id) on delete cascade, primary key(role,permission_id));

create table public.parents (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, profile_id uuid references public.profiles(id) on delete set null, guardian_code text, occupation text, address text, emergency_contact text, created_at timestamptz not null default now(), unique(school_id,guardian_code));
create table public.teachers (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, profile_id uuid references public.profiles(id) on delete set null, employee_id text not null, designation text, department text, joining_date date, qualification text, registered_mobile text, created_at timestamptz not null default now(), unique(school_id,employee_id));
create table public.staff (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, profile_id uuid references public.profiles(id) on delete set null, employee_id text not null, designation text, department text, joining_date date, created_at timestamptz not null default now(), unique(school_id,employee_id));
create table public.students (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, profile_id uuid references public.profiles(id) on delete set null, admission_no text not null, roll_no text, first_name text not null, middle_name text, last_name text, dob date, gender text, blood_group text, admission_date date, photo_url text, address text, city text, state text, pincode text, registered_mobile text, status text not null default 'active', created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(school_id,admission_no));
create table public.student_parents (student_id uuid not null references public.students(id) on delete cascade, parent_id uuid not null references public.parents(id) on delete cascade, relationship text not null, is_primary boolean not null default false, primary key(student_id,parent_id));
create table public.enrollments (id uuid primary key default gen_random_uuid(), student_id uuid not null references public.students(id) on delete cascade, academic_year_id uuid not null references public.academic_years(id) on delete cascade, class_id uuid not null references public.classes(id), section_id uuid references public.sections(id), stream_id uuid references public.streams(id), roll_no text, enrolled_at timestamptz not null default now(), status text not null default 'active', unique(student_id,academic_year_id));
create table public.teacher_subject_assignments (id uuid primary key default gen_random_uuid(), teacher_id uuid not null references public.teachers(id) on delete cascade, academic_year_id uuid not null references public.academic_years(id) on delete cascade, class_id uuid not null references public.classes(id), section_id uuid references public.sections(id), subject_id uuid not null references public.subjects(id), is_class_teacher boolean not null default false, unique(teacher_id,academic_year_id,class_id,section_id,subject_id));

create table public.admissions (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, application_no text not null, applicant_name text not null, dob date, gender text, parent_name text, parent_phone text, parent_email text, class_id uuid references public.classes(id), status public.admission_status not null default 'enquiry', enquiry_date date default current_date, notes text, created_at timestamptz not null default now(), unique(school_id,application_no));
create table public.documents (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, student_id uuid references public.students(id) on delete cascade, admission_id uuid references public.admissions(id) on delete cascade, document_type text not null, file_path text not null, status public.document_status not null default 'pending', verified_by uuid references public.profiles(id), verified_at timestamptz, created_at timestamptz not null default now());

create table public.attendance (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, academic_year_id uuid not null references public.academic_years(id), student_id uuid not null references public.students(id) on delete cascade, section_id uuid references public.sections(id), attendance_date date not null, status public.attendance_status not null, remarks text, marked_by uuid references public.profiles(id), created_at timestamptz not null default now(), unique(student_id,attendance_date));
create table public.teacher_attendance (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, teacher_id uuid not null references public.teachers(id) on delete cascade, attendance_date date not null, status public.attendance_status not null, remarks text, marked_by uuid references public.profiles(id), unique(teacher_id,attendance_date));
create table public.leave_requests (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, requester_id uuid not null references public.profiles(id), start_date date not null, end_date date not null, reason text, status text not null default 'pending', approved_by uuid references public.profiles(id), created_at timestamptz not null default now());

create table public.class_logs (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, academic_year_id uuid not null references public.academic_years(id), class_id uuid not null references public.classes(id), section_id uuid references public.sections(id), subject_id uuid not null references public.subjects(id), teacher_id uuid not null references public.teachers(id), log_date date not null, topic text not null, summary text, teacher_remark text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(section_id,subject_id,log_date,teacher_id));
create table public.class_activities (id uuid primary key default gen_random_uuid(), class_log_id uuid not null references public.class_logs(id) on delete cascade, activity_type public.activity_type not null, title text not null, description text, due_date date, attachment_url text, max_marks numeric, created_at timestamptz not null default now());
create table public.activity_submissions (id uuid primary key default gen_random_uuid(), activity_id uuid not null references public.class_activities(id) on delete cascade, student_id uuid not null references public.students(id) on delete cascade, submitted_at timestamptz, file_url text, text_response text, marks numeric, feedback text, status text not null default 'pending', unique(activity_id,student_id));
create table public.study_materials (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, class_id uuid references public.classes(id), section_id uuid references public.sections(id), subject_id uuid references public.subjects(id), teacher_id uuid references public.teachers(id), title text not null, description text, file_url text, external_url text, published_at timestamptz, created_at timestamptz not null default now());

create table public.exams (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, academic_year_id uuid not null references public.academic_years(id), name text not null, exam_type text not null, start_date date, end_date date, status public.exam_status not null default 'draft', created_at timestamptz not null default now());
create table public.exam_subjects (id uuid primary key default gen_random_uuid(), exam_id uuid not null references public.exams(id) on delete cascade, subject_id uuid not null references public.subjects(id), class_id uuid not null references public.classes(id), max_marks numeric not null, pass_marks numeric, exam_date date, start_time time, end_time time, unique(exam_id,class_id,subject_id));
create table public.marks (id uuid primary key default gen_random_uuid(), exam_subject_id uuid not null references public.exam_subjects(id) on delete cascade, student_id uuid not null references public.students(id) on delete cascade, marks_obtained numeric, grade text, remarks text, entered_by uuid references public.profiles(id), unique(exam_subject_id,student_id));
create table public.report_cards (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, exam_id uuid not null references public.exams(id) on delete cascade, student_id uuid not null references public.students(id) on delete cascade, total_marks numeric, obtained_marks numeric, percentage numeric, overall_grade text, attendance_percentage numeric, remarks text, pdf_url text, published_at timestamptz, unique(exam_id,student_id));

create table public.timetables (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, academic_year_id uuid not null references public.academic_years(id), class_id uuid not null references public.classes(id), section_id uuid references public.sections(id), day_of_week int not null check(day_of_week between 1 and 7), period_no int not null, subject_id uuid references public.subjects(id), teacher_id uuid references public.teachers(id), room text, start_time time, end_time time);
create table public.notices (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, title text not null, content text not null, audience jsonb not null default '[]'::jsonb, published_at timestamptz, expires_at timestamptz, created_by uuid references public.profiles(id), created_at timestamptz not null default now());
create table public.events (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, title text not null, description text, start_at timestamptz not null, end_at timestamptz, location text, audience jsonb not null default '[]'::jsonb, created_by uuid references public.profiles(id), created_at timestamptz not null default now());

create table public.fee_structures (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, academic_year_id uuid not null references public.academic_years(id), class_id uuid references public.classes(id), name text not null, frequency text not null default 'monthly', amount numeric(12,2) not null check(amount >= 0), due_day int, created_at timestamptz not null default now());
create table public.student_fees (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, student_id uuid not null references public.students(id) on delete cascade, fee_structure_id uuid not null references public.fee_structures(id), billing_period text, due_date date, amount numeric(12,2) not null, discount numeric(12,2) not null default 0, late_fee numeric(12,2) not null default 0, status public.payment_status not null default 'pending', created_at timestamptz not null default now());
create table public.fee_payments (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, student_fee_id uuid not null references public.student_fees(id), student_id uuid not null references public.students(id), receipt_no text not null, amount numeric(12,2) not null, payment_method text, transaction_id text, gateway text, status public.payment_status not null default 'paid', paid_at timestamptz default now(), created_at timestamptz not null default now(), unique(school_id,receipt_no));
create table public.fee_discounts (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, student_id uuid not null references public.students(id) on delete cascade, student_fee_id uuid references public.student_fees(id) on delete cascade, amount numeric(12,2) not null, reason text, approved_by uuid references public.profiles(id), created_at timestamptz not null default now());
create table public.fee_refunds (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, payment_id uuid not null references public.fee_payments(id), amount numeric(12,2) not null, reason text, refunded_at timestamptz default now(), processed_by uuid references public.profiles(id));

create table public.notification_templates (id uuid primary key default gen_random_uuid(), school_id uuid references public.schools(id) on delete cascade, name text not null, event_key text not null, channel public.notification_channel not null, subject text, body text not null, is_active boolean not null default true, unique(school_id,event_key,channel));
create table public.notifications (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, recipient_user_id uuid references auth.users(id) on delete cascade, channel public.notification_channel not null, title text, body text not null, status public.notification_status not null default 'queued', scheduled_at timestamptz, sent_at timestamptz, read_at timestamptz, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create table public.notification_logs (id uuid primary key default gen_random_uuid(), notification_id uuid not null references public.notifications(id) on delete cascade, provider text, provider_message_id text, status public.notification_status, response jsonb, created_at timestamptz not null default now());
create table public.communication_logs (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, channel public.notification_channel not null, recipient text not null, template_id uuid references public.notification_templates(id), status public.notification_status not null default 'queued', provider_message_id text, payload jsonb, error_message text, created_at timestamptz not null default now());

create table public.library_books (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, isbn text, title text not null, author text, publisher text, category text, total_copies int not null default 1, available_copies int not null default 1, created_at timestamptz not null default now());
create table public.library_issues (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, book_id uuid not null references public.library_books(id), student_id uuid references public.students(id), teacher_id uuid references public.teachers(id), issued_at timestamptz not null default now(), due_date date, returned_at timestamptz, fine numeric(10,2) not null default 0, check(num_nonnulls(student_id,teacher_id)=1));
create table public.transport_routes (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, name text not null, vehicle_no text, driver_name text, driver_phone text, route_details jsonb not null default '[]'::jsonb);
create table public.transport_assignments (id uuid primary key default gen_random_uuid(), route_id uuid not null references public.transport_routes(id) on delete cascade, student_id uuid not null references public.students(id) on delete cascade, pickup_stop text, drop_stop text, start_date date, end_date date, unique(route_id,student_id));
create table public.inventory_items (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, name text not null, category text, unit text, quantity numeric not null default 0, reorder_level numeric not null default 0, created_at timestamptz not null default now());
create table public.inventory_transactions (id uuid primary key default gen_random_uuid(), item_id uuid not null references public.inventory_items(id) on delete cascade, transaction_type text not null, quantity numeric not null, reference text, performed_by uuid references public.profiles(id), created_at timestamptz not null default now());
create table public.employees (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, profile_id uuid references public.profiles(id), employee_id text not null, designation text, department text, joining_date date, salary numeric(12,2), status text not null default 'active', unique(school_id,employee_id));
create table public.leave_balances (id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.employees(id) on delete cascade, leave_type text not null, total_days numeric not null default 0, used_days numeric not null default 0, academic_year_id uuid references public.academic_years(id), unique(employee_id,leave_type,academic_year_id));
create table public.payroll (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, employee_id uuid not null references public.employees(id), payroll_month date not null, gross_salary numeric(12,2) not null, deductions numeric(12,2) not null default 0, bonuses numeric(12,2) not null default 0, net_salary numeric(12,2) generated always as (gross_salary - deductions + bonuses) stored, status text not null default 'draft', paid_at timestamptz, unique(employee_id,payroll_month));

create table public.audit_logs (id uuid primary key default gen_random_uuid(), school_id uuid references public.schools(id) on delete cascade, actor_user_id uuid references auth.users(id) on delete set null, action text not null, entity_type text, entity_id uuid, old_data jsonb, new_data jsonb, ip_address inet, user_agent text, created_at timestamptz not null default now());
create table public.school_settings (school_id uuid primary key references public.schools(id) on delete cascade, settings jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table public.role_activation_requests (id uuid primary key default gen_random_uuid(), school_id uuid not null references public.schools(id) on delete cascade, user_id uuid references auth.users(id) on delete cascade, requested_role public.app_role not null, admission_no text, employee_id text, registered_mobile text, status text not null default 'pending', verified_by uuid references public.profiles(id), created_at timestamptz not null default now());

create index idx_profiles_school on public.profiles(school_id);
create index idx_user_roles_user on public.user_roles(user_id);
create index idx_students_school on public.students(school_id);
create index idx_enrollments_year_class on public.enrollments(academic_year_id,class_id,section_id);
create index idx_attendance_student_date on public.attendance(student_id,attendance_date desc);
create index idx_class_logs_section_subject_date on public.class_logs(section_id,subject_id,log_date desc);
create index idx_activities_log on public.class_activities(class_log_id);
create index idx_marks_student on public.marks(student_id);
create index idx_student_fees_student on public.student_fees(student_id,status);
create index idx_notifications_recipient on public.notifications(recipient_user_id,status,created_at desc);
create index idx_audit_school_time on public.audit_logs(school_id,created_at desc);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
create trigger trg_schools_updated before update on public.schools for each row execute function public.set_updated_at();
create trigger trg_profiles_updated before update on public.profiles for each row execute function public.set_updated_at();
create trigger trg_students_updated before update on public.students for each row execute function public.set_updated_at();
create trigger trg_class_logs_updated before update on public.class_logs for each row execute function public.set_updated_at();

create or replace function public.current_user_school_ids() returns setof uuid language sql stable security definer set search_path=public as $$ select school_id from public.user_roles where user_id=auth.uid() and school_id is not null; $$;
create or replace function public.has_role(p_role public.app_role, p_school uuid default null) returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.user_roles ur where ur.user_id=auth.uid() and ur.role=p_role and (p_school is null or ur.school_id=p_school)); $$;

alter table public.schools enable row level security;
alter table public.academic_years enable row level security;
alter table public.classes enable row level security;
alter table public.streams enable row level security;
alter table public.sections enable row level security;
alter table public.subjects enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.parents enable row level security;
alter table public.teachers enable row level security;
alter table public.staff enable row level security;
alter table public.students enable row level security;
alter table public.student_parents enable row level security;
alter table public.enrollments enable row level security;
alter table public.teacher_subject_assignments enable row level security;
alter table public.admissions enable row level security;
alter table public.documents enable row level security;
alter table public.attendance enable row level security;
alter table public.teacher_attendance enable row level security;
alter table public.leave_requests enable row level security;
alter table public.class_logs enable row level security;
alter table public.class_activities enable row level security;
alter table public.activity_submissions enable row level security;
alter table public.study_materials enable row level security;
alter table public.exams enable row level security;
alter table public.exam_subjects enable row level security;
alter table public.marks enable row level security;
alter table public.report_cards enable row level security;
alter table public.timetables enable row level security;
alter table public.notices enable row level security;
alter table public.events enable row level security;
alter table public.fee_structures enable row level security;
alter table public.student_fees enable row level security;
alter table public.fee_payments enable row level security;
alter table public.fee_discounts enable row level security;
alter table public.fee_refunds enable row level security;
alter table public.notification_templates enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_logs enable row level security;
alter table public.communication_logs enable row level security;
alter table public.library_books enable row level security;
alter table public.library_issues enable row level security;
alter table public.transport_routes enable row level security;
alter table public.transport_assignments enable row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.employees enable row level security;
alter table public.leave_balances enable row level security;
alter table public.payroll enable row level security;
alter table public.audit_logs enable row level security;
alter table public.school_settings enable row level security;
alter table public.role_activation_requests enable row level security;

create policy schools_member_select on public.schools for select using (id in (select public.current_user_school_ids()));
create policy schools_admin_all on public.schools for all using (public.has_role('super_admin',id) or public.has_role('school_admin',id)) with check (public.has_role('super_admin',id) or public.has_role('school_admin',id));

-- Standard tenant isolation for school-scoped tables.
do $$ declare t text; begin foreach t in array array['academic_years','classes','streams','sections','subjects','profiles','user_roles','parents','teachers','staff','students','admissions','documents','attendance','teacher_attendance','leave_requests','class_logs','study_materials','exams','timetables','notices','events','fee_structures','student_fees','fee_payments','fee_discounts','fee_refunds','notification_templates','notifications','communication_logs','library_books','library_issues','transport_routes','inventory_items','employees','payroll','audit_logs','school_settings','role_activation_requests'] loop execute format('create policy %I on public.%I for all using (school_id in (select public.current_user_school_ids())) with check (school_id in (select public.current_user_school_ids()));', 'tenant_isolation_'||t,t); end loop; end $$;

create policy student_parents_tenant on public.student_parents for all using (exists(select 1 from public.students s where s.id=student_id and s.school_id in (select public.current_user_school_ids()))) with check (exists(select 1 from public.students s where s.id=student_id and s.school_id in (select public.current_user_school_ids())));
create policy enrollments_tenant on public.enrollments for all using (exists(select 1 from public.students s where s.id=student_id and s.school_id in (select public.current_user_school_ids()))) with check (exists(select 1 from public.students s where s.id=student_id and s.school_id in (select public.current_user_school_ids())));
create policy teacher_assignments_tenant on public.teacher_subject_assignments for all using (exists(select 1 from public.teachers t where t.id=teacher_id and t.school_id in (select public.current_user_school_ids()))) with check (exists(select 1 from public.teachers t where t.id=teacher_id and t.school_id in (select public.current_user_school_ids())));
create policy class_activities_tenant on public.class_activities for all using (exists(select 1 from public.class_logs l where l.id=class_log_id and l.school_id in (select public.current_user_school_ids()))) with check (exists(select 1 from public.class_logs l where l.id=class_log_id and l.school_id in (select public.current_user_school_ids())));
create policy activity_submissions_tenant on public.activity_submissions for all using (exists(select 1 from public.class_activities a join public.class_logs l on l.id=a.class_log_id where a.id=activity_id and l.school_id in (select public.current_user_school_ids()))) with check (exists(select 1 from public.class_activities a join public.class_logs l on l.id=a.class_log_id where a.id=activity_id and l.school_id in (select public.current_user_school_ids())));
create policy exam_subjects_tenant on public.exam_subjects for all using (exists(select 1 from public.exams e where e.id=exam_id and e.school_id in (select public.current_user_school_ids()))) with check (exists(select 1 from public.exams e where e.id=exam_id and e.school_id in (select public.current_user_school_ids())));
create policy marks_tenant on public.marks for all using (exists(select 1 from public.exam_subjects es join public.exams e on e.id=es.exam_id where es.id=exam_subject_id and e.school_id in (select public.current_user_school_ids()))) with check (exists(select 1 from public.exam_subjects es join public.exams e on e.id=es.exam_id where es.id=exam_subject_id and e.school_id in (select public.current_user_school_ids())));

create policy permissions_read_authenticated on public.permissions for select to authenticated using (true);
create policy role_permissions_read_authenticated on public.role_permissions for select to authenticated using (true);

insert into public.permissions(code,name,module) values
('dashboard.view','View dashboard','dashboard'),('students.view','View students','students'),('students.manage','Manage students','students'),('parents.view','View parents','parents'),('parents.manage','Manage parents','parents'),('teachers.view','View teachers','teachers'),('teachers.manage','Manage teachers','teachers'),('attendance.view','View attendance','attendance'),('attendance.manage','Manage attendance','attendance'),('academics.view','View academic logs','academics'),('academics.manage','Manage academic logs','academics'),('fees.view','View fees','fees'),('fees.manage','Manage fees','fees'),('exams.view','View exams','exams'),('exams.manage','Manage exams','exams'),('reports.view','View reports','reports'),('communication.manage','Manage communication','communication'),('settings.manage','Manage settings','settings'),('audit.view','View audit logs','security')
on conflict (code) do nothing;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$ begin insert into public.profiles(id,full_name,email) values(new.id,coalesce(new.raw_user_meta_data->>'full_name',new.email),new.email) on conflict (id) do nothing; return new; end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();