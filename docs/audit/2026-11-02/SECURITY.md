# SMS-web security and data audit

Scope: local source audit of the supplied web checkout, 2026-11-02. No `.env.local` values were read, no production requests or mutations, no application code changes. SQL findings describe supplied migrations, not verified production policies. There is no base schema, Supabase config, activation RPC definition, complete RLS export, or generated Database type in this source package.

## Findings

### P1 — Teachers grant their own operational scope

- Evidence: `supabase/migrations/20261101_teacher_assessments_and_profile.sql:355-376` allows INSERT/UPDATE to teacher_subject_assignments when teacher_id belongs to the caller. It does not constrain class/year/section/subject or is_class_teacher to an approved assignment or school. `components/academic/teacher-assignments.tsx:48-62,82-88` intentionally implements self-service with no admin approval and a class-teacher checkbox. Attendance trusts the resulting class-teacher row at `app/(dashboard)/modules/[module]/page.tsx:579-597`.
- Repro concept: teacher A creates a subject/class-teacher assignment for another class in the same school; the application now treats that class as their responsibility. Assessment authorization subsequently relies on the same teacher-writable assignments (`20261101...sql:99-119,254-288`), allowing that teacher to create assessments and enter marks for that class's enrolled students.
- Important limit: assessment helper checks own teacher identity and same school, so this does not grant access to another teacher's existing assessment or directly grant cross-school assessment access. Unknown base attendance RLS/constraints may limit downstream actions. This is a trust-boundary design issue even if self-service was intentional.
- Fix: school administrator approves role-bearing assignments; teacher edits only requested preferences/non-authoritative details. Enforce tenant and class/section/year/subject coherence in DB and role checks in policy/RPC. Test two teachers and two schools directly through PostgREST.

### P1 — Fee collection is non-atomic and creates a charge on every collection

- Evidence: `components/dashboard/role-dashboard.tsx:972-1018` INSERTs a new student_fees row, marks it paid/partial from the current amount, then INSERTs fee_payments separately. Payment failure has no rollback. Receipt number comes from a client timestamp at line 1003. There is no stable request/idempotency key or existing invoice allocation.
- Repro: full payment where invoice insert succeeds and payment insert fails leaves a fee marked paid without a recorded payment. Retrying creates another charge unless an unknown base uniqueness constraint rejects it. Two deposits against one month's fee each create a fresh full amount instead of reducing the original balance. Browser/network retries and simultaneous cashier tabs are unsafe.
- Payment amount is client-controlled, converted using Number, with no finite/positive guard in collectPayment. Unknown DB checks may reject invalid amounts; these checks are not supplied.
- Fix: immutable fee invoice/lines, ledger payment/allocation/reversal entries; one transactional RPC/server operation with tenant/role authorization, decimal-safe amount validation, DB-issued unique receipt, idempotency key and locking. Status derives from ledger, not user input. Reconcile cash and gateway settlements.

### P1 — Saving a class log can delete activities irreversibly

- Evidence: `lib/academic.ts:166-190`: upsert class_logs, delete all its activities, insert replacement activities as three separate HTTP/DB requests.
- Repro: fail the third request after successful deletion (offline tab, policy rejection, invalid activity); old homework/classwork is gone, while UI reports save failure. Concurrent editors can interleave delete/reinsert. Saved log status can become published before activities are replaced.
- Fix: atomic RPC using version check/locking; publish only complete snapshot; preserve activity identity/history or soft deletion.

### P1 / verification gate — Source package cannot reproduce or prove tenant/family isolation

- Evidence: only two incremental migrations exist. Both presume teachers/classes/etc. The first migration adds policies but never enables RLS on those preexisting tables. It explicitly preserves unknown existing policies at `20261030...sql:32-34,109-111`. No definitions exist for activate_teacher, activate_student, activate_parent (`app/(dashboard)/activate/page.tsx:25-33`) or register_student_for_class_teacher (`app/(dashboard)/modules/[module]/page.tsx:726-731`). `types/database.ts:1-3` contains three unions, not generated schema types. Supabase factories are untyped (`lib/supabase/client.ts:2`, `server.ts:3`).
- Impact: fresh school deployment, migration safety, family privacy, admin escalation prevention, activation locking/OTP/rate limits, fee constraints and backups cannot be verified from this repository. Do not assert RLS is absent live or that a data breach is confirmed.
- Migration mismatch: `20261030...sql:40-73` uses teachers.user_id; newer SQL and application use teachers.profile_id (`20261101...sql:106,351`, `lib/academic.ts:77`). On a base schema with profile_id only, applying the older migration fails before the correcting migration.
- Required evidence: versioned baseline and seed, all RLS/storage policies, RPCs/triggers/grants, tenant FK constraints, activation verification/rate limits, migration history, backup/restore drill and cross-tenant/family tests. No database secrets are needed in an audit artifact.

### P2 — Class log RLS checks ownership, not scope

- Evidence: `20261101...sql:387-408` accepts class_logs insert/update based only on own teacher_id. It never verifies school_id, academic_year_id, class_id, section_id, subject_id or approved assignment. Activity checks only owner of parent log (`:419-451`).
- Repro under supplied policy alone: direct request with own teacher_id and unrelated class/school/year UUIDs passes the new permissive policy. A separate restrictive policy, composite FK or trigger might reject it; base schema is unavailable.
- Fix: check complete tenant and authorized assignment scope in DB, published-state edit rules, and trusted actor/timestamp generation.

### P2 — Open redirect on the auth callback

- Evidence: `app/(auth)/auth/callback/route.ts:2` accepts next and passes it directly to `new URL(next,url.origin)`. It redirects even with no code and ignores exchangeCodeForSession errors.
- Safe local probe: Node's URL constructor resolves both `https://attacker.example/path` and `//attacker.example/path` to attacker origin. `/auth/callback?next=https%3A%2F%2Fattacker.example` redirects off-site without authentication.
- Impact: trusted school-domain phishing/open redirect. No token/session exfiltration was demonstrated.
- Fix: allowlist internal pathname destinations, require same origin, handle missing/failed code explicitly.

### P2 — Global class-teacher uniqueness breaks academic-year rollover

- Evidence: `20261030...sql:24-30` unique partial indexes use teacher_id and section_id alone, omitting academic_year_id.
- Repro: retain an old class-teacher assignment and create next year's class-teacher assignment for the same teacher/section: unique violation. Reusing rows instead destroys assignment history.
- Fix: uniqueness scoped to academic year (and explicit school/class/section model) with clean-data preflight and rollover transaction.

### P2 — Assessment scope immutability is only a browser rule

- Evidence: browser checks existing marks before changing class/year/section/subject (`components/teacher/teacher-views.tsx:382-399`), but SQL UPDATE policy allows changing any of these to another own assignment (`20261101...sql:264-278`). The only assessment validation trigger watches maximum_marks (`:56-78`); enrollment validation runs on mark insert/update only (`:208-239`).
- Repro: after entering marks for class A, direct UPDATE assessment to owned class B; old class A marks stay attached although those students are not enrolled in B.
- Fix: DB trigger/transaction rejects scope change once marks exist, or performs an explicit audited replacement workflow. Lock assessment while updating marks or scope.

### P2 — Marks maximum validation has an unprotected concurrency window

- Evidence: max update checks existing marks (`20261101...sql:63-70`); mark insert/update reads max with ordinary SELECT (`:217-225`), with no row lock common to both operations.
- Inferred schedule: both transactions see max=100/no new mark; one lowers max to 50 and other inserts mark=80; each validation can pass before commit. Requires a two-session DB regression test, not run because no local DB/base schema is provided.
- Fix: serialize both operations by locking assessment row consistently or use equivalent safe transaction design.

### P2 — Browser-local admin records are shared and not durable

- Evidence: core modules are routed to AdminDemoWorkspace at `app/(dashboard)/modules/[module]/page.tsx:211-216`. `lib/admin/admin-demo-service.ts:160-187` stores per-module values under a single origin-wide prefix, no school/user key. `components/layout/app-shell.tsx:32-38` signs out without clearing them. Audit logs are two static seed records at `admin-demo-service.ts:151-153`.
- Impact if real data is entered: same-browser accounts/schools can see one another's local records; no shared operational source, durable backup, reliable audit trail, or migration linkage. This is deliberately demo storage, not a proven leak of existing real pupils.
- Fix: make demo environment obvious and synthetic-only; move production people/admission/settings flows into tenant-scoped DB transactions and append-only audit events. Local caching must have tenant/user scope and logout handling.

### P2 — Finance totals may silently truncate

- Evidence: `components/admin/admin-finance-workspace.tsx:108-113` reads entire student_fees and fee_payments without pagination; totals are calculated in-browser at `:174-194`.
- Impact: if rows exceed configured Supabase max rows (configuration absent), totals and outstanding balances silently undercount. Cannot claim exact deployed threshold.
- Fix: school/year/time-scoped aggregate queries/RPC plus paginated records and displayed date ranges.

## Readiness distinctions

- Real Supabase Auth: password and Google sign-in use provider APIs (`app/(auth)/login/page.tsx:33-58`); server dashboard verifies user and role (`app/(dashboard)/dashboard/page.tsx:8-41`). This is not merely a fake login screen.
- Real backend paths exist for teacher academic logs, attendance, assessments/marks, notices, profile phone, student/parent reads, finance/accountant fee writes. Their actual live schema/RLS/configuration was not inspected.
- Admin fees/invoices screen has read/structure creation plus a clearly named payment preview which saves nothing (`components/admin/admin-finance-workspace.tsx:212-220,267-283`). Downloaded invoice/receipt previews are JSON (`:223-264`). It differs from real FinanceDashboard collection path.
- Client role gating (`app/(dashboard)/modules/[module]/page.tsx:109-164`) improves navigation but is not API security. Proxy refreshes auth claims and does not deny access (`proxy.ts:2`); layout has no guard (`app/(dashboard)/layout.tsx:1`). This alone is not an authentication bypass because Supabase RLS should enforce data access.
- `/modules/academic` authenticates but never checks admin role before showing subject creation (`app/(dashboard)/modules/academic/page.tsx:73-95,173-189`). Whether non-admin writes succeed depends on unavailable subjects RLS. Centralize server-side role/tenant route checks and DB permission rules.
- Student/parent screens derive linked records and filter academic work by published status and enrollment (`role-dashboard.tsx:1111-1141,1258-1301`). Parent child membership client check at line 1277 is good UI behavior, but must be duplicated by DB family RLS. Existing base policies cannot be proved.
- New assessment tables enable RLS, unique assessment/student marks, range/enrollment checks, secure-definer functions with fixed empty search path, revoked PUBLIC helper functions and explicit authenticated execute grants. These are useful foundations. They do not replace baseline policy verification.
- New assessment select policies only allow school admins and assigned owner teacher; there is no student/parent/principal view policy in these migrations (`20261101...sql:244-252,296-299`). These role portals need deliberately scoped published-result policies/workflows; do not assume adding links makes reports available.

## Paid-school gates

1. Baseline schema and deterministic migration from empty DB; two schools + two families adversarial RLS tests, storage isolation and account deactivation tests.
2. Invitations/activation with verified ownership, one-time expiry tokens/OTP, rate limits and staff revocation. Current form uses identifiers/mobile/DOB; unavailable RPCs decide actual protection.
3. Transactional invoice/ledger/payment/reversal/refund workflows, unique receipt/idempotency, rounding rules and reconciled reports. No raw browser-authenticated arbitrary payment state edits.
4. Durable school-scoped people/enrollment/guardian/admission masters and academic-year rollover with history preservation.
5. Append-only actor/tenant/entity/time audit with privileged access review; tested off-device backups and restoration, service logs/alerts and retention/export/deletion workflows.
6. Explicit role-school context selection: current role resolver collapses super_admin and school_admin to admin (`lib/auth/roles.ts:4`) and chooses a single priority role; school record selection differs among screens. Define platform operator vs school roles and branch access before multiple schools.
