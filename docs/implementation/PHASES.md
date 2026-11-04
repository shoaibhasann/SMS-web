# Implementation phases

Updated 4 November 2026. Implement each operational flow, verify its permissions and failure cases, then advance.

The [founder-aligned PRD](../product/PRD.md) defines commercial scope and sign-off. This log tracks the implementation and verification of individual flows.

## Phase 1: repair existing code — in progress

### First tested slice: teacher attendance and auth callback

Implemented:

- Replaced two blanket-upsert attendance editors with one shared editor/data adapter. Removed the duplicate register implementation from the dynamic route.
- Load saved statuses for selected school/year/section/date; preserve absence, leave, half-day and holiday. Missing attendance is explicitly Unmarked.
- Bulk Present marks only missing statuses. Holiday is a reviewed draft action, and an existing holiday can be corrected.
- Save only changed students. Conditional UPDATE matches loaded status/remarks and attendance scope; new records use INSERT. Conflicts fail visibly.
- Paginate roster/saved rows, check current enrollment/school access, bound concurrency and report partial success accurately. Failed edits remain pending.
- Lock date/class changes and registration while edits/writes are pending; ignore stale responses; guard duplicate submission; preserve historical date through roster refresh.
- Dashboard attendance requires a verified current year and class-teacher section. Other attendance roles now reach dashboard guidance rather than a teacher mutation register; detailed readers remain pending.
- Auth callback follows safe internal redirects only after successful session exchange. Failed/missing exchanges return to login; recovery destinations are retained.
- Repaired dependencies, added Vitest/React tests and a functioning ESLint CLI. Correctness rules remain enabled.
- Created local Git baseline `5aa5daa9dea0f8399f4634e7fa3d9d12276673aa` from the original audit snapshot. All 50 committed hashes matched the manifest. No remote/push.

Verification:

| Layer | Result |
|---|---|
| Auth redirect/route tests | 38 passing |
| Attendance repository tests | 37 passing |
| Attendance editor behavior tests | 15 passing |
| Register-parent wiring tests | 9 passing |
| Total | 99 passing |
| TypeScript | Passing |
| Production build | Passing with default Turbopack in the unrestricted environment |
| New auth/attendance/test files lint | Passing |
| Whole-project lint | Still fails: 22 legacy errors and 82 warnings at this checkpoint |
| Browser flow | Actual shared editor with labeled synthetic/in-memory data: Absent and Holiday survived bulk marking, changed-only save and reload |
| Live Supabase authorization/persistence | Not tested; no complete schema, CLI link/credentials or existing dashboard session available. Read-only REST schema metadata returned 401 (secret API key required); no table rows were requested. |

Repository tests use a fluent PostgREST fake that applies query filters and uniqueness. Editor tests use a stateful repository fake; register tests mock setup reads and the editor boundary. These are reproducible local checks, not proof of deployed RLS.

Limits:

- Saves are per pupil, not an all-class transaction; partial results are intentional and visible.
- Status/remarks comparison is not a monotonic version or append-only correction history.
- Roster preflight cannot replace transactional database permission/enrollment checks.
- Teacher self-assignment, registration RPC, baseline RLS and admin demo records remain unresolved. No remote migration was applied.
- User confirmed the remote project contains test/demo data. Its complete schema and controls still require verification.
- User has no SQL backup. Recover definitions from the existing project's dashboard or an authorized database connection; do not invent a replacement base schema from frontend queries.

### Metadata recovered from manual export

The user supplied the export captured at 21:35 IST on 2 November. The normalized and original wrapped JSON are saved under `supabase/schema-snapshots/2026-11-02/`, with source hashes and a review README. Both attachments describe the same snapshot: 69 tables, three views, ten enums, 178 policies, 34 functions and 24 triggers.

This resolves the missing metadata needed for code/policy inspection. It does not establish a working MCP connection, a restorable base migration, or end-user RLS runtime verification. The OAuth screenshot explicitly reports that organization Owner/Admin approval is required; the pending CLI login was stopped. Its server entry is configured but authentication is not verified. Official Supabase and Postgres skills were installed separately for Codex.

Initial inspection confirms the attendance adapter's structural contract. It also exposes critical authorization definitions: school-member role writes and globally scoped staff helpers must be repaired before continuing the money flow. See the snapshot's `SECURITY-REVIEW.md` for evidence and qualifications.

### Second slice: role escalation hotfix — user reports applied

The recovered definitions reproduce two authorization failures: a student can directly insert their own `super_admin` role, and a school-A administrator can use `assign_school_role` to grant roles in school B.

Prepared `supabase/migrations/20261102163032_harden_school_role_assignment.sql` and [manual execution instructions](../../supabase/manual/README.md). The transaction revokes untrusted direct role writes, replaces role reads with own/scoped-admin access, and retains the public RPC signature through a private implementation that checks the caller's authority for the target school. Only an existing super admin can grant super-admin authority. NULL-school grants are limited to that global role; repeated identical grants do not create new rows. Existing role rows, including existing duplicates, are retained.

Schema/owner preflight, a brief table lock and postconditions prevent silently applying the patch to unexpected policies/triggers or leaving inherited/column write grants active. API access for trusted service callers remains, with actor checks on the RPC. No other table's policies are changed.

Local role tests use the supplied enum, table constraints, role helpers and policies in PGlite PostgreSQL **18.6**, with synthetic users, schools and JWT-subject lookup. The source snapshot is PostgreSQL **17.11**; local tests do not establish deployed Supabase/Auth behavior or a pass on that exact server version. The separate manual verification query checks 15 catalog flags and selects no role-membership or pupil rows.

Verification at this checkpoint: **56 role-database cases pass; 155 tests pass across all five test files**, including the 99 attendance/auth cases. TypeScript and database-test ESLint pass. The tests reproduce both original exploits, deny them after the patch, preserve authorized grants and existing data, exercise service callers, replay the migration, verify rollback on policy/trigger/inherited-grant drift, and run all 15 manual checks before/after. No new production-build run was needed for this SQL/test-only slice; the preceding attendance build result remains the earlier checkpoint. Whole-project legacy lint findings remain unresolved.

Remote status: **user-reported applied on 2 November 2026**. The user confirms running the complete migration in the test project's SQL Editor and reports all 15 verification checks `true`. This is the user's catalog-check result, not an independent remote connection or live multi-user authorization test. The earlier export query was read-only; it did not apply this fix. MCP authorization is no longer part of this work.

Still unresolved: existing grants need review for earlier unauthorized authority; global staff/finance helpers and other tenant policies, teacher assignments, activation, storage and fee integrity remain separate repairs. This patch is not a complete tenant-security certification.

### Third slice: school-scoped office policies — user reports applied

Prepared `supabase/migrations/20261102164657_staff_school_scope.sql`. It replaces all 21 policies that called school-unaware office/finance helpers, and the teacher-owned notice branch now requires a teacher role for that notice's school. A qualifying role and school must match the same `user_roles` row; an accountant at A with a parent/teacher role at B must not receive office access at B. Existing broad office permissions within the role's own school are preserved for this slice.

Local reconstruction also reproduced `42P17` on student/enrollment queries: `students_teacher_assigned_read` queries enrollments, while `admin_enrollments_all` queries students. A necessary 22nd policy replacement moves that administrator lookup into a narrowly scoped private boolean helper, removing the circular RLS expansion while preserving school-admin/super-admin authority.

Five private helpers resolve direct schools and canonical student, teacher, class-log and student-parent scopes. Parent links require both parent and student to belong to the same school. Seventeen touched tables retain authenticated CRUD, with anonymous/PUBLIC access and non-DML privileges removed; trusted service access is retained. The transaction requires the earlier role fix, checks expected policy names/command/role shapes and existing DML privileges, and rejects unsafe inherited privileges. It does not compare every unchanged policy condition against the export or review existing data.

The bounded fixture replays 23 actual tables with constraints/indexes/triggers, 93 coexisting recovered policies and real relevant helper definitions. The first role fix is applied before this slice. Both the original cross-school finance exploit and student/enrollment recursion have been reproduced locally. **All 23 new database cases and all 178 tests across six files pass**, with TypeScript and database-test ESLint passing. Tests cover office role boundaries across all 17 tables, mixed accountant/teacher/parent roles, legitimate family/teacher reads and attendance, indirect-row reparenting, anonymous/non-DML denial, trusted service behavior, repeat application and unknown-policy rollback. All 20 new manual catalog checks pass locally, and the first patch's 15 checks still pass. Independent SQL review found no additional in-scope defect. This is PGlite PostgreSQL 18.6 validation against recovered PostgreSQL 17.11 metadata, without a new production-build run or live Supabase authorization test. See [the compatibility contract and remaining limits](STAFF-SCHOOL-SCOPE.md) and [manual application instructions](../../supabase/manual/staff-school-scope.md).

Remote status: **user-reported applied on 2 November 2026**. The user confirms all 20 staff-scope catalog checks return `true`, after previously confirming the first patch's 15 checks. This is not an independent remote connection or live multi-user authorization test. Teacher self-assignment/own-row policies, wildcard family material reads, profile linkage/activation, cross-school foreign-key coherence, audit integrity and payment posting remain separate repairs.

### Fourth slice: governed teaching assignments — user reports applied

Two actual exploits were reproduced after the first two patches: a teacher could make themselves a class teacher and acquire another roster, or hijack another teacher's `profile_id` to gain the already-approved roster without writing assignments. Both routes are denied by `supabase/migrations/20261102170543_govern_teacher_assignments.sql`.

- School admins/principals manage assignments in their own school; global super admins retain management authority. Teachers read their own linked, active, school-role-approved assignments; accountant/reception assignment reads remain, with no assignment writes.
- A trigger and policy validate teacher/year/class/subject school equality, section/class equality, and a non-NULL section for class-teacher duty. Invalid existing scopes or ambiguous teacher/current-year contexts abort rather than being silently repaired.
- Teachers and academic masters no longer permit ordinary school-member mutations. Protected IDs/school ownership and section parent keys cannot be moved through API updates. Ordinary profile edits are limited to name/phone/avatar; teacher identity writes require management. Trusted backend operations and the existing own-phone RPC remain supported.
- Registration retains its public signature and atomic student/enrollment insert, but requires one active linked teacher, the matching school's teacher role, one current year and one coherent approved class-teacher duty. Chosen authority rows are locked through the operation. Middle names survive and admission numbers are no longer truncated after 999. This does not add an idempotency contract or current-year uniqueness index.
- The existing assignment screen now has explicit authorized-school selection, admin/principal management and teacher read-only mode. Removed the old inline self-management screen and replaced the dead duplicate with a safe re-export. Loads are paginated and stale responses ignored; pending drafts/writes lock scope changes; update/delete compare loaded values and require exactly one returned row before reporting success. Existing navigation now exposes the working assignment route.

Verification: **250 distinct tests pass** (248 in the combined ten-file suite, plus two dedicated catalog/trigger-drift cases), TypeScript passes, scoped changed-code lint passes, and production build passes. The 34 governance behavior cases cover both exploits, supervisor-to-teacher attendance/registration, cross-school references and identity mutations, phone compatibility, rollback and replay. The 26-check manual query is tested before/after; every application table is unchanged by the migration/query, unsafe definer drift is detected, and unknown trigger drift aborts atomically. Whole-project lint remains **18 legacy errors and 65 warnings**; rules are not suppressed. Local database tests remain PGlite PostgreSQL 18.6 against the PostgreSQL 17.11 snapshot, without a deployed multi-user Auth test.

Remote status: **user-reported applied on 2 November 2026**. The user confirms all 26 governance catalog checks return `true`, after the preceding 15/20-check patches. This is not an independent remote connection or a deployed multi-user flow test. The previous staff verifier's exact assignment/master policy fingerprints are intentionally superseded; do not reapply that older patch over governance. The first role verifier's 15 checks still pass locally. Frontend changes are local and have not been deployed.

Still pending: activation/onboarding, broader academic-write policies, remaining family/audience/tenant policies, audit/storage and financial integrity. Existing global class-teacher indexes still block some rollover scenarios. Registration retries can duplicate pupils after an uncertain response, and multiple current years can still be created by management; registrations fail closed when that context is ambiguous. Existing data and privileges still require review before real-school use.

### Fifth slice: client loading and lint baseline — locally verified

Resolved all remaining **18 ESLint errors and 65 warnings** without disabling rules or deferring state changes merely to hide lint findings. Dashboard, admin and academic loaders now use stable dependencies and ignore superseded/unmounted requests. User/school/mode changes reset their own state; parent child changes immediately hide the previous child's data. Assignment selection no longer reboots academic drafts, and unrelated assessment refreshes retain unsaved marks. Browser demo storage uses consistent server/browser snapshots and storage subscriptions; it remains demo storage, not a school backend.

Typed query rows replace remaining explicit `any` values. App-shell identity reads cannot overwrite a newer auth session, auth subscriptions clean up, failed logout remains retryable and duplicate logout submissions are ignored. Theme controls hydrate without mismatched server markup and have accessible names. Next's development server generated the local `AGENTS.md`; its installed-version documentation was reviewed.

Verification: **280 tests pass across 16 files**, with whole-project ESLint **0 errors / 0 warnings**, TypeScript and production build passing. Thirty new regression cases cover delayed identity/user/school/child/roster responses, persisted demo edits and cross-tab updates, draft retention, auth-session cleanup/logout failure, and theme hydration. No SQL, fee-ledger redesign or remote deployment was part of this slice.

Live verification checkpoint: the local app started on port 3102 and rendered the login/access boundary. There was no authenticated ERP session, and the connected Chrome Supabase dashboard was signed out. The user requested a seeded test account, then explicitly deferred seeding/live verification until MCP/access is configured tomorrow. **No test account or remote seed rows were created.** The temporary local development server was stopped. Resume with an authorized Supabase connection, create isolated synthetic teacher/class data, and verify attendance save/reload through the actual authenticated browser/API/database flow. Current browser/provider checks do not certify that live flow.

Access setup resumed on 2 November: the existing Codex Supabase server has the requested project-scoped HTTP URL and is enabled. `codex mcp login supabase` returned success, and a separate `codex mcp list --json` reports `auth_status: o_auth`. Both official Supabase skills remain installed in Codex; separate Claude project config/skills also exist. The current chat still exposes no Supabase tools, so desktop MCP Restart and a real read-only tool call remain pending. Automated access to Codex's own app controls was denied by the computer-use tool's safety restriction; no workaround was attempted. No database query, test account or remote seed was created during setup.

After the user reported reconnecting, a fresh ephemeral Codex CLI client made a successful **real Supabase MCP `get_project_url` call**, returning `https://bjecfuixgqgyohttrdfr.supabase.co`. That call verified authenticated access to the intended project's information. A separate catalog-only `execute_sql` attempt was blocked before execution with `MCP tool call requires approval, but approval policy is never`. No SQL or seed ran in that approval context.

### Sixth slice: live teacher attendance — verified in the demo project

After approval mode was enabled, reviewed MCP SQL confirmed PostgreSQL 17.11 and the three repair functions. The complete role and teaching-governance verifiers returned **15/15** and **26/26** true, respectively. The teaching verifier also confirms that the superseded school-unaware staff predicates are absent. The older staff verifier was skipped because some of its expected policy definitions are superseded. Direct Supabase tools became available during the test and were used for independent attendance readback.

Created a synthetic teacher login, current year, assigned class/section and three active enrollments in isolated school `QA-261103-fccd05a4`. The fixture transaction inserted a confirmed test Auth identity and scoped teacher role. It sent no email and changed no existing accounts, roles or policies. The test password and seed materials are outside the repository. This fixture checks real Auth sign-in and teacher authorization; product onboarding remains untested.

On **3 November 2026 IST**, the local app signed in against hosted Supabase Auth (HTTP 200), loaded the assigned roster and saved Present, Absent and Holiday through three successful attendance inserts (HTTP 201). Register reload and browser refresh restored all statuses. A different date showed an empty register; returning restored the saved date. The editor disabled date changes with unsaved edits and disabled Save with no changes. Changing Present to Late saved one student (HTTP 200). Reload and full refresh followed by reopening 3 November showed **Late, Absent, Holiday**. SQL verified exactly three rows in the fixture school, all on 3 November with the expected year, section and marking teacher, and the same row IDs before and after the single update. The synthetic fixture remains in the demo project for follow-up.

This run exposed a dashboard date mismatch near midnight: the editor used IST while the teacher summary used UTC. The teacher dashboard now shares the editor's `schoolDate()` helper. After midnight on 4 November IST, the browser showed 4 November in the editor and both attendance requests used 4 November (HTTP 200), with zero records for the new day. Two regression tests cover date and month rollover. **282 tests across 16 files, whole-project ESLint, and TypeScript pass.** This checkpoint covered the teacher register.

### Seventh slice: live admin attendance

Admin attendance uses the shared register with the authorized school's current academic year, class, section, and active enrollments. School choices come from administrator role rows. The browser encountered a school policy that called the revoked public `has_role` function. Migration `20261104054348_repair_school_policy_helper` switches that policy to the private school-scope helper and is recorded in the demo project.

On **4 November 2026 IST**, a separate QA school administrator signed in, loaded the three students, filtered the roster, and saved Present, Absent, and Holiday. Register reload and full page refresh restored the statuses. Changing Present to Late updated one row. Supabase readback confirmed the same three row IDs, correct school, section, year, and marking role. The 3 November teacher records still matched their verified statuses.

### Eighth slice · Student and parent attendance

Both dashboards read recent attendance from Supabase using the linked pupil and school. They show a loading state, an empty history, or a fetch error as appropriate. Parent selection survives a browser refresh in the same tab and is restored only if the child is still linked. The dashboard fetches the selected child's records again on refresh.

Separate QA logins reused the six marks for **3 and 4 November 2026 IST**. The student saw One's two Late marks before and after refresh. The parent switched between One and Two and verified Late and Absent respectively on both dates after full refresh. Read-only checks under each QA identity confirmed the student could read two marks and the parent four. Both identities received zero rows for Three, whose two Holiday records were independently confirmed. QA profiles were linked explicitly to the existing fixture. The activation flow remains a separate step.

### Ninth slice · Read-only family attendance pages

The Attendance menu opens the Supabase history for the signed-in student or selected linked child. The dashboard and page share the same scoped queries and parent selection. History is ordered newest first and loads 30 rows at a time.

The same QA accounts verified both **3 and 4 November 2026 IST** records after a full refresh on the Attendance page. The student saw One's two Late marks. The parent saw One's two Late marks and Two's two Absent marks after switching children and refreshing each view. The selected child also carried back to the dashboard. Read-only Supabase checks confirmed that both accounts received zero rows for the unrelated pupil Three, whose two Holiday marks exist. Regression tests cover pagination, late responses during child switches, and stored selections whose link was revoked.

### Remaining existing-code repairs

1. Extend the local role fixture to the remaining school/domain policies and two-family cases. Verify permissions directly; the role hotfix is user-reported applied, while other remote policy changes remain pending.
   The manual export helper is `supabase/inspection/export-schema-metadata.sql`; the user's completed export is saved in `supabase/schema-snapshots/2026-11-02/`.
2. Keep the now-clean lint/type/test/build baseline while completing the remaining business flows.
3. Extend the verified class-teacher attendance flow to supervisor assignment management and other roles, then finish downstream academic-write/activation scope and rollover constraints.
4. Repair fee posting as an authoritative transactional payment/allocation/receipt flow; test partial payments, failures, retries, concurrency and reconciliation.
5. Make academic log replacement atomic; protect assessment clearing/remarks/scope and year rollover.
6. Resolve stale family requests, totals/date inconsistencies, notice audiences and bounded history.

## Phase 2: real school setup

Replace demo people/academic masters with durable students, guardians, staff, enrollments, invitations and imports. Test onboarding across roles before expanding features.

### Academic setup and student enrollment

School admins and principals can add and view academic years, classes, sections and subjects in Supabase. The first year is set as current. Adding later years preserves the current year. Migration `20261104112755_guard_academic_year_setup` rejects inverted date ranges and multiple current years in the same school.

The Students workspace admits a pupil into an active class and section in the current year. Migration `20261104112800_admit_roster_student` checks school access and saves the student and enrollment in one transaction. Duplicate admission numbers are rejected within a school.

Chromium against hosted demo Supabase verified that setup records persist after reload and that a new pupil appears in the roster, Attendance and Guardian Invitations. The dedicated QA school `ERP-QA-d767af40` also verified admin attendance save and reload, student access to their own record, and guardian invite acceptance followed by read-only attendance for one linked child.

### Student CSV import

School admins and principals can preview and import up to 50 students into the selected current-year class and section. The import uses the same school and enrollment checks as single admission. Migration `20261104131632_import_roster_students` commits the complete batch together and records the request so an identical retry returns the original result.

Hosted demo browser QA imported two students and found both after reload. A second batch with a conflicting admission number rolled back every row. Parser and database tests cover malformed CSV, duplicate rows, changed retry payloads and school scope.

### Teacher onboarding and permissions

School admins and principals can create a teacher record, issue a 72-hour invitation and revoke a pending invitation. The teacher signs in with the verified email on the invite. Migration `20261104132141_teacher_invitations` binds the account and grants the school-specific teacher role in one transaction. Existing same-school teacher or guardian memberships are supported. Office and student accounts use a separate teacher login so accepting an invitation cannot change their default workspace.

Legacy teacher and accountant activation by employee ID and phone are disabled. Teacher and student memberships can read their own profiles and school metadata. School-wide profile and legacy office access require an office role. Teacher attendance and assessment use their existing assignment policies. Legacy results and attachment access for families and teachers require their own scoped read policies.

Hosted demo browser QA created a teacher record and linked a pre-confirmed QA account through an invitation. The teacher dashboard and Linked status persisted after reload. Attendance required a class assignment and then showed the assigned roster. Finance Reports, peer profiles and payroll were denied. Founder QA covers fresh-account email delivery.

Migration `20261104132143_scope_student_study_materials` checks the linked student's school against the material's school. A hosted rollback test verified same-school visibility and denial of another school's school-wide material. Year rollover and onboarding for the other staff roles remain separate flows.

Migration `20261104132514_scope_teacher_directory` limits full teacher records to office roles and the linked teacher. Academic pages use a school-scoped lookup that returns only teacher names and IDs. Hosted checks verified that the QA student can load the display name without reading the teacher record, and the teacher retains access to their own phone field.

### Guardian invitations for the attendance pilot

School admins and principals can issue or revoke a guardian invitation for one active pupil in the school's current-year roster. They copy the link and share it with the guardian. The link expires after 72 hours, and reissuing it invalidates the previous pending link for the same pupil and email.

The guardian signs in with the invited, confirmed email and accepts the link. Supabase links the child and grants the parent role in a single transaction. The app opens the linked child's read-only attendance. Existing roles and same-school sibling links are preserved. Accounts with roles or a parent profile at a different school need a separate onboarding path.

The demo project has migration `20261104105130_guardian_invitations` applied. It keeps invitation hashes in a private schema, replaces guardian code and phone activation, and removes broad school access from parent-only memberships. Scoped family reads remain available. The migration also enforces same-school attendance and study material reads.

Local Chromium against hosted demo Supabase verified invite creation and copy, wrong-account rejection, reissue, revocation, concurrent acceptance, replay rejection and attendance readback after refresh. API checks confirmed one guardian profile, one parent role and one link for the fresh QA account, no attendance writes, and no access to the other pupils' marks. The existing QA parent still sees both linked children. Expiry, wrong-school requests, and rollback on a failed write are covered by database regression tests. New-account confirmation UI is covered by tests. The full suite passed 333 tests with three workers and a 15-second per-test timeout. ESLint, TypeScript and the production build passed. Live confirmation email delivery and manual Vercel QA remain pending. [Guardian invitation checklist](POST-DEPLOY-QA.md#guardian-invitation-qa)

## Phase 3: one sellable office workflow

Finish fee demands, allocations, approved adjustments/reversals, receipts, day closing, dues and chosen message channels. Verify against approved opening balances and one fee cycle.

### Single-pupil fee collection and receipts

Office users can issue a monthly demand from a matching current-year fee structure, then record a full or partial payment. Migration `20261104113121_record_office_fee_payment` locks the demand while it checks the balance, saves a receipt and updates payment status. An identical retry returns the original receipt. Existing family reads remain available, and the office flow uses the transaction instead of separate direct writes.

Hosted API checks with the seeded QA school returned one demand ID for two identical requests and one receipt for two concurrent ₹400 submissions with the same request ID. Overpayment and access from a student or a different school were denied. Fee structure setup, approved adjustments and reversals, and day closing remain separate flows.

Chromium verified a ₹1,000 demand, ₹300 cash partial payment, recovery of the same receipt after a simulated lost response and reload, and a final ₹700 UPI settlement. The office reopened both receipts. Reports reconciled both QA pupils at ₹1,400 collected and ₹600 outstanding, including the separate API test.

### Cashier day close

Finance Reports shows paid receipts by method for an IST business date. Office users review the totals, enter the actual cash count and explain a cash difference before confirming. Migration `20261104131723_close_office_fee_day` saves a closing snapshot and locks the ledger for that date. If receipts change after review, the close requires refreshed totals.

Hosted demo browser QA closed 31 October with ₹200 recorded cash and ₹190 counted. The form required an explanation for the ₹10 difference, and reload showed the same closing snapshot. Database tests cover stale reviews, retry behavior and receipt writes after close.

## Phase 4: daily school use

Complete guardian attendance/receipt views, notices, homework/catch-up and acknowledgments. Add school-approved results/report cards, promotion, certificates and timetable as separately tested flows.

### Family receipts and targeted notices

Students and guardians can read their own or linked child's paid receipts in Invoices & Receipts. Chromium verified both office receipts after refresh under each role. Receipts for the unrelated pupil and payment controls were absent.

Migration `20261104113103_secure_notice_audiences` applies role, school, class and section visibility at the database. Admins and principals manage notices. Teachers can publish to their assigned classes. Other roles use the read-only notice inbox. Chromium verified a parent-only publication, a hidden draft, student denial and unpublish/republish after reload. Local database tests cover other school, current enrollment and expiry boundaries.

### Workspace navigation

The workspace has role-specific mobile shortcuts, a full menu and a keyboard page finder. Desktop and mobile navigation identify the active page. The page finder searches only links available to the current role. Chromium at 390 px verified menu focus, Escape dismissal and full receipt numbers without viewport overflow. The desktop keyboard shortcut opened the selected finance page, and guardian search excluded that page.

## Phase 5: department modules and commercial readiness

Finish transport, library, HR/payroll and inventory with explicit role and workflow acceptance checks. Finalize advertised packages with the founder. Verify subscription administration, demo and onboarding, production monitoring and backup restoration before commercial sign-off.

## Founder-aligned daily operations slice

The [founder answers](../product/FOUNDER-ANSWERS.md) define the commercial ERP scope, target school profile and sign-off. The [PRD](../product/PRD.md) maps all ten answers to requirements and acceptance criteria. The first school's configuration and commercial package decisions remain open.

- **Historical attendance** · Migration `20261104163647_govern_attendance_corrections` keeps direct saves on the current IST day. Assigned teachers request one pupil's historical change with a reason. School Admin or Principal reviews with a reason. Approval compares the saved revision and writes the new value and audit together. Direct historical writes, deletes by school accounts, stale approvals and self-review are blocked. Accountants and reception staff retain reads under existing policies. The current-year register and active enrollment limit requests and approvals.
- **Student withdrawal** · Migration `20261104163648_withdraw_roster_enrollment` changes the current enrollment and records the reason, actor and timestamp in one transaction. The pupil leaves the active roster. Attendance and fee history remain available to authorized users. Pending invitations cannot be accepted for the withdrawn enrollment.
- **Guardian access removal** · Migration `20261104163536_revoke_guardian_access` lets the School Admin find a pupil by admission number, including after withdrawal. It revokes one relationship, invalidates older matching invitations and records the action. Other links remain authorized. Existing accepted links remain active after withdrawal until the school removes them. The access log records changes from this migration onward.

All three migrations are applied on the demo project. The automated suite passed 374 tests. Lint, TypeScript and production build checks passed. Chromium verified the combined workflow with hosted demo Supabase. The protected Preview at app revision `0dd074a` verified saved approvals, rejection, withdrawal and guardian removal, including the guardian’s scoped refresh at 390 px. The [combined QA checklist](POST-DEPLOY-QA.md#historical-attendance-withdrawal-and-guardian-access) records the URL and manual steps.

School-specific attendance windows, period attendance, substitute coverage and guardian recovery are separate flows in the PRD.


## Same-school transfer and session promotion

School Admin and Principal can move a pupil between classes or sections from Students. Migration `20261104181843_change_roster_placement` preserves the student and enrollment IDs, retains original attendance placement by date and writes a private reason and actor history. The transfer takes effect before attendance is marked on the current IST day. Prior attendance remains visible by date, and the existing demand, balance and receipts retain their original records.

A promotion stages one destination enrollment per pupil and academic year. Staff can revise the destination with another audited reason before activation. Staged enrollment is visible to school office roles and does not grant family or teacher access to destination records. Withdrawal cancels a staged promotion. The outgoing active placement remains in use until the year switch.

In **Academics & Subjects**, migration `20261104181845_activate_academic_year` checks readiness, requires an activation reason and switches the school to one current year in a transaction. Missing placements, invalid placements, open attendance corrections and dates outside the destination session block the switch. Earlier enrollment, marks, fee records and teacher assignments stay in their original sessions. Admin and principal can open earlier attendance registers read-only.

Both migrations are applied to hosted demo Supabase. A dedicated synthetic school verified transfer, revision of a staged promotion, incomplete placement rejection, school-wide activation, student and guardian history and a teacher save in the new session after reload. The fixture calendar was advanced separately to test activation after the new session began. Protected Preview revision `7dc5375` verified the active roster, historical register and placement audit, teacher readback and both family roles after refresh. The [manual QA checklist](POST-DEPLOY-QA.md#same-school-transfer-and-session-promotion) records the scenarios.


## Staff and guardian CSV imports

**Teachers & Staff** imports teaching and non-teaching records with `employee_id,full_name,staff_type`. Migration `20261104185147_secure_staff_directory` scopes non-teaching directory reads to school managers and enables unlinked named records. Migration `20261104185149_import_school_staff` enforces a common case-insensitive employee ID across both directories, commits each batch in one transaction and records the reviewer, time and counts. A teacher can receive an invitation after import. Imported directory records start without login access.

**Guardian invitations** previews `admission_number,guardian_email` against active pupils in the selected school's current session. Migration `20261104185151_import_guardian_csv` rejects unknown admissions, duplicate rows, existing links and pending invitations for the same pupil and email. Confirming a valid batch produces one private invitation link per row. A verified recipient must accept to create the relationship and receive guardian access. Exact retries from the same preview recover pending links. Individual invitation history remains available after reload.

All three migrations are applied to hosted demo Supabase. Chromium verified mixed staff types, duplicate rejection, exact retry after a lost response, teacher invitation acceptance and correct student linkage for two separate verified guardians after refresh. Protected Preview revision `f4952e8` verified both staff lists and the import audit, duplicate rejection and the linked guardian’s attendance after refresh. All 405 automated tests, lint, TypeScript and build passed. The [manual QA checklist](POST-DEPLOY-QA.md#staff-and-guardian-csv-imports) records the steps and fixture.


## Academic setup and teacher assignment CSV imports

**Academics & Subjects** accepts separate templates for classes, sections and subjects. Migration `20261104192737_import_academic_setup_records` enforces case-insensitive class and subject names within the school, section names within each class, and nonblank subject codes within the school. Section preview resolves the exact active class, and confirmation rechecks the class identity. Each batch commits together and records the reviewer, timestamp and count.

**Teaching Assignments** previews an exact school employee ID, active class, section under that class, active subject and class-teacher flag for the current academic year. Migration `20261104192702_import_teacher_assignment_csv` rejects missing or stale mappings, duplicate assignments and competing class-teacher duties. Confirming an import saves all rows together and records the assignment IDs. Retrying a confirmed request from the same preview returns the original result.

Both migrations are applied to hosted demo Supabase. Browser QA verified duplicate previews, distinct same-named sections in two classes, and both class-teacher and subject-teacher assignments. The class and assignment imports recovered safely from interrupted responses. The linked teacher saved attendance for a pupil in the new class-teacher section and verified it after reload. Protected Preview revision `9a488c2` passed academic setup, duplicate and teacher readback checks at 390 px. All 421 automated tests, lint, TypeScript and build passed. The [manual QA checklist](POST-DEPLOY-QA.md#classes-sections-subjects-and-teaching-assignment-csv-imports) records the fixtures and test steps.
