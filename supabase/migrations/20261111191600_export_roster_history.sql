-- School data export keeps the Phase 2 roster history: withdrawal reinstatements
-- (a reinstated withdrawal leaves enrollment_withdrawals), pupil admission and detail-edit
-- audit, and the actor/time on student CSV import receipts. Copied from
-- 20261110081727_school_data_portability.sql (its latest definition); only catalogue rows are
-- added. export_school_dataset reads the catalogue at run time and is unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The query catalogue is constant and projects only reviewed business columns.
-- Dataset, school ID and page offset never become SQL syntax.
create or replace function app_private.school_export_catalogue()
returns table(name text, order_key text, source_sql text)
language sql immutable security invoker set search_path = ''
as $catalogue$
  values
    ('academic_year_activations', 'academic_year_id', $query$
     select r.academic_year_id, r.school_id, r.previous_year_id, r.reason, r.promoted_count, r.actor_id, r.activated_at
     from app_private.academic_year_activations r
     where r.school_id = $1
     $query$),
    ('academic_years', 'id', $query$
     select r.id, r.school_id, r.name, r.start_date, r.end_date, r.is_current, r.created_at
     from public.academic_years r
     where r.school_id = $1
     $query$),
    ('activity_submissions', 'id', $query$
     select r.id, r.activity_id, r.student_id, r.submitted_at, r.text_response, r.marks, r.feedback, r.status, r.revision, r.file_name
     from public.activity_submissions r
     join public.class_activities a on a.id=r.activity_id join public.class_logs l on l.id=a.class_log_id and l.school_id=$1 join public.students s on s.id=r.student_id and s.school_id=$1
     where $1 is not null
     $query$),
    ('admission_documents', 'id', $query$
     select r.id, r.school_id, r.admission_id, r.document_type, r.file_name, r.verified, r.verified_by, r.verified_at, r.created_at
     from public.admission_documents r
     where r.school_id = $1
     $query$),
    ('admissions', 'id', $query$
     select r.id, r.school_id, r.application_no, r.applicant_name, r.dob, r.gender, r.parent_name, r.parent_phone, r.parent_email, r.class_id, r.status, r.enquiry_date, r.notes, r.created_at
     from public.admissions r
     where r.school_id = $1
     $query$),
    ('assessment_result_submissions', 'id', $query$
     select r.id, r.assessment_id, r.school_id, r.teacher_id, r.requested_by, r.requester_name, r.requested_at, r.status, r.reviewed_by, r.reviewer_name, r.review_note, r.reviewed_at, r.revision, jsonb_build_object('metadata', r.payload->'metadata', 'pupils', r.payload->'pupils') as result_snapshot
     from app_private.assessment_result_submissions r
     where r.school_id = $1
     $query$),
    ('attendance', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.student_id, r.section_id, r.attendance_date, r.status, r.remarks, r.marked_by, r.created_at, r.revision
     from public.attendance r
     where r.school_id = $1
     $query$),
    ('attendance_corrections', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.section_id, r.student_id, r.attendance_date, r.requested_by, r.request_reason, r.requested_status, r.before_record, r.after_record, r.requested_at, r.state, r.reviewed_by, r.reviewed_at, r.review_reason
     from app_private.attendance_corrections r
     where r.school_id = $1
     $query$),
    ('attendance_submission_settings', 'school_id', $query$
     select r.school_id, r.cutoff_time, r.revision, r.updated_by, r.updated_at
     from app_private.attendance_submission_settings r
     where r.school_id = $1
     $query$),
    ('attendance_submission_settings_audit', 'id', $query$
     select r.id, r.school_id, r.revision, r.previous_cutoff_time, r.cutoff_time, r.reason, r.changed_by, r.changed_at
     from app_private.attendance_submission_settings_audit r
     where r.school_id = $1
     $query$),
    ('audit_logs', 'id', $query$
     select r.id, r.school_id, r.actor_user_id, r.action, r.entity_type, r.entity_id, r.created_at
     from public.audit_logs r
     where r.school_id = $1
     $query$),
    ('class_activities', 'id', $query$
     select r.id, r.class_log_id, r.activity_type, r.title, r.description, r.due_date, r.max_marks, r.created_at
     from public.class_activities r
     join public.class_logs l on l.id=r.class_log_id and l.school_id=$1
     where $1 is not null
     $query$),
    ('class_logs', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.class_id, r.section_id, r.subject_id, r.teacher_id, r.log_date, r.topic, r.summary, r.teacher_remark, r.created_at, r.updated_at, r.status, r.published_at, r.published_by
     from public.class_logs r
     where r.school_id = $1
     $query$),
    ('classes', 'id', $query$
     select r.id, r.school_id, r.name, r.sort_order, r.is_active
     from public.classes r
     where r.school_id = $1
     $query$),
    ('communication_logs', 'id', $query$
     select r.id, r.school_id, r.channel, r.recipient, r.template_id, r.status, r.created_at
     from public.communication_logs r
     where r.school_id = $1
     $query$),
    ('documents', 'id', $query$
     select r.id, r.school_id, r.student_id, r.admission_id, r.document_type, r.status, r.verified_by, r.verified_at, r.created_at
     from public.documents r
     where r.school_id = $1
     $query$),
    ('employees', 'id', $query$
     select r.id, r.school_id, r.profile_id, r.employee_id, r.designation, r.department, r.joining_date, r.salary, r.status
     from public.employees r
     where r.school_id = $1
     $query$),
    ('enrollment_reinstatements', 'id', $query$
     select r.id, r.enrollment_id, r.student_id, r.school_id, r.academic_year_id, r.class_id, r.section_id, r.withdrawal_reason, r.withdrawn_by, r.withdrawn_at, r.reason, r.reinstated_by, r.reinstated_at
     from app_private.enrollment_reinstatements r
     where r.school_id = $1
     $query$),
    ('enrollment_withdrawals', 'enrollment_id', $query$
     select r.enrollment_id, r.student_id, r.school_id, r.academic_year_id, r.class_id, r.section_id, r.reason, r.withdrawn_by, r.withdrawn_at
     from app_private.enrollment_withdrawals r
     where r.school_id = $1
     $query$),
    ('enrollments', 'id', $query$
     select r.id, r.student_id, r.academic_year_id, r.class_id, r.section_id, r.stream_id, r.roll_no, r.enrolled_at, r.status
     from public.enrollments r
     join public.students s on s.id=r.student_id and s.school_id=$1 join public.academic_years y on y.id=r.academic_year_id and y.school_id=$1
     where $1 is not null
     $query$),
    ('events', 'id', $query$
     select r.id, r.school_id, r.title, r.description, r.start_at, r.end_at, r.location, r.audience, r.created_by, r.created_at
     from public.events r
     where r.school_id = $1
     $query$),
    ('exam_subjects', 'id', $query$
     select r.id, r.exam_id, r.subject_id, r.class_id, r.max_marks, r.pass_marks, r.exam_date, r.start_time, r.end_time
     from public.exam_subjects r
     join public.exams e on e.id=r.exam_id and e.school_id=$1
     where $1 is not null
     $query$),
    ('exams', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.name, r.exam_type, r.start_date, r.end_date, r.status, r.created_at
     from public.exams r
     where r.school_id = $1
     $query$),
    ('fee_discounts', 'id', $query$
     select r.id, r.school_id, r.student_id, r.student_fee_id, r.amount, r.reason, r.approved_by, r.created_at
     from public.fee_discounts r
     where r.school_id = $1
     $query$),
    ('fee_payments', 'id', $query$
     select r.id, r.school_id, r.student_fee_id, r.student_id, r.receipt_no, r.amount, r.payment_method, r.transaction_id, r.gateway, r.status, r.paid_at, r.created_at, r.office_request_id, r.recorded_by
     from public.fee_payments r
     where r.school_id = $1
     $query$),
    ('fee_refunds', 'id', $query$
     select r.id, r.school_id, r.payment_id, r.amount, r.reason, r.refunded_at, r.processed_by
     from public.fee_refunds r
     where r.school_id = $1
     $query$),
    ('fee_structures', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.class_id, r.name, r.frequency, r.amount, r.due_day, r.created_at
     from public.fee_structures r
     where r.school_id = $1
     $query$),
    ('files', 'source,source_id', $query$
     select source, source_id, bucket, path, name, byte_size
     from app_private.school_export_file_refs($1) where path is not null
     $query$),
    ('gate_attendance_days', 'student_id,attendance_date', $query$
     select r.student_id, r.attendance_date, r.school_id, r.device_id, r.attendance_id, r.attendance_revision, r.first_in_at, r.source_event_id
     from app_private.gate_attendance_days r
     where r.school_id = $1
     $query$),
    ('gate_devices', 'id', $query$
     select r.id, r.school_id, r.name, r.late_after, r.working_days, r.created_by, r.created_at, r.revoked_at, r.revoked_by, r.revoke_reason
     from app_private.gate_devices r
     where r.school_id = $1
     $query$),
    ('gate_events', 'id', $query$
     select r.id, r.device_id, r.school_id, r.direction, r.occurred_at, r.received_at, r.student_id, r.attendance_id, r.attendance_status, r.status, r.reason, r.calendar_policy_revision, r.calendar_exception_revision
     from app_private.gate_events r
     where r.school_id = $1
     $query$),
    ('guardian_access_audit', 'id', $query$
     select r.id, r.school_id, r.student_id, r.parent_id, r.guardian_profile_id, r.actor_id, r.action, r.relationship, r.reason, r.occurred_at, r.was_primary
     from app_private.guardian_access_audit r
     where r.school_id = $1
     $query$),
    ('guardian_contact_audit', 'id', $query$
     select r.id, r.school_id, r.parent_id, r.actor_id, r.action, r.revoked_invite_count, r.occurred_at
     from app_private.guardian_contact_audit r
     where r.school_id = $1
     $query$),
    ('hr_employees', 'id', $query$
     select r.id, r.school_id, r.employee_id, r.full_name, r.email, r.mobile, r.department, r.designation, r.qualification, r.joining_date, r.salary, r.status, r.created_at, r.updated_at
     from public.hr_employees r
     where r.school_id = $1
     $query$),
    ('hr_payroll', 'id', $query$
     select r.id, r.school_id, r.employee_id, r.payroll_month, r.gross_salary, r.deductions, r.net_salary, r.status, r.paid_at, r.created_by, r.created_at, r.updated_at
     from public.hr_payroll r
     where r.school_id = $1
     $query$),
    ('inventory_items', 'id', $query$
     select r.id, r.school_id, r.name, r.category, r.unit, r.quantity, r.reorder_level, r.created_at
     from public.inventory_items r
     where r.school_id = $1
     $query$),
    ('inventory_movements', 'id', $query$
     select r.id, r.school_id, r.item_id, r.movement_type, r.quantity, r.reference, r.notes, r.created_by, r.created_at
     from public.inventory_movements r
     where r.school_id = $1
     $query$),
    ('inventory_transactions', 'id', $query$
     select r.id, r.item_id, r.transaction_type, r.quantity, r.reference, r.performed_by, r.created_at
     from public.inventory_transactions r
     join public.inventory_items i on i.id=r.item_id and i.school_id=$1
     where $1 is not null
     $query$),
    ('leave_balances', 'id', $query$
     select r.id, r.employee_id, r.leave_type, r.total_days, r.used_days, r.academic_year_id
     from public.leave_balances r
     join public.employees e on e.id=r.employee_id and e.school_id=$1
     left join public.academic_years y on y.id=r.academic_year_id and y.school_id=$1
     where r.academic_year_id is null or y.id is not null
     $query$),
    ('leave_requests', 'id', $query$
     select r.id, r.school_id, r.requester_id, r.start_date, r.end_date, r.reason, r.status, r.approved_by, r.created_at
     from public.leave_requests r
     where r.school_id = $1
     $query$),
    ('library_books', 'id', $query$
     select r.id, r.school_id, r.isbn, r.title, r.author, r.publisher, r.category, r.total_copies, r.available_copies, r.created_at
     from public.library_books r
     where r.school_id = $1
     $query$),
    ('library_issues', 'id', $query$
     select r.id, r.school_id, r.book_id, r.student_id, r.teacher_id, r.issued_at, r.due_date, r.returned_at, r.fine
     from public.library_issues r
     where r.school_id = $1
     $query$),
    ('marks', 'id', $query$
     select r.id, r.exam_subject_id, r.student_id, r.marks_obtained, r.grade, r.remarks, r.entered_by
     from public.marks r
     join public.exam_subjects q on q.id=r.exam_subject_id join public.exams e on e.id=q.exam_id and e.school_id=$1 join public.students s on s.id=r.student_id and s.school_id=$1
     where $1 is not null
     $query$),
    ('notices', 'id', $query$
     select r.id, r.school_id, r.title, r.content, r.audience, r.published_at, r.expires_at, r.created_by, r.created_at, r.version
     from public.notices r
     where r.school_id = $1
     $query$),
    ('notification_templates', 'id', $query$
     select r.id, r.school_id, r.name, r.event_key, r.channel, r.subject, r.body, r.is_active
     from public.notification_templates r
     where r.school_id = $1
     $query$),
    ('notifications', 'id', $query$
     select r.id, r.school_id, r.recipient_user_id, r.channel, r.title, r.body, r.status, r.scheduled_at, r.sent_at, r.read_at, r.created_at
     from public.notifications r
     where r.school_id = $1
     $query$),
    ('office_credit_change_requests', 'id', $query$
     select r.id, r.school_id, r.student_id, r.kind, r.amount, r.entry_target_id, r.fee_id, r.request_reason, r.requested_by, r.requester_name, r.requested_at, r.state, r.reviewed_by, r.reviewer_name, r.review_reason, r.reviewed_at, r.entry_id, r.reference, r.effective_day, r.cancelled_by, r.canceller_name, r.cancel_reason, r.cancelled_at
     from app_private.office_credit_change_requests r
     where r.school_id = $1
     $query$),
    ('office_fee_adjustment_entries', 'id', $query$
     select r.id, r.request_id, r.school_id, r.fee_id, r.student_id, r.signed_amount, r.approved_by, r.approved_at, r.reference
     from app_private.office_fee_adjustment_entries r
     where r.school_id = $1
     $query$),
    ('office_fee_batch_items', 'batch_id,student_fee_id', $query$
     select r.batch_id, r.student_fee_id, r.was_created, r.snapshot
     from app_private.office_fee_batch_items r
     join app_private.office_fee_batches b on b.id=r.batch_id and b.school_id=$1
     join public.student_fees f on f.id=r.student_fee_id and f.school_id=$1
     where $1 is not null
     $query$),
    ('office_fee_batches', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.actor_id, r.kind, r.posted_at
     from app_private.office_fee_batches r
     where r.school_id = $1
     $query$),
    ('office_fee_change_requests', 'id', $query$
     select r.id, r.school_id, r.fee_id, r.student_id, r.kind, r.amount, r.payment_id, r.request_reason, r.requested_by, r.requester_name, r.requested_at, r.before_position, r.after_position, r.state, r.reviewed_by, r.reviewer_name, r.review_reason, r.reviewed_at, r.entry_id, r.reference, r.effective_day
     from app_private.office_fee_change_requests r
     where r.school_id = $1
     $query$),
    ('office_fee_days', 'business_date', $query$
     select r.school_id, r.business_date, r.revision, r.closed_at, r.closed_by, r.closed_by_name, r.summary, r.counted_cash, r.variance_note
     from app_private.office_fee_days r
     where r.school_id = $1
     $query$),
    ('office_fee_opening_structures', 'academic_year_id', $query$
     select r.school_id, r.academic_year_id, r.fee_structure_id
     from app_private.office_fee_opening_structures r
     where r.school_id = $1
     $query$),
    ('office_fee_openings', 'student_fee_id', $query$
     select r.school_id, r.academic_year_id, r.student_id, r.student_fee_id, r.batch_id, r.as_of_date, r.source_reference, r.reason
     from app_private.office_fee_openings r
     where r.school_id = $1
     $query$),
    ('office_fee_payment_reversals', 'id', $query$
     select r.id, r.request_id, r.payment_id, r.school_id, r.fee_id, r.student_id, r.amount, r.payment_method, r.approved_by, r.approved_at, r.business_date, r.reference
     from app_private.office_fee_payment_reversals r
     where r.school_id = $1
     $query$),
    ('office_student_credit_accounts', 'student_id', $query$
     select r.school_id, r.student_id, r.revision
     from app_private.office_student_credit_accounts r
     where r.school_id = $1
     $query$),
    ('office_student_credit_entries', 'id', $query$
     select r.id, r.school_id, r.student_id, r.kind, r.amount, r.reference, r.payment_method, r.fee_id, r.related_entry_id, r.credit_request_id, r.actor_id, r.actor_name, r.reason, r.occurred_at, r.business_date
     from app_private.office_student_credit_entries r
     where r.school_id = $1
     $query$),
    ('parents', 'id', $query$
     select r.id, r.school_id, r.profile_id, r.occupation, r.address, r.emergency_contact, r.created_at, r.registered_mobile
     from public.parents r
     where r.school_id = $1
     $query$),
    ('payment_orders', 'id', $query$
     select r.id, r.school_id, r.student_id, r.student_fee_id, r.provider, r.provider_order_id, r.amount, r.currency, r.status, r.created_at, r.updated_at
     from public.payment_orders r
     where r.school_id = $1
     $query$),
    ('payroll', 'id', $query$
     select r.id, r.school_id, r.employee_id, r.payroll_month, r.gross_salary, r.deductions, r.bonuses, r.net_salary, r.status, r.paid_at
     from public.payroll r
     join public.employees e on e.id=r.employee_id and e.school_id=$1
     where r.school_id=$1
     $query$),
    ('profiles', 'id', $query$
     select r.id, r.school_id, r.full_name, r.phone, r.email, r.is_active, r.created_at, r.updated_at
     from public.profiles r
     where r.school_id = $1
     $query$),
    ('report_cards', 'id', $query$
     select r.id, r.school_id, r.exam_id, r.student_id, r.total_marks, r.obtained_marks, r.percentage, r.overall_grade, r.attendance_percentage, r.remarks, r.published_at
     from public.report_cards r
     where r.school_id = $1
     $query$),
    ('roster_import_receipts', 'request_id', $query$
     select r.school_id, r.request_id, r.student_count, r.imported_by, r.imported_at
     from app_private.roster_import_receipts r
     where r.school_id = $1
     $query$),
    ('roster_placement_changes', 'request_id', $query$
     select r.school_id, r.request_id, r.student_id, r.source_enrollment_id, r.source_year_id, r.source_class_id, r.source_section_id, r.source_roll_no, r.source_stream_id, r.destination_enrollment_id, r.destination_year_id, r.destination_class_id, r.destination_section_id, r.change_kind, r.effective_date, r.reason, r.changed_by, r.changed_at
     from app_private.roster_placement_changes r
     where r.school_id = $1
     $query$),
    ('school_attendance_day_exceptions', 'revision', $query$
     select r.school_id, r.revision, r.day, r.mode, r.label, r.reason, r.actor_id, r.request_id, r.created_at
     from app_private.school_attendance_day_exceptions r
     where r.school_id = $1
     $query$),
    ('school_attendance_historical_days', 'day', $query$
     select r.school_id, r.day, r.academic_year_id, r.is_working, r.label, r.revision, r.actor_id, r.request_id, r.created_at
     from app_private.school_attendance_historical_days r
     where r.school_id = $1
     $query$),
    ('school_attendance_policy_versions', 'revision', $query$
     select r.school_id, r.revision, r.effective_from, r.working_days, r.correction_window_days, r.reason, r.actor_id, r.request_id, r.created_at
     from app_private.school_attendance_policy_versions r
     where r.school_id = $1
     $query$),
    ('school_documents', 'id', $query$
     select r.id, r.school_id, r.title, r.category, r.file_name, r.mime_type, r.file_size, r.description, r.status, r.uploaded_by, r.created_at, r.updated_at
     from public.school_documents r
     where r.school_id = $1
     $query$),
    ('school_events', 'id', $query$
     select r.id, r.school_id, r.title, r.description, r.event_type, r.start_at, r.end_at, r.all_day, r.audience, r.class_id, r.section_id, r.location, r.status, r.created_by, r.created_at, r.updated_at
     from public.school_events r
     where r.school_id = $1
     $query$),
    ('school_holidays', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.holiday_date, r.title, r.remarks, r.declared_by, r.created_at
     from public.school_holidays r
     where r.school_id = $1
     $query$),
    ('school_late_alert_policy_versions', 'version', $query$
     select r.school_id, r.version, r.enabled, r.reason, r.actor_id, r.request_id, r.created_at
     from app_private.school_late_alert_policy_versions r
     where r.school_id = $1
     $query$),
    ('school_notifications', 'id', $query$
     select r.id, r.school_id, r.title, r.message, r.notification_type, r.audience, r.class_id, r.section_id, r.status, r.scheduled_at, r.sent_at, r.created_by, r.created_at, r.updated_at
     from public.school_notifications r
     where r.school_id = $1
     $query$),
    ('school_settings_audit', 'id', $query$
     select r.id, r.school_id, r.revision, r.actor_id, r.request_id, r.before_details, r.after_details, r.changed_fields, r.reason, r.changed_at
     from app_private.school_settings_audit r
     where r.school_id = $1
     $query$),
    ('schools', 'id', $query$
     select r.id, r.name, r.code, r.affiliation_no, r.board, r.address, r.city, r.state, r.pincode, r.phone, r.email, r.website, r.primary_color, r.secondary_color, r.timezone, r.is_active, r.created_at, r.updated_at, r.settings_revision
     from public.schools r
     where r.id = $1
     $query$),
    ('sections', 'id', $query$
     select r.id, r.school_id, r.class_id, r.name, r.room, r.capacity
     from public.sections r
     where r.school_id = $1
     $query$),
    ('staff', 'id', $query$
     select r.id, r.school_id, r.profile_id, r.employee_id, r.designation, r.department, r.joining_date, r.created_at, r.full_name
     from public.staff r
     where r.school_id = $1
     $query$),
    ('staff_leave_requests', 'id', $query$
     select r.id, r.school_id, r.employee_id, r.requested_by, r.leave_type, r.from_date, r.to_date, r.reason, r.status, r.reviewed_by, r.reviewed_at, r.review_note, r.created_at, r.updated_at
     from public.staff_leave_requests r
     where r.school_id = $1
     $query$),
    ('streams', 'id', $query$
     select r.id, r.school_id, r.name
     from public.streams r
     where r.school_id = $1
     $query$),
    ('student_admission_audit', 'student_id', $query$
     select r.student_id, r.school_id, r.admitted_by, r.admitted_at
     from app_private.student_admission_audit r
     where r.school_id = $1
     $query$),
    ('student_detail_changes', 'id', $query$
     select r.id, r.school_id, r.student_id, r.changed_fields, r.changed_by, r.changed_at
     from app_private.student_detail_changes r
     where r.school_id = $1
     $query$),
    ('student_fees', 'id', $query$
     select r.id, r.school_id, r.student_id, r.fee_structure_id, r.billing_period, r.due_date, r.amount, r.discount, r.late_fee, r.status, r.created_at
     from public.student_fees r
     where r.school_id = $1
     $query$),
    ('student_leave_requests', 'id', $query$
     select r.id, r.school_id, r.student_id, r.enrollment_id, r.academic_year_id, r.class_id, r.section_id, r.student_name, r.admission_no, r.academic_year_name, r.class_name, r.section_name, r.start_date, r.end_date, r.reason, r.status, r.requester_id, r.requester_name, r.created_at, r.reviewed_by, r.reviewer_name, r.review_note, r.reviewed_at
     from app_private.student_leave_requests r
     where r.school_id = $1
     $query$),
    ('student_parents', 'student_id,parent_id', $query$
     select r.student_id, r.parent_id, r.relationship, r.is_primary
     from public.student_parents r
     join public.students s on s.id=r.student_id and s.school_id=$1 join public.parents p on p.id=r.parent_id and p.school_id=$1
     where $1 is not null
     $query$),
    ('students', 'id', $query$
     select r.id, r.school_id, r.profile_id, r.admission_no, r.roll_no, r.first_name, r.middle_name, r.last_name, r.dob, r.gender, r.blood_group, r.admission_date, r.address, r.city, r.state, r.pincode, r.registered_mobile, r.status, r.created_at, r.updated_at
     from public.students r
     where r.school_id = $1
     $query$),
    ('study_materials', 'id', $query$
     select r.id, r.school_id, r.class_id, r.section_id, r.subject_id, r.teacher_id, r.title, r.description, r.published_at, r.created_at
     from public.study_materials r
     where r.school_id = $1
     $query$),
    ('subjects', 'id', $query$
     select r.id, r.school_id, r.code, r.name, r.description, r.is_practical, r.is_active
     from public.subjects r
     where r.school_id = $1
     $query$),
    ('substitute_attendance_coverages', 'id', $query$
     select r.id, r.school_id, r.source_assignment_id, r.source_teacher_id, r.substitute_teacher_id, r.academic_year_id, r.class_id, r.section_id, r.subject_id, r.starts_on, r.ends_on, r.reason, r.created_by, r.created_at, r.revoked_at, r.revoked_by, r.revoke_reason
     from app_private.substitute_attendance_coverages r
     where r.school_id = $1
     $query$),
    ('teacher_assessment_marks', 'id', $query$
     select r.id, r.assessment_id, r.student_id, r.marks_obtained, r.remarks, r.updated_by, r.marks_entered_by, r.created_at, r.updated_at
     from public.teacher_assessment_marks r
     join public.teacher_assessments a on a.id=r.assessment_id and a.school_id=$1 join public.students s on s.id=r.student_id and s.school_id=$1
     where $1 is not null
     $query$),
    ('teacher_assessments', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.class_id, r.section_id, r.subject_id, r.teacher_id, r.name, r.assessment_date, r.maximum_marks, r.description, r.status, r.created_at, r.updated_at
     from public.teacher_assessments r
     where r.school_id = $1
     $query$),
    ('teacher_attendance', 'id', $query$
     select r.id, r.school_id, r.teacher_id, r.attendance_date, r.status, r.remarks, r.marked_by
     from public.teacher_attendance r
     where r.school_id = $1
     $query$),
    ('teacher_subject_assignments', 'id', $query$
     select r.id, r.teacher_id, r.academic_year_id, r.class_id, r.section_id, r.subject_id, r.is_class_teacher
     from public.teacher_subject_assignments r
     join public.teachers t on t.id=r.teacher_id and t.school_id=$1 join public.academic_years y on y.id=r.academic_year_id and y.school_id=$1
     where $1 is not null
     $query$),
    ('teachers', 'id', $query$
     select r.id, r.school_id, r.profile_id, r.employee_id, r.designation, r.department, r.joining_date, r.qualification, r.registered_mobile, r.created_at, r.full_name
     from public.teachers r
     where r.school_id = $1
     $query$),
    ('timetable_entries', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.class_id, r.section_id, r.subject_id, r.teacher_id, r.day_of_week, r.period_number, r.start_time, r.end_time, r.room, r.notes, r.created_by, r.created_at, r.updated_at
     from public.timetable_entries r
     where r.school_id = $1
     $query$),
    ('timetables', 'id', $query$
     select r.id, r.school_id, r.academic_year_id, r.class_id, r.section_id, r.day_of_week, r.period_no, r.subject_id, r.teacher_id, r.room, r.start_time, r.end_time, r.assignment_id, r.version, r.deleted_at, r.deleted_by
     from public.timetables r
     where r.school_id = $1
     $query$),
    ('transport_allocations', 'id', $query$
     select r.id, r.school_id, r.student_id, r.route_id, r.stop_name, r.monthly_fee, r.status, r.created_at, r.updated_at
     from public.transport_allocations r
     where r.school_id = $1
     $query$),
    ('transport_assignments', 'id', $query$
     select r.id, r.route_id, r.student_id, r.pickup_stop, r.drop_stop, r.start_date, r.end_date
     from public.transport_assignments r
     join public.transport_routes t on t.id=r.route_id and t.school_id=$1 join public.students s on s.id=r.student_id and s.school_id=$1
     where $1 is not null
     $query$),
    ('transport_routes', 'id', $query$
     select r.id, r.school_id, r.name, r.vehicle_no, r.driver_name, r.driver_phone, r.route_details
     from public.transport_routes r
     where r.school_id = $1
     $query$),
    ('transport_vehicles', 'id', $query$
     select r.id, r.school_id, r.vehicle_number, r.vehicle_type, r.capacity, r.driver_name, r.driver_mobile, r.status, r.created_at, r.updated_at
     from public.transport_vehicles r
     where r.school_id = $1
     $query$),
    ('unavailable_files', 'source,source_id', $query$
     select source, source_id, bucket, 'unsupported_or_outside_school' as reason
     from app_private.school_export_file_refs($1) where path is null
     $query$),
    ('user_roles', 'id', $query$
     select r.id, r.user_id, r.school_id, r.role, r.created_at
     from public.user_roles r
     where r.school_id = $1
     $query$)

$catalogue$;

revoke all on function app_private.school_export_catalogue() from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
