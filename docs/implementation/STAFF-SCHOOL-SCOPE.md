# Staff school scope

2 November 2026. Locally tested and reviewed; manual application is pending. This note records frontend compatibility requirements; it does not report a deployed policy change. The first role-assignment hotfix is separately user-reported applied with 15 passing catalog checks. Other policy evidence below comes from `supabase/schema-snapshots/2026-11-02/schema-metadata.json`.

## Bounded policy slice

Replace the school-unaware grants in all 14 policies using `app_private.is_school_admin()` and all seven using `app_private.is_finance()`. Also scope the teacher branch of the touched `notices_staff_all` policy. Preserve unrelated policies and helpers, including profile/tenant policies, teacher assignment reads, class-teacher attendance and family reads.

One additional replacement is required for runtime compatibility: `enrollments.admin_enrollments_all` currently queries `students`, whose teacher-read policy queries `enrollments` again. PostgreSQL raises `42P17` even when another permissive policy would authorize access. Replace that one back edge with the private student-school resolver and the existing `school_admin` role set; its generic helper retains global super-admin access. Total: **22 policy replacements across 17 tables**, consisting of 21 global grants and one recursion repair. An allowlist checks all 79 existing policy names on those tables; unchanged policies' predicate drift remains outside that check.

The existing office helper includes `super_admin`, `school_admin`, `principal`, `accountant` and `reception_staff`. Its name does not mean school administrators alone. The finance helper includes `accountant`. See snapshot routine definitions at lines 2354 and 2370.

Office-policy tables: `attendance`, `class_activities`, `class_logs`, `enrollments`, `fee_payments`, `fee_structures`, `notices`, `parents`, `student_fees`, `student_parents`, `students`, `study_materials`, `teacher_subject_assignments` and `timetables`.

Finance policies: SELECT on `academic_years`, `classes`, `sections` and `students`; ALL on `fee_structures`, `student_fees` and `fee_payments`.

## Candidate same-school permission matrix

This matrix describes grants supplied by the touched policies. Other existing policies can grant additional access.

| Caller role | Office policies | Extra finance policies | Teacher notice branch |
|---|---|---|---|
| `super_admin` | Preserve existing global access | Office grants already cover fee tables | Office grant applies |
| `school_admin` | ALL for that role's school | No additional accountant grant | Office grant applies |
| `principal` | ALL for that role's school | No additional accountant grant | Office grant applies |
| `accountant` | ALL for that role's school | Same-school reference SELECT and fee-table ALL | Office grant applies |
| `reception_staff` | ALL for that role's school | No additional accountant grant | Office grant applies |
| `teacher` | No office grant | No finance grant | Own notices, with a teacher role in the notice's school |
| `student`, `parent` | No office grant | No finance grant | No teacher grant; existing family/audience policies remain |

Role and school must match the **same `user_roles` row**. Combining a global staff boolean with `current_user_school_ids()` is insufficient: an accountant at A with a student role at B must not receive accountant access at B. Preserve the explicit existing global-super-admin behavior, including NULL-school global grants. Apply equivalent school checks to both row visibility and new/updated row checks.

This slice preserves existing broad office permissions inside a school, including accountant/reception writes on office-policy tables. That is a compatibility boundary, not a settled least-privilege product policy.

## Frontend contracts to preserve

- Database role labels are the eight values above. `finance` and `reception` are frontend aliases; `super_admin` and `school_admin` both map to UI `admin`. `lib/auth/roles.ts:3` and `:14` define mapping and precedence. `lib/modules.ts:48` defines navigation, not database authorization.
- `components/dashboard/role-dashboard.tsx:254` routes accountants to `FinanceDashboard` and principals to `AdminDashboard`. Finance reads students/current year/fee structures at `:864`, then writes `fee_structures` at `:878`, `student_fees` at `:905` and `fee_payments` at `:926`. A school-admin-only replacement breaks accountant collection and principal reports.
- `components/admin/admin-finance-workspace.tsx:109` reads fee records, payments, structures and the current year, then resolves student names at `:134`. Fee access without student/reference reads is insufficient.
- `lib/attendance/repository.ts:103` and `:124` need assignment-visible enrollments and student records. Attendance INSERT/UPDATE returns selected rows (`:241` and `:252`), so legitimate writers also need SELECT visibility. Preserve class-teacher and student/parent policy branches; narrowing office grants must not replace them.
- Class-teacher registration uses the existing `register_student_for_class_teacher` RPC at `components/academic/teacher-attendance-register.tsx:75`. Its separate SECURITY DEFINER contract is outside this slice. This note does not validate that RPC's assignment or tenant integrity.

## Limits and follow-up work

1. **Indirect scope and reference coherence.** `enrollments` and `student_parents` have no `school_id`. Derive enrollment scope through its student; parent links need both student and parent scope. Other affected rows have direct school IDs, but their foreign keys are single-column. Checking a payment's school alone does not establish that its student, fee record and fee structure belong together. Enrollment year/class/section and attendance student/year/section need equivalent coherence checks. These broader integrity repairs remain pending.
2. **Teacher fee screen already lacks database access.** `components/teacher/teacher-views.tsx:1008` and `:1016` query assigned pupils' fees/payments. The snapshot has no teacher SELECT policy for those fee tables. Keep this recorded as an existing gap; this slice must not grant every teacher school-wide financial access to make the screen appear functional.
3. **School selection and dashboard filtering remain incomplete.** `app/(dashboard)/dashboard/page.tsx:36` chooses one matching role row; there is no explicit active-school selector. The finance student lookup at `role-dashboard.tsx:864` lacks a school predicate and ignores query errors. Correct RLS can return students from multiple legitimately held schools, while fees are written using one selected school. Stale family/dashboard responses and mixed-school selections need a separate frontend repair.
4. **Profile policies are unchanged.** `profiles.school_id` is nullable. Own-profile school lookups occur at `app/(dashboard)/modules/academic/page.tsx:82` and admin super-admin fallbacks such as `components/admin/admin-finance-workspace.tsx:98`. The snapshot has an own UPDATE policy but no explicit own SELECT policy. Do not use a writable profile school as authorization authority or silently redesign profile reads in this slice.
5. **Other permissive grants remain.** Profile, teacher and academic-master tenant policies, teacher self-assignment, audience rules, activation, storage and monetary posting integrity are separate work. In particular, `tenant_isolation_academic_years`, `tenant_isolation_classes` and `tenant_isolation_sections` still grant ALL to any member of the row's school. An accountant at A who is a student at B therefore still has B master-table access through those existing policies. Passing this slice's tests cannot certify complete tenant isolation or safe real-school onboarding.

Candidate acceptance checks: same-school office/finance flows succeed; cross-school access fails; accountant-at-A plus student-at-B does not confer office access at B; global super-admin access survives; teacher-owned notices stay school-scoped; assignment-based attendance and student/parent reads retain their existing behavior. Verify both SELECT and write checks in PostgreSQL before preparing manual execution instructions.
