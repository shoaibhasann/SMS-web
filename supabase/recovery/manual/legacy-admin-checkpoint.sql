-- Reconstructed application checkpoint, NOT original migration bytes.
-- Source: supabase/schema-snapshots/2026-11-02/schema-metadata.json
-- Source SHA-256: c98134634ffc72d11c94e2042d4b1ee625094db56e21cb90ba0bca75823dad97
-- Offline recovery only; historical permissions are subsequently hardened.

begin;
set local search_path=public,pg_catalog;
set local check_function_bodies=off;

create table "public"."admission_documents" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "admission_id" uuid not null,
  "document_type" text not null,
  "file_path" text,
  "file_name" text,
  "verified" boolean default false not null,
  "verified_by" uuid,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone default now() not null
);
alter table "public"."admission_documents" owner to "postgres";

create table "public"."hr_employees" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "employee_id" text not null,
  "full_name" text not null,
  "email" text,
  "mobile" text,
  "department" text,
  "designation" text,
  "qualification" text,
  "joining_date" date,
  "salary" numeric(12,2) default 0 not null,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."hr_employees" owner to "postgres";

create table "public"."hr_payroll" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "employee_id" uuid not null,
  "payroll_month" date not null,
  "gross_salary" numeric(12,2) default 0 not null,
  "deductions" numeric(12,2) default 0 not null,
  "net_salary" numeric(12,2) generated always as ((gross_salary - deductions)) stored,
  "status" text default 'draft'::text not null,
  "paid_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."hr_payroll" owner to "postgres";

create table "public"."inventory_movements" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "item_id" uuid not null,
  "movement_type" text not null,
  "quantity" integer not null,
  "reference" text,
  "notes" text,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null
);
alter table "public"."inventory_movements" owner to "postgres";

create table "public"."school_documents" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "title" text not null,
  "category" text default 'other'::text not null,
  "file_path" text,
  "file_name" text,
  "mime_type" text,
  "file_size" bigint,
  "description" text,
  "status" text default 'active'::text not null,
  "uploaded_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."school_documents" owner to "postgres";

create table "public"."school_events" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "title" text not null,
  "description" text,
  "event_type" text default 'school_event'::text not null,
  "start_at" timestamp with time zone not null,
  "end_at" timestamp with time zone,
  "all_day" boolean default false not null,
  "audience" text default 'everyone'::text not null,
  "class_id" uuid,
  "section_id" uuid,
  "location" text,
  "status" text default 'scheduled'::text not null,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."school_events" owner to "postgres";

create table "public"."school_notifications" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "title" text not null,
  "message" text not null,
  "notification_type" text default 'general'::text not null,
  "audience" text default 'everyone'::text not null,
  "class_id" uuid,
  "section_id" uuid,
  "status" text default 'draft'::text not null,
  "scheduled_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."school_notifications" owner to "postgres";

create table "public"."staff_leave_requests" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "employee_id" uuid,
  "requested_by" uuid,
  "leave_type" text not null,
  "from_date" date not null,
  "to_date" date not null,
  "reason" text,
  "status" text default 'pending'::text not null,
  "reviewed_by" uuid,
  "reviewed_at" timestamp with time zone,
  "review_note" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."staff_leave_requests" owner to "postgres";

create table "public"."timetable_entries" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "academic_year_id" uuid,
  "class_id" uuid,
  "section_id" uuid,
  "subject_id" uuid,
  "teacher_id" uuid,
  "day_of_week" smallint not null,
  "period_number" integer not null,
  "start_time" time without time zone,
  "end_time" time without time zone,
  "room" text,
  "notes" text,
  "created_by" uuid,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."timetable_entries" owner to "postgres";

create table "public"."transport_allocations" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "student_id" uuid not null,
  "route_id" uuid,
  "stop_name" text,
  "monthly_fee" numeric(12,2) default 0 not null,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."transport_allocations" owner to "postgres";

create table "public"."transport_vehicles" (
  "id" uuid default gen_random_uuid() not null,
  "school_id" uuid not null,
  "vehicle_number" text not null,
  "vehicle_type" text,
  "capacity" integer,
  "driver_name" text,
  "driver_mobile" text,
  "status" text default 'active'::text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
alter table "public"."transport_vehicles" owner to "postgres";

alter table "public"."admission_documents" add constraint "admission_documents_pkey" PRIMARY KEY (id);
alter table "public"."hr_employees" add constraint "hr_employees_pkey" PRIMARY KEY (id);
alter table "public"."hr_employees" add constraint "hr_employees_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'on_leave'::text])));
alter table "public"."hr_payroll" add constraint "hr_payroll_pkey" PRIMARY KEY (id);
alter table "public"."hr_payroll" add constraint "hr_payroll_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'processed'::text, 'paid'::text])));
alter table "public"."inventory_movements" add constraint "inventory_movements_movement_type_check" CHECK ((movement_type = ANY (ARRAY['in'::text, 'out'::text, 'adjustment'::text])));
alter table "public"."inventory_movements" add constraint "inventory_movements_pkey" PRIMARY KEY (id);
alter table "public"."inventory_movements" add constraint "inventory_movements_quantity_check" CHECK ((quantity > 0));
alter table "public"."school_documents" add constraint "school_documents_pkey" PRIMARY KEY (id);
alter table "public"."school_documents" add constraint "school_documents_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])));
alter table "public"."school_events" add constraint "school_events_event_type_check" CHECK ((event_type = ANY (ARRAY['holiday'::text, 'ptm'::text, 'exam'::text, 'annual_function'::text, 'sports_day'::text, 'school_event'::text, 'other'::text])));
alter table "public"."school_events" add constraint "school_events_pkey" PRIMARY KEY (id);
alter table "public"."school_events" add constraint "school_events_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'cancelled'::text, 'completed'::text])));
alter table "public"."school_notifications" add constraint "school_notifications_notification_type_check" CHECK ((notification_type = ANY (ARRAY['homework'::text, 'exam'::text, 'result'::text, 'fee_due'::text, 'attendance'::text, 'notice'::text, 'event'::text, 'general'::text])));
alter table "public"."school_notifications" add constraint "school_notifications_pkey" PRIMARY KEY (id);
alter table "public"."school_notifications" add constraint "school_notifications_status_check" CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sent'::text, 'cancelled'::text])));
alter table "public"."staff_leave_requests" add constraint "staff_leave_requests_check" CHECK ((to_date >= from_date));
alter table "public"."staff_leave_requests" add constraint "staff_leave_requests_pkey" PRIMARY KEY (id);
alter table "public"."staff_leave_requests" add constraint "staff_leave_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])));
alter table "public"."timetable_entries" add constraint "timetable_entries_day_of_week_check" CHECK (((day_of_week >= 1) AND (day_of_week <= 7)));
alter table "public"."timetable_entries" add constraint "timetable_entries_pkey" PRIMARY KEY (id);
alter table "public"."transport_allocations" add constraint "transport_allocations_pkey" PRIMARY KEY (id);
alter table "public"."transport_allocations" add constraint "transport_allocations_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])));
alter table "public"."transport_vehicles" add constraint "transport_vehicles_pkey" PRIMARY KEY (id);
alter table "public"."transport_vehicles" add constraint "transport_vehicles_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'maintenance'::text])));
alter table "public"."admission_documents" add constraint "admission_documents_admission_id_fkey" FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE;
alter table "public"."admission_documents" add constraint "admission_documents_verified_by_fkey" FOREIGN KEY (verified_by) REFERENCES auth.users(id);
alter table "public"."hr_payroll" add constraint "hr_payroll_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."hr_payroll" add constraint "hr_payroll_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE;
alter table "public"."inventory_movements" add constraint "inventory_movements_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."inventory_movements" add constraint "inventory_movements_item_id_fkey" FOREIGN KEY (item_id) REFERENCES inventory_items(id) ON DELETE CASCADE;
alter table "public"."school_documents" add constraint "school_documents_uploaded_by_fkey" FOREIGN KEY (uploaded_by) REFERENCES auth.users(id);
alter table "public"."school_events" add constraint "school_events_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."school_notifications" add constraint "school_notifications_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."staff_leave_requests" add constraint "staff_leave_requests_employee_id_fkey" FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE SET NULL;
alter table "public"."staff_leave_requests" add constraint "staff_leave_requests_requested_by_fkey" FOREIGN KEY (requested_by) REFERENCES auth.users(id);
alter table "public"."staff_leave_requests" add constraint "staff_leave_requests_reviewed_by_fkey" FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);
alter table "public"."timetable_entries" add constraint "timetable_entries_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table "public"."transport_allocations" add constraint "transport_allocations_route_id_fkey" FOREIGN KEY (route_id) REFERENCES transport_routes(id) ON DELETE SET NULL;

alter table public."admission_documents" enable row level security;
revoke all on table public."admission_documents" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."admission_documents" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."admission_documents" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."admission_documents" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."admission_documents" to "service_role";

CREATE UNIQUE INDEX hr_employee_id_unique_idx ON public.hr_employees USING btree (school_id, employee_id);
alter table public."hr_employees" enable row level security;
revoke all on table public."hr_employees" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_employees" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_employees" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_employees" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_employees" to "service_role";

CREATE UNIQUE INDEX hr_payroll_employee_month_idx ON public.hr_payroll USING btree (employee_id, payroll_month);
alter table public."hr_payroll" enable row level security;
revoke all on table public."hr_payroll" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_payroll" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_payroll" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_payroll" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."hr_payroll" to "service_role";

CREATE INDEX inventory_movements_school_idx ON public.inventory_movements USING btree (school_id);
alter table public."inventory_movements" enable row level security;
revoke all on table public."inventory_movements" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."inventory_movements" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."inventory_movements" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."inventory_movements" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."inventory_movements" to "service_role";

alter table public."school_documents" enable row level security;
revoke all on table public."school_documents" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_documents" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_documents" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_documents" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_documents" to "service_role";

CREATE INDEX school_events_school_date_idx ON public.school_events USING btree (school_id, start_at);
alter table public."school_events" enable row level security;
revoke all on table public."school_events" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_events" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_events" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_events" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_events" to "service_role";

CREATE INDEX notifications_school_idx ON public.school_notifications USING btree (school_id);
CREATE INDEX notifications_status_idx ON public.school_notifications USING btree (school_id, status);
alter table public."school_notifications" enable row level security;
revoke all on table public."school_notifications" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_notifications" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_notifications" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_notifications" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."school_notifications" to "service_role";

alter table public."staff_leave_requests" enable row level security;
revoke all on table public."staff_leave_requests" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."staff_leave_requests" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."staff_leave_requests" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."staff_leave_requests" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."staff_leave_requests" to "service_role";

CREATE INDEX timetable_school_idx ON public.timetable_entries USING btree (school_id);
CREATE INDEX timetable_section_day_idx ON public.timetable_entries USING btree (school_id, section_id, day_of_week, period_number);
alter table public."timetable_entries" enable row level security;
revoke all on table public."timetable_entries" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."timetable_entries" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."timetable_entries" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."timetable_entries" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."timetable_entries" to "service_role";

CREATE INDEX transport_allocation_school_idx ON public.transport_allocations USING btree (school_id);
alter table public."transport_allocations" enable row level security;
revoke all on table public."transport_allocations" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_allocations" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_allocations" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_allocations" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_allocations" to "service_role";

CREATE UNIQUE INDEX transport_vehicle_number_unique_idx ON public.transport_vehicles USING btree (school_id, vehicle_number);
CREATE INDEX transport_vehicle_school_idx ON public.transport_vehicles USING btree (school_id);
alter table public."transport_vehicles" enable row level security;
revoke all on table public."transport_vehicles" from PUBLIC,anon,authenticated,service_role;
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_vehicles" to "postgres";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_vehicles" to "anon";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_vehicles" to "authenticated";
grant INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN on table public."transport_vehicles" to "service_role";

CREATE OR REPLACE FUNCTION public.current_admin_school_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT ur.school_id
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
      AND ur.role = 'school_admin'::app_role
      AND ur.school_id IS NOT NULL
    ORDER BY ur.created_at DESC
    LIMIT 1;
$function$;
alter function public."current_admin_school_id"() owner to "postgres";
revoke all on function public."current_admin_school_id"() from PUBLIC,anon,authenticated,service_role;
grant execute on function public."current_admin_school_id"() to "postgres";
grant execute on function public."current_admin_school_id"() to "anon";
grant execute on function public."current_admin_school_id"() to "authenticated";
grant execute on function public."current_admin_school_id"() to "service_role";

CREATE OR REPLACE FUNCTION public.is_school_admin_for_school(p_school_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = auth.uid()
          AND (
                (
                    ur.role = 'school_admin'::app_role
                    AND ur.school_id = p_school_id
                )
                OR
                (
                    ur.role = 'super_admin'::app_role
                )
          )
    );
$function$;
alter function public."is_school_admin_for_school"(p_school_id uuid) owner to "postgres";
revoke all on function public."is_school_admin_for_school"(p_school_id uuid) from PUBLIC,anon,authenticated,service_role;
grant execute on function public."is_school_admin_for_school"(p_school_id uuid) to "postgres";
grant execute on function public."is_school_admin_for_school"(p_school_id uuid) to "anon";
grant execute on function public."is_school_admin_for_school"(p_school_id uuid) to "authenticated";
grant execute on function public."is_school_admin_for_school"(p_school_id uuid) to "service_role";

CREATE OR REPLACE FUNCTION public.write_audit_log(p_school_id uuid, p_action text, p_module text, p_entity_type text DEFAULT NULL::text, p_entity_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
declare
  v_id uuid;
  v_role text;
begin

  if not public.is_school_admin_for_school(p_school_id) then
    raise exception 'Not authorized for this school';
  end if;

  select ur.role::text
  into v_role
  from public.user_roles as ur
  where ur.user_id = (select auth.uid())
    and ur.school_id = p_school_id
  limit 1;

  insert into public.audit_logs (
    school_id,
    user_id,
    role,
    action,
    module,
    entity_type,
    entity_id,
    description,
    metadata
  )
  values (
    p_school_id,
    (select auth.uid()),
    v_role,
    p_action,
    p_module,
    p_entity_type,
    p_entity_id,
    p_description,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;

end;
$function$;
alter function public."write_audit_log"(p_school_id uuid, p_action text, p_module text, p_entity_type text, p_entity_id uuid, p_description text, p_metadata jsonb) owner to "postgres";
revoke all on function public."write_audit_log"(p_school_id uuid, p_action text, p_module text, p_entity_type text, p_entity_id uuid, p_description text, p_metadata jsonb) from PUBLIC,anon,authenticated,service_role;
grant execute on function public."write_audit_log"(p_school_id uuid, p_action text, p_module text, p_entity_type text, p_entity_id uuid, p_description text, p_metadata jsonb) to PUBLIC;
grant execute on function public."write_audit_log"(p_school_id uuid, p_action text, p_module text, p_entity_type text, p_entity_id uuid, p_description text, p_metadata jsonb) to "postgres";
grant execute on function public."write_audit_log"(p_school_id uuid, p_action text, p_module text, p_entity_type text, p_entity_id uuid, p_description text, p_metadata jsonb) to "anon";
grant execute on function public."write_audit_log"(p_school_id uuid, p_action text, p_module text, p_entity_type text, p_entity_id uuid, p_description text, p_metadata jsonb) to "authenticated";
grant execute on function public."write_audit_log"(p_school_id uuid, p_action text, p_module text, p_entity_type text, p_entity_id uuid, p_description text, p_metadata jsonb) to "service_role";

create policy "admin_academic_years_all" on "public"."academic_years" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_admission_documents_all" on "public"."admission_documents" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admission_documents_school_admin_all" on "public"."admission_documents" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_admissions_all" on "public"."admissions" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admissions_school_admin_all" on "public"."admissions" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_attendance_all" on "public"."attendance" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_audit_logs_all" on "public"."audit_logs" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "audit_logs_school_admin_all" on "public"."audit_logs" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_class_activities_all" on "public"."class_activities" as PERMISSIVE for ALL to "authenticated" using ((EXISTS ( SELECT 1
   FROM class_logs cl
  WHERE ((cl.id = class_activities.class_log_id) AND is_school_admin_for_school(cl.school_id))))) with check ((EXISTS ( SELECT 1
   FROM class_logs cl
  WHERE ((cl.id = class_activities.class_log_id) AND is_school_admin_for_school(cl.school_id)))));
create policy "admin_class_logs_all" on "public"."class_logs" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_classes_all" on "public"."classes" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_enrollments_all" on "public"."enrollments" as PERMISSIVE for ALL to "authenticated" using ((EXISTS ( SELECT 1
   FROM students s
  WHERE ((s.id = enrollments.student_id) AND is_school_admin_for_school(s.school_id))))) with check ((EXISTS ( SELECT 1
   FROM students s
  WHERE ((s.id = enrollments.student_id) AND is_school_admin_for_school(s.school_id)))));
create policy "admin_fee_payments_all" on "public"."fee_payments" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_fee_structures_all" on "public"."fee_structures" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_hr_employees_all" on "public"."hr_employees" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "hr_employees_school_admin_all" on "public"."hr_employees" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_hr_payroll_all" on "public"."hr_payroll" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "hr_payroll_school_admin_all" on "public"."hr_payroll" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_inventory_items_all" on "public"."inventory_items" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "inventory_items_school_admin_all" on "public"."inventory_items" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_inventory_movements_all" on "public"."inventory_movements" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "inventory_movements_school_admin_all" on "public"."inventory_movements" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_library_books_all" on "public"."library_books" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "library_books_school_admin_all" on "public"."library_books" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_library_issues_all" on "public"."library_issues" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "library_issues_school_admin_all" on "public"."library_issues" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_parents_all" on "public"."parents" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_profiles_all" on "public"."profiles" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_school_documents_all" on "public"."school_documents" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "documents_school_admin_all" on "public"."school_documents" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_school_events_all" on "public"."school_events" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "events_school_admin_all" on "public"."school_events" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_school_notifications_all" on "public"."school_notifications" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "notifications_school_admin_all" on "public"."school_notifications" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_school_settings_all" on "public"."school_settings" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "settings_school_admin_all" on "public"."school_settings" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_schools_all" on "public"."schools" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(id)) with check (is_school_admin_for_school(id));
create policy "admin_sections_all" on "public"."sections" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_leave_requests_all" on "public"."staff_leave_requests" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "staff_leave_school_admin_all" on "public"."staff_leave_requests" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_student_fees_all" on "public"."student_fees" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_students_all" on "public"."students" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_subjects_all" on "public"."subjects" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_teacher_assessment_marks_all" on "public"."teacher_assessment_marks" as PERMISSIVE for ALL to "authenticated" using ((EXISTS ( SELECT 1
   FROM teacher_assessments ta
  WHERE ((ta.id = teacher_assessment_marks.assessment_id) AND is_school_admin_for_school(ta.school_id))))) with check ((EXISTS ( SELECT 1
   FROM teacher_assessments ta
  WHERE ((ta.id = teacher_assessment_marks.assessment_id) AND is_school_admin_for_school(ta.school_id)))));
create policy "admin_teacher_assessments_all" on "public"."teacher_assessments" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_teacher_assignments_all" on "public"."teacher_subject_assignments" as PERMISSIVE for ALL to "authenticated" using ((EXISTS ( SELECT 1
   FROM teachers t
  WHERE ((t.id = teacher_subject_assignments.teacher_id) AND is_school_admin_for_school(t.school_id))))) with check ((EXISTS ( SELECT 1
   FROM teachers t
  WHERE ((t.id = teacher_subject_assignments.teacher_id) AND is_school_admin_for_school(t.school_id)))));
create policy "admin_teachers_all" on "public"."teachers" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_timetable_all" on "public"."timetable_entries" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "timetable_school_admin_all" on "public"."timetable_entries" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "transport_allocations_school_admin_all" on "public"."transport_allocations" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "transport_routes_school_admin_all" on "public"."transport_routes" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "transport_vehicles_school_admin_all" on "public"."transport_vehicles" as PERMISSIVE for ALL to "authenticated" using (is_school_admin_for_school(school_id)) with check (is_school_admin_for_school(school_id));
create policy "admin_user_roles_select" on "public"."user_roles" as PERMISSIVE for SELECT to "authenticated" using (is_school_admin_for_school(school_id));
CREATE TRIGGER updated_at_hr_employees BEFORE UPDATE ON public.hr_employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_hr_payroll BEFORE UPDATE ON public.hr_payroll FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_school_documents BEFORE UPDATE ON public.school_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_school_events BEFORE UPDATE ON public.school_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_school_notifications BEFORE UPDATE ON public.school_notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_staff_leave_requests BEFORE UPDATE ON public.staff_leave_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_timetable_entries BEFORE UPDATE ON public.timetable_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_transport_allocations BEFORE UPDATE ON public.transport_allocations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_transport_vehicles BEFORE UPDATE ON public.transport_vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- Remaining unrecorded indexes and update triggers are copied from the same snapshot.
CREATE INDEX idx_academic_years_school_id ON public.academic_years USING btree (school_id);
CREATE UNIQUE INDEX admissions_application_unique_idx ON public.admissions USING btree (school_id, application_no) WHERE (application_no IS NOT NULL);
CREATE INDEX admissions_school_idx ON public.admissions USING btree (school_id);
CREATE INDEX admissions_status_idx ON public.admissions USING btree (school_id, status);
CREATE INDEX idx_admissions_school_id ON public.admissions USING btree (school_id);
CREATE INDEX idx_attendance_school_date ON public.attendance USING btree (school_id, attendance_date);
CREATE INDEX audit_logs_school_date_idx ON public.audit_logs USING btree (school_id, created_at DESC);
CREATE INDEX idx_audit_logs_school_created ON public.audit_logs USING btree (school_id, created_at DESC);
CREATE INDEX class_activities_class_log_idx ON public.class_activities USING btree (class_log_id);
CREATE INDEX class_logs_student_lookup_idx ON public.class_logs USING btree (academic_year_id, class_id, section_id, log_date DESC);
CREATE INDEX idx_class_logs_school_date ON public.class_logs USING btree (school_id, log_date);
CREATE INDEX idx_classes_school_id ON public.classes USING btree (school_id);
CREATE INDEX idx_fee_payments_school_id ON public.fee_payments USING btree (school_id);
CREATE INDEX idx_fee_structures_school_id ON public.fee_structures USING btree (school_id);
CREATE INDEX inventory_items_school_idx ON public.inventory_items USING btree (school_id);
CREATE INDEX library_books_school_idx ON public.library_books USING btree (school_id);
CREATE INDEX library_issues_school_idx ON public.library_issues USING btree (school_id);
CREATE INDEX idx_parents_school_id ON public.parents USING btree (school_id);
CREATE INDEX idx_sections_school_id ON public.sections USING btree (school_id);
CREATE INDEX idx_student_fees_school_id ON public.student_fees USING btree (school_id);
CREATE INDEX idx_students_school_id ON public.students USING btree (school_id);
CREATE INDEX idx_subjects_school_id ON public.subjects USING btree (school_id);
CREATE INDEX idx_teachers_school_id ON public.teachers USING btree (school_id);
CREATE INDEX transport_route_school_idx ON public.transport_routes USING btree (school_id);
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
alter function public.set_updated_at() owner to "postgres";
revoke all on function public.set_updated_at() from PUBLIC,anon,authenticated,service_role;
grant execute on function public.set_updated_at() to PUBLIC;
grant execute on function public.set_updated_at() to "postgres";
grant execute on function public.set_updated_at() to "anon";
grant execute on function public.set_updated_at() to "authenticated";
grant execute on function public.set_updated_at() to "service_role";
CREATE TRIGGER updated_at_admissions BEFORE UPDATE ON public.admissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_inventory_items BEFORE UPDATE ON public.inventory_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_library_books BEFORE UPDATE ON public.library_books FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_library_issues BEFORE UPDATE ON public.library_issues FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_school_settings BEFORE UPDATE ON public.school_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER updated_at_transport_routes BEFORE UPDATE ON public.transport_routes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
commit;
