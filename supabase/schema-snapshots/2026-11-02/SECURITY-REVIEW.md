# Authorization review of the supplied metadata snapshot

Reviewed local `schema-metadata.json` only. No database queries, API requests, exploit attempts, migrations or application changes were performed. Findings describe the permissions and definitions recorded in this snapshot; they are not proof of current deployment state or a demonstrated production incident. JSON array indexes below are zero-based.

The file records PostgreSQL 17.11, 69 tables, 3 views, 178 policies, 34 routines and 24 custom triggers. All 69 exported tables have RLS enabled. All 178 exported policies are **permissive**. All 3 exported views have `security_invoker=true`. These are useful controls, but permissive policies combine with OR: a narrower policy does not constrain a broader one.

**Priority: close role escalation and school-boundary defects before fee feature work or real school data.** P1 means a release blocker. P2 means a material correctness or lifecycle issue. Neither severity implies that an exploit was run.

## S01 — P1 critical: role writes permit self-escalation and cross-school grants

- Evidence: `$.relations[71]` is `public.user_roles`. Its ACL explicitly grants `authenticated` INSERT/UPDATE/DELETE, and its `role` column uses `app_role`. `$.enums[2].labels` includes `super_admin` and `school_admin`.
- `$.policies[172]`, **tenant_isolation_user_roles**, is `FOR ALL TO public`, with both predicates checking only `school_id IN (SELECT current_user_school_ids())`. `$.routines[17]`, **public.current_user_school_ids()**, returns school IDs from any role belonging to `auth.uid()`; it is callable by `authenticated` and runs as its owner.
- The only other user_roles policies, `$.policies[171]` and `[173]`, are SELECT policies. No restrictive policy or custom user_roles trigger is present. The table constraints are primary key, user/school foreign keys and uniqueness on `(user_id, school_id, role)`; none limits who may grant a particular role.
- Consequence of this declared contract: a signed-in account with any existing role at school A can insert a new row granting itself `super_admin` at A. The enum/FKs/unique constraint do not reject a distinct valid role. **public.is_school_admin_for_school()** and **public.teacher_assessment_is_school_admin()** treat that role as global authority. The same broad policy also permits altering/deleting other members' role rows in the member's school.
- Repair direction: remove ordinary direct role-table mutations; authorize assignment/removal through one school-scoped privileged operation, explicitly constrain assignable roles and platform privileges, and verify denial with student/parent/teacher callers in a synthetic two-school test. A hidden role-management UI is insufficient.

- Evidence: `$.routines[12]`, **public.assign_school_role(p_user_id, p_school_id, p_role)**, is SECURITY DEFINER and executable by `authenticated`.
- It checks **current_user_has_any_role(super_admin, school_admin)**, whose definition (`$.routines[14]`) checks roles anywhere, then blocks assigning `super_admin` unless the caller is already super_admin. It never verifies the caller administers `p_school_id`.
- Consequence: even after S01's direct-table policy is repaired, a school admin at A can use this function to assign `school_admin` or another allowed role at B, including to itself, when supplied valid existing identifiers. The function's owner can bypass the role-table RLS. Current-school role membership must be checked inside this RPC.

## S02 — P1: broad staff and tenant policies defeat least privilege

- Evidence: `$.routines[5]`, **app_private.is_school_admin()**, takes no school argument. It returns true for a caller with any `super_admin`, `school_admin`, `principal`, `accountant` or `reception_staff` role anywhere.
- Fourteen permissive `FOR ALL` policies use it, including **attendance_staff_all** (`$.policies[12]`), **class_logs_staff_all** (`[27]`), **fee_payments_admin_all** (`[49]`), **student_fees_admin_all** (`[117]`), **enrollments_staff_all** (`[41]`), **students_staff_all** (`[126]`), **parents_admin_all** (`[82]`), **student_parents_staff_all** (`[122]`) and **teacher_assignments_staff_all** (`[149]`).
- **app_private.is_finance()** (`$.routines[4]`) is also global. Additional fee-payment/student-fee ALL policies use it (`$.policies[50]`, `[118]`).
- Consequence: the recorded contract grants principal/accountant/reception and school-admin roles broad operations across schools and domains. Coexisting newer `is_school_admin_for_school(school_id)` policies do not restrict these policies, because all are permissive. Replace broad legacy policies and helpers deliberately; adding another scoped permissive policy will not fix the bypass.

- **tenant_isolation_profiles** (`$.policies[89]`), **tenant_isolation_teachers** (`[159]`) and **tenant_isolation_audit_logs** (`[16]`) grant ALL operations for any school in the caller's role memberships. The corresponding relations grant authenticated table mutations.
- This lets a school member modify another same-school profile/teacher record; teacher profile linkage and registered activation details are not protected by column ACLs or a validation trigger. Audit rows can be changed/deleted, so the audit table is not append-only evidence.
- **profiles_update_own** (`$.policies[88]`) permits updating the caller's whole profile row, including `is_active`; none of the reviewed role helpers enforces that field. Treating that editable field alone as account revocation would be ineffective. Supabase Auth-level blocking/session behavior is outside this snapshot.
- Scope permissions by action and domain. Restrict identity linkage, activation factors, role state and audit entries separately from ordinary profile edits.

## S03 — P1: teacher self-assignment and incomplete write scope remain unmitigated

- **teacher_assignments_teacher_own_insert/update** (`$.policies[151]`, `[153]`) and **teachers_manage_own_assignments_insert/update** (`[155]`, `[157]`) permit own `teacher_id` without school/class/year/subject approval. `$.relations[63]` has separate foreign keys, not tenant-coherent composite constraints; no assignment-validation trigger is exported.
- **attendance_class_teacher_manage** (`$.policies[10]`) does enforce an active enrollment joined to the caller's class-teacher assignment. This is a positive backend control missing from the earlier source-only evidence. It still trusts the caller-writable assignments and does not compare `attendance.school_id` or `attendance.section_id` with that enrollment's school/section. No attendance validation trigger is exported.
- **class_logs_teacher_own** (`$.policies[29]`) checks an assignment, but broader own-teacher INSERT/UPDATE policies (`[31]`, `[32]`) bypass that check. `$.relations[7]` has individual FKs and a status check only; its sole custom trigger updates a timestamp.
- Result: earlier conditional concerns about self-granting scope and class-log tenant coherence are supported by the supplied definitions. Membership in a teacher profile must not authorize self-approving new class/class-teacher scope. Enforce complete school/year/class/section/subject/student coherence at the database boundary.
- Revoking only a teacher role does not remove every own-profile policy: the broader assignment/class-log policies test profile linkage without requiring an active teacher role. Include revocation behavior in the repair tests.

## S04 — P1: activation uses reusable personal details and does not bind the person record

- Evidence: **public.activate_parent/student/teacher** (`$.routines[9]`, `[10]`, `[11]`) authenticate the caller, match identifiers/mobile (plus DOB for students), update `profiles.school_id`, insert `user_roles`, and return the matched person ID.
- They do **not** set `parents.profile_id`, `students.profile_id` or `teachers.profile_id` to the caller, even though the current-person helpers (`$.routines[0]`, `[2]`, `[3]`) and application screens depend on those links. A newly created, unlinked account can receive a role while still failing the person-profile lookup. They also do not reject an already-linked person record or consume an expiring one-time invitation.
- Mobile comparisons strip all nondigits and coalesce a missing stored phone to an empty string. For a record with no registered phone, a blank/non-digit supplied phone normalizes to the same value. Whether any such records exist is unknown; no rows were inspected.
- **public.activate_accountant** (`$.routines[8]`) similarly grants a global accountant role from employee ID, a profile phone match and a finance-like department string. S02 makes this especially sensitive. No possession verification, one-time claim or attempt tracking is present in these function bodies; external provider/network controls were not exported.
- Replace this with atomic, verified, expiring invitation/claim binding and a scoped role grant. Do not infer account ownership from knowing a mobile number, employee/admission code or DOB.

## S05 — P1: money integrity is not repaired by the recovered schema

- `$.relations[17]`, **fee_payments**, enforces school/receipt uniqueness and individual FKs. `$.relations[54]`, **student_fees**, has individual FKs but no unique billing-demand key. Neither table has a positive/nonnegative amount check, tenant-coherent invoice/student FK, stable idempotency key or custom posting/reconciliation trigger in this snapshot.
- Numeric columns use `numeric(12,2)`, which is useful decimal storage but does not make the browser's separate invoice/payment requests atomic. Caller-supplied status remains independently writable. S02 additionally grants overly broad CRUD.
- **student_fee_summary** (`$.relations[53]`) aggregates assessed fee rows and treats rows marked paid as paid assessed amounts; it does not reconcile actual payment allocations.
- Earlier source finding F02 remains a release blocker: each collection creates a new full demand before a separate payment insert. School/receipt uniqueness prevents duplicate receipt numbers, not duplicate business operations using fresh numbers.

## S06 — P2: registration and year rollover have unresolved lifecycle boundaries

- `$.relations[63].indexes` contains year-scoped indexes **uq_one_class_teacher_per_class_section_year** and **uq_one_class_teacher_per_teacher_year**, **and** older **section_one_class_teacher_idx** and **teacher_one_class_teacher_idx**.
- The older indexes still enforce uniqueness by section or teacher across all years. Keeping historical assignments and inserting next year's class-teacher assignment still conflicts. Adding correct indexes without removing/replacing incompatible older ones does not resolve the issue.

- **public.register_student_for_class_teacher** (`$.routines[22]`) is an authenticated, teacher-checked SECURITY DEFINER function. It finds a current-year class-teacher assignment, takes a school-level advisory transaction lock, and creates student plus enrollment within one function transaction. These are genuine positive controls.
- It trusts the self-writable assignment and does not verify class/section ownership against the teacher's school. It accepts no idempotency key, so a replay after an uncertain response can create another pupil rather than return the prior result. UI duplicate-click protection is not a server replay guarantee.
- Its generated admission number uses `lpad(v_next_admission::text, 3, '0')`. PostgreSQL truncates a longer input to that width, so the next value after 999 becomes `KC-ST-100`, which collides with an existing 100 when the normal sequence is present. `$.relations[57]` enforces uniqueness on `(school_id, admission_no)`. This boundary should be corrected and tested before target schools exceed the three-digit range. No boundary query was executed here.

## What changed from the source-only audit

| Earlier uncertainty | Evidence now available | Remaining limit |
|---|---|---|
| Whether core table RLS exists | Enabled on all 69 exported tables; 3 views use invoker security | Policy semantics contain critical bypasses; no live caller tests |
| Whether attendance has class-teacher checks | Active-enrollment/class-teacher policy exists | Self-assignment, global staff policies and row-scope gaps remain |
| Whether class-log scope has a stronger base policy | An assignment-checking base policy exists | Broader permissive ownership policies bypass it |
| Whether fee schema mitigates unsafe browser posting | Decimal columns and receipt uniqueness exist | No atomic ledger/posting/idempotency invariant was recovered |
| Whether registration RPC exists/is atomic | Function and per-school advisory transaction lock are present | Replay, assignment coherence, number-width and complete onboarding gaps remain |
| Whether student/guardian academic policies restrict publication | **class_logs_student_read/parent_read** (`$.policies[28]`, `[26]`) require published work and matching linked enrollment; own attendance/fee read policies exist | Activation linking and privilege escalation defeat the intended model; no live family tests |
| Whether old `teachers.user_id` migration matches schema | Exported teachers has `profile_id` and no `user_id` (`$.relations[64].columns`) | Old migration remains unreproducible against this shape without correction |

Metadata is stronger evidence than guessing from missing migrations. It still does not establish what real users can currently do through every API, whether identities/roles exist, whether Data API schema exposure is configured, or whether operational logs/backup/restore controls work. Next validation should reconstruct a synthetic local database and exercise two schools, multiple roles and two families before any remote policy change.
