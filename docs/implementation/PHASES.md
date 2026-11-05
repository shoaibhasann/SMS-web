# Implementation phases

Updated 5 November 2026. Implement each operational flow, verify its permissions and failure cases, then advance.

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


## Guardian recovery and verified contact changes

Password reset requests return a generic response. The callback exchanges the PKCE code in an isolated recovery session, verifies the provider's recent recovery authentication method and binds the reset to that session. Successful reset ends the recovery session. The guardian signs in again with the new password.

In **Profile → Guardian contact settings**, email remains pending until the current and new inboxes confirm. Mobile changes require fresh password authentication, authorization for the exact number, and the provider's verification code. Migration `20261104194316_govern_guardian_contacts` enforces these transitions at the Auth record, preserves the Auth account and guardian profile IDs, and mirrors the verified phone to the school record. Old-address pending invitations are retired and known-recipient invitations are bound to the intended account. Confirmed child links retain their existing IDs.

The migration is applied to hosted demo Supabase. Browser QA used synthetic Auth challenges to verify password recovery, both email confirmations and mobile OTP confirmation with the hosted Auth service. The same guardian retained two pupil links, the old sign-in credentials were rejected and the school mobile mirrored the verified number. Protected Preview revision `1814c60` passed sign-in with the new credentials, verified contact readback, both pupils’ attendance after refresh and recovery form access restrictions at 390 px. All 449 automated tests, lint, TypeScript and the build passed. Actual email and SMS delivery remain manual provider checks. The [manual QA checklist](POST-DEPLOY-QA.md#guardian-recovery-and-verified-contact-changes) links the Preview and covers setup and test steps.

## Guardian access revocation and re-invitation

Migration `20261104202511_reinvite_guardian_access` is applied to the hosted demo project.

School administrators can find a pupil by admission number, remove one guardian relationship with a reason, then create a new link from the removed relationship. The link is for the existing guardian account’s current verified address. The guardian signs in and accepts to restore the original relationship. Replacing a pending link invalidates the previous token. Ordinary and CSV invitations direct staff back to this administrator flow for a revoked relationship. Revocations recorded before this release lacked a primary-contact flag, so those links restore as non-primary.

Attendance records belong to the student. The access check uses the live relationship, so revocation cuts off the selected pupil’s history for that guardian and keeps siblings accessible through their own links. Acceptance makes the original attendance history visible again. The [manual QA checklist](POST-DEPLOY-QA.md#revoke-and-re-invite-a-guardian-for-one-child) covers the administrator, guardian and permission checks.

Protected Preview revision `f320566` passed the admin revoke, link replacement and guardian acceptance flow. Live Supabase checks confirmed that the selected pupil became inaccessible to the removed guardian and that the other guardian and sibling remained authorized. After acceptance, both attendance histories matched the original rows and IDs. The browser verified the restored relationship after refresh.

## In-app absence alerts

Migration `20261104203041_guardian_absence_alerts` is applied to hosted demo Supabase.

An attendance save that records Absent creates an in-app alert for each current linked guardian. The attendance change and alert creation commit together. A repeat save of the same status keeps one alert per guardian and attendance record. The guardian feed checks the live child relationship and saved attendance status before showing the alert. The guardian Dashboard and Attendance show recent alerts. Notifications shows up to 30. The feed starts with new absence saves after the migration, and existing attendance history remains available through Attendance. The [manual QA checklist](POST-DEPLOY-QA.md#in-app-absence-alerts-for-guardians) covers save, retry, revocation and correction.

Protected Preview revision `4d06f4c` passed a live attendance save, same-status retry, guardian revocation, correction and re-invitation against hosted demo Supabase. The guardian views agreed with direct API reads after refresh, and the original attendance row and sibling access were preserved.

## Guardian notification read state

Migration `20261104210215_guardian_absence_alert_read_state` is applied to hosted demo Supabase.

The guardian Notifications inbox shows the full unread count and lets the guardian mark each absence alert as read. Supabase saves the read time on that guardian’s own copy, so two guardians can read the same absence independently. Refresh and subsequent sign-ins use the saved state. Existing alerts start unread. Revoked and corrected alerts are excluded from the count. The inbox shows unread alerts first so older unread items become available as the first entries are read. The [manual QA checklist](POST-DEPLOY-QA.md#guardian-notifications-unread-count-and-mark-as-read) covers both accounts and permission checks.

Protected Preview revision `6bf6414` passed the two-guardian flow after a real demo attendance save. Hard refresh and fresh sign-in preserved the independent states. Concurrent retries returned the original read time, and cross-recipient writes were denied.

## Guardian notification filters and bulk read

Migration `20261104210847_guardian_absence_alert_bulk_read` is applied to hosted demo Supabase.

**All** shows the current inbox list and **Unread** filters it to unread alerts. **Mark all as read** updates the signed-in guardian’s eligible unread alerts in one database operation, including alerts beyond the visible list. The inbox reloads after the operation to show the saved count. Existing read times are preserved and the other guardian’s copies keep their own state. The [manual QA checklist](POST-DEPLOY-QA.md#guardian-notifications-filters-and-mark-all-as-read) covers both accounts, filtering and retries.

Protected Preview revision `86ce43b` passed both filters and the bulk action after a real demo attendance save. Hard reload and fresh sign-in preserved each guardian’s count. The database regression covered bulk read across the 30-row list limit.

## School attendance cutoff and daily register progress

Migration `20261105110918_school_attendance_cutoff_monitor` is applied to hosted demo Supabase.

This slice implements the founder’s per-school cutoff and pending-register dashboard requirement in ATT-01. A school administrator sets or disables the cutoff with a reason. The setting starts unconfigured. The monitor uses the server’s current IST day and current academic year to count expected, marked and unmarked pupils in each populated section. An incomplete section becomes Pending after the configured cutoff. Complete means every expected pupil has a saved attendance mark.

The monitor refreshes on the dashboard and alongside the Attendance register. The existing attendance save remains the source of the counts. Unmarked pupils keep their unmarked state. School calendar exclusions and configurable period attendance remain separate PRD work. The [manual QA checklist](POST-DEPLOY-QA.md#school-attendance-cutoff-and-daily-register-progress) covers configuration, partial saves, cutoff and completion.

Protected Preview revision `122a2bb` passed cutoff configuration, partial register save, Pending after cutoff and completion after a late save. Admin and principal dashboards agreed after refresh. The test verified scoped role denial, stale settings rejection and preserved attendance/guardian-alert state. All 479 automated tests, lint, TypeScript and final Preview build passed.

Temporary substitute-teacher attendance coverage is described below. Attendance reporting and calendar configuration follow the daily-operation checks.

## Substitute attendance coverage

The current implementation slice adds dated class-teacher attendance coverage. Admin and Principal can assign a same-school substitute to an existing class-teacher register and revoke that coverage with a reason. The date range is inclusive in IST and belongs to the current academic year. The substitute gains attendance register access while the range is active. Access ends when the record is revoked, the range expires or the source assignment changes.

The substitute’s normal Attendance page and dashboard use effective attendance assignments. Permanent academic subject duties, student admission and historical attendance corrections retain their separate authorization paths. The [manual QA checklist](POST-DEPLOY-QA.md#substitute-attendance-coverage) covers scheduling, active saves, revocation, expiry and scope boundaries. The frontend remains local until a release is requested; the additive backend migration is applied to the hosted demo project for QA.

Migration `20261105121426_substitute_attendance_coverage.sql` matches the hosted migration checksum. RLS restricts temporary attendance reads by covered class and attendance date, and authenticated writes lock the coverage and source identity before saving. Revocation retains the record, actor and reason. The manager list includes every unrevoked grant whose end date has not elapsed, including invalid source assignments, even beyond the latest 100 historical entries. Direct access to the private coverage table is denied. The security advisor added only the expected informational notice for a private RLS table with no direct policies; existing project warnings remain unchanged.

This slice does not extend academic log, homework or study-material authorization. Its inspection found older teacher-owner policies on `class_logs`, `class_activities` and `study_materials` that could OR around assignment checks. The separate academic permission hardening below addresses those paths. Attendance coverage itself still grants no academic duties.

Local frontend plus hosted demo QA passed assign, future restriction, current-day save and hard reload, same-session revoke, a trusted expired-date fixture, dashboard access refresh and a concurrent save/revoke API outcome. The linked guardian retained attendance history and the permanent assignments were unchanged. All 511 tests, lint, TypeScript and production build passed. The [checklist](POST-DEPLOY-QA.md#substitute-attendance-coverage) records the verification and the simulated-expiry limitation. No application push or Vercel deployment was made for this slice.

## Academic authoring permissions

Teacher writes now require their own active identity and an exact permanent assignment matching school, current academic year, class, section and subject. Teacher-selected null section/subject values cannot broadcast to wider audiences. Historical logs remain read-only where a real retained assignment permits the teacher to read them. Admin and Principal retain coherent school management; other existing office roles keep their scoped read access. Finance and reception roles cannot author or grade academic work.

The complete policy sets for `class_logs`, `class_activities`, `study_materials` and `activity_submissions` replace the earlier permissive write bypasses. Guard triggers check and lock the assignment/identity at mutation time. Record placement and authorship cannot be changed to move content or a response into a different audience. Pupils can submit only their own eligible responses; assigned teachers can grade without rewriting a pupil's response. Linked guardians are read-only, and family academic reads require published work in their own pupil's school/class.

Daily Log and dedicated activity authoring use one atomic `save_academic_log` RPC. Existing activity IDs, attachment/grading metadata and submission relationships survive edits. Deleting a log or activity with submissions is rejected, and the entire save rolls back. Expected `updated_at` checks reject stale full snapshots instead of deleting work added in another session. The teacher UI narrows selectors and edit controls, rechecks assignments on focus/every 30 seconds and does not report a zero-row delete as success.

Private material objects use `<school>/<year>/<class>/<section>/<subject>/<teacher>/<uuid>.<ext>` assignment paths. Teachers can upload and replace their own currently assigned resources; family reads require an authorized published metadata link with the same physical scope. Submission-referenced bytes cannot be overwritten by the teacher, and referenced files cannot be deleted by the teacher. Ordinary copy/move and signed-upload operations are denied. Office-authored shared files retain their separate school-wide metadata audience. Existing signed URLs remain usable until expiry; fresh signing/downloading uses current permissions. Other storage buckets were left outside this change.

Applied to the hosted demo project: `20261105125739_harden_academic_assignment_permissions.sql`, `20261105125748_harden_academic_material_files.sql`, `20261105125909_refresh_locked_academic_grading_scope.sql`, `20261105130656_permit_scoped_material_replace_probe.sql` and `20261105131004_restrict_academic_submission_table_privileges.sql`. Corrections refresh maximum marks after obtaining the activity lock, permit Storage's scoped INSERT-on-conflict replacement probe and revoke the submission table's older anonymous/non-DML grants. Authenticated DML remains subject to the new policies and field guards. All five hosted migration checksums match their local files. The frontend remains local; no Git push or Vercel deployment has been requested. The [manual checklist](POST-DEPLOY-QA.md#academic-authoring-permissions) distinguishes browser flows from API-only binary upload and homework-submission checks.

Local Chromium plus hosted Supabase QA passed teacher draft/publish/edit and dedicated homework CRUD with hard reloads; pupil/guardian and Admin/Principal readback; forged scope, owner and parent rejection; actual binary upload/read/replace; submitted-file protection; and assignment removal in the same authenticated teacher session. Family published history and original submitted bytes remained available after teacher access ended. A real teacher navigation gap was fixed for Academic Log and Study Material. Existing broader project advisor warnings remain unchanged; this is a scoped repair rather than a certification of every module or storage bucket. See the existing [mutable-function search-path advisory](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable) for one remaining project-wide item. All 551 automated tests pass, with passing lint, TypeScript and production build checks.

## Student homework submission and teacher grading

The pupil's Homework card now opens My submission for a text response and one optional private PDF/JPG/PNG up to 10 MiB. The teacher's published homework opens a submission roster with pending/submitted/graded states, pupil responses, authenticated attachment downloads and marks/feedback. Maximum marks can be configured in the Homework editor; without a maximum, feedback-only grading is available. A submitted attachment is immutable. Pupils can update permitted text before review, and graded responses are read-only. Return/resubmission workflows and multiple attachments remain separate features.

Atomic submit/grade RPCs use revision checks and actor-bound idempotent receipts. Unknown HTTP outcomes keep the same request/file intent for retry. Direct authenticated table writes are revoked; pupil/teacher/guardian/office reads still use scoped policies. Storage validates a complete homework/pupil path and the actual uploaded object owner, size and MIME. The new private `homework-submissions` bucket denies overwrite, signing, copy/move and deletion of linked evidence. A fresh volatile guard after the object lock closes the pending-delete/attach race. Client downloads use fresh authenticated blobs and abort on account switch, close or unmount; a cached public or signed URL is never stored in the UI.

Applied demo migrations: `20261105133902_atomic_homework_submission_and_grading.sql`, `20261105133914_private_homework_submission_files.sql`, `20261105134741_academic_optimistic_conflict_http_status.sql` and `20261105134743_homework_optimistic_conflict_http_status.sql`. The last two replace business-conflict SQLSTATE 40001 with PT409/HTTP 409 for academic save and homework submit/grade. This fixes the actual deployed PostgREST 14 infinite-retry behavior found by live QA, documented in [Supabase's advisory](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b). Applied migration history remains intact.

Browser and authenticated API QA passed text+real PDF submit, a committed/lost-response retry with one upload/row, actual-byte teacher download, 8/10 plus feedback, both-account hard reloads, same-class pupil isolation, PNG/JPG validation/cleanup, denied scope/owner/grade/file forgery, timely HTTP 409 and concurrent revision conflicts. Removing the source assignment stopped the same teacher session's grading/file reads and cleared the visible controls. Pupil/guardian evidence remained intact. All 592 tests, lint, TypeScript and final build pass; the [manual checklist](POST-DEPLOY-QA.md#homework-submission-and-grading-ui) records setup and evidence. Source remains local; no Git push or Vercel deployment was made.

The homework slice identified the remaining conflict-code repair in `close_office_fee_day`, `request_attendance_correction` and `review_attendance_correction`. That follow-up is implemented below.

## Attendance and fee conflict recovery

The remaining four business-conflict raises in three live routines now use `PT409`/HTTP 409 instead of reserved SQLSTATE `40001`. Migrations `20261105140713_attendance_optimistic_conflict_http_status.sql` and `20261105140715_office_fee_day_optimistic_conflict_http_status.sql` copy the inspected deployed definitions and change only those error codes. Function body hashes match the expected literal substitution. Signatures, access grants, search paths, authorization, locking, idempotence and return contracts are unchanged. Applied migration history is preserved.

The teacher's stale correction request keeps its draft/reason and blocks submission until the register is explicitly reloaded. An outdated approval keeps the review reason, requires Refresh requests, and then allows rejection rather than approving an immutable stale snapshot. The reviewer asks the teacher to reload and create a new request. Cashier day close preserves entered cash/note, cancels its old confirmation and requires Refresh day plus renewed review/confirmation. None of these paths automatically resubmits a conflict or reports an approval/closure that was not saved.

Both migrations are applied to hosted demo Supabase. An independent audit verified the three corrected bodies and three unchanged public wrappers, with pinned search paths and authenticated-only execute grants. A broad scan of all non-system/non-extension application schemas found no remaining custom `40001` literal or named `serialization_failure` source. The frontend remains local; Git push and Vercel deployment remain on hold.

All 599 automated tests across 70 files pass with `npm test -- --maxWorkers=4 --testTimeout=20000`, plus lint, TypeScript and production build. New regressions verify no writes on a stale correction request/review or fee close, retained draft/reason/cash values, explicit refresh before retry, and unchanged successful/idempotent behavior. The project security-advisor counts remain at their pre-change baseline; existing project-wide warnings remain separate work.

Local Chromium and authenticated hosted API QA passed all four corrected conflict branches. Stale request, stale approval and fee close returned HTTP 409 in 234, 205 and 77 ms, retaining inputs and saved data. The previously unmarked-pupil insert race reached its exact second-branch error after a deliberate lock wait, preserved the winning row/pending request, and recovered through rejection, fresh request, approval and idempotent retry. Attendance, teacher request history and the single ₹100 fee receipt/close survived reloads. Unauthorized roles and another school remained denied; all three visible conflict states passed at 390 px. The [manual checklist and evidence](POST-DEPLOY-QA.md#attendance-and-fee-conflict-recovery) include the closed-day repeat-test setup. This compatibility follow-up is complete; the source remains local until release is requested.

## Fees phase 1: reviewed demand batches and opening balances

This is the first complete slice of the remaining fee-office cycle. In Fees, authorized School Admin, Principal and Accountant accounts can prepare monthly demands for all matching active pupils or narrow them to a class/section. The server preview checks the complete set, including duplicate or incoherent existing demands, and shows ready/existing/error rows and new debt separately. An explicit billing month and due date within the current academic year are required. Posting needs review and confirmation, commits the whole batch together, and retains existing charges without changing their amount or due date. A stale roster/structure/debt snapshot returns PT409 and requires a new preview.

Opening balances import outstanding debt through a UTF-8 CSV with admission number and amount, a current-year as-of date up to today, source reference and review reason. Rows map within the selected school and require one active current-year enrollment. Duplicate/ambiguous admissions, invalid amounts and invalid placements block the complete batch. A pupil can have one opening balance per academic year. A protected per-year fee head keeps the existing payment, receipt and family read paths working; it is excluded from ordinary fee-structure choices. Opening balances create debt, not historical cash receipts. Positive outstanding amounts are supported; advance credits and signed migration balances require the subsequent finance flows.

The opening file must contain additional off-system debt that is not already represented by existing ERP demands. The office reconciles the approved source against the current ledger before posting; existing unpaid demands remain payable. The UI repeats this distinction in the opening form and confirmation. External debt cannot be deduplicated semantically from an amount alone.

Posting uses a SHA-256 reviewed-snapshot token and an actor-bound request receipt. The browser keeps an unknown HTTP outcome's original payload/token/UUID for reload and identical retry. New monthly posting shares the existing single-demand advisory locks. Current-year, identity and roster locks protect the final reviewed set; admissions committed after that final set read belong to the next preview. Existing demand payment status is excluded from the batch fingerprint because a receipt does not change the new debt being posted. Both paths support at most 1,500 pupils per batch; larger scopes must be narrowed and are never silently truncated.

Finance Reports now has a server-calculated demand/balance ledger with current/all-session selection and paged rows. Summary totals cover the complete selected scope, independently of pagination. Opening debt is shown separately from payments applied. Unassigned-year or inconsistent legacy data remains visible for review, and invalid reconciliation totals are withheld rather than replaced with zero. The office can inspect the opening source/date on the ledger.

The dormant `fee_discounts` and `fee_refunds` tables had broad membership-based CRUD. Their new policies retain coherent office/own-student/linked-child reads, while raw untrusted mutations and non-DML grants are revoked. Historical rows and trusted service access remain. Approved adjustment, reversal and refund write flows are still a later slice; this change does not advertise them as implemented.

Demo migrations are `20261105151457_harden_fee_adjustment_record_access.sql` and `20261105152515_office_fee_batches_and_opening_balances.sql`. Hosted/local SQL checksums agree. A read-only catalog audit verified all eight new RPC/private bodies, both guards, private-table ACL/RLS, indexes and pinned search paths. Existing issue/payment/day-close bodies and grants remain unchanged. Advisors added only four informational notices for intentionally inaccessible private audit/mapping tables; prior warnings remain unchanged.

Database regressions cover exact 1,500-pupil monthly/opening batches, 1,501 rejection, full rollback after a later insert fails, role/school isolation, stale previews, original receipt recovery and opening-balance payments. Local PGlite measurements for 1,500 pupils were monthly preview/post 359/1,235 ms and opening preview/post 108/546 ms; these are local engine results, not hosted capacity claims. Manual scenarios are in the [fee batch checklist](POST-DEPLOY-QA.md#fee-batches-and-opening-balances). No Git push or Vercel deployment is authorized for this slice.

Local Chromium and hosted demo API QA passed monthly all/section preview, stale-template rejection with input retention, a committed/dropped HTTP result followed by hard-reload recovery, concurrent exact replay and a real race against the older single-demand RPC. Three committed batches produced three monthly demands and two opening demands, alongside the original legacy demand. Opening posting added no receipt or cash-day revision. The existing payment UI then settled one ₹500.25 opening demand using ₹250.25 cash and ₹250 UPI, with matching student/guardian receipt readback after reload and no other-pupil access. The server ledger and independent catalog query agree on six demands: ₹5,300.25 net, ₹600.25 paid and ₹4,700 outstanding, including ₹1,300.25 opening debt. The older partial fee, ₹100 receipt and closed 4 November day remained unchanged. Today's collection day remains open. Mobile 390 px and desktop 1440 px checks passed without horizontal page overflow or monitored errors.

All 672 tests across 76 files, whole-project lint, TypeScript and final production build pass. QA browsers/clients and the owned local server were closed; private handoffs retain credentials and evidence outside the repository. The next fee slice is governed adjustments/reversals with reconciled effects and reviewed receipts, followed by the complete school-approved fee cycle. No Git push or Vercel deployment was made.

## Fees phase 2: approved changes and payment-entry reversals

Authorized office staff can request a fee reduction, additional charge or full recorded-payment reversal from the canonical ledger. Requests retain the original before/after amounts, reason, actor and financial snapshot. They affect no balances or cash until a different School Admin or Principal approves with a review reason. Rejection retains the request without a monetary entry. Requesters cannot review their own proposals, including administrator requests. A reduction cannot make the fee negative or reduce it below effective payments already credited.

Original demand amounts, discounts, late fees and receipts remain evidence. Approved reductions/charges create signed immutable adjustment entries; full reversals create one counterentry per original receipt. A reversal increases the effective outstanding balance and reduces the original payment method's collections on the actual approval date in IST. It never rewrites the old receipt or reopens its old closed day. Approval is blocked when the current day is closed, leaving the proposal pending. The UI explicitly describes a recorded-entry correction: no bank transfer/refund is initiated. Partial refunds and advance credits remain separate work.

One server accounting definition supplies effective net fees, gross payments, reversed amounts, credited payments, balance and status. The payment RPC uses that balance, including additional charges against previously settled demands. Office ledger, payment choices/caps, invoice and receipt details/exports, Finance Reports, Admin finance cards and family balances/receipts now use the canonical readers. Family endpoints enforce own-pupil/current linked-child scope, omit private financial tokens and office review reasons, and reject incoherent source mappings. Legacy refund rows require reconciliation; unverified totals are withheld. Billed fee structures cannot be moved to another school/year/class while future pricing can still be edited.

Request IDs bind the actor and exact reviewed payload. Review retries bind the original decision/reason; pending browser intents survive a same-tab reload after an unknown HTTP outcome. Fee locks precede day locks, and a volatile state read after a lock wait checks the current committed position. PT409 rejects a stale request/approval, preserves the draft/reason and requires explicit refresh. An obsolete pending proposal must be rejected and replaced rather than approved after a refresh. Cashier reports separate gross, reversal and net totals, including negative-only correction days; cached day-close reviews conflict after a new counterentry.

Demo migration `20261105162341_governed_office_fee_changes.sql` is applied and its local/hosted SQL MD5 agrees (`8c952b73514ce5e9530645de2b87d3e5`). The new tables live in the unexposed private schema with RLS and no direct API grants. Public wrappers use SECURITY INVOKER and authenticated-only execution; checked private routines pin their search path. Existing day-close wrappers and stored closed snapshots retain their contracts. The security advisor adds only three expected informational private RLS/no-policy notices; prior warning counts are unchanged. These intentionally inaccessible audit tables are covered by the [Supabase notice explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

An independent read-only hosted catalog audit matched all 30 migration function bodies and verified their owners, pinned paths, volatility/security flags and grants. It also confirmed that 21 untouched baseline routine bodies/ACLs, including day-close and batch helpers, were unchanged. The three private tables have no API/column grants or direct policies; all four guards and six new indexes are enabled/valid, with uniqueness for each request entry and original-payment reversal. Audit evidence remains in the private QA handoff.

All 750 tests across 82 files, whole-project lint, TypeScript and production build pass. New regressions cover independent review, idempotence, unknown outcomes, stale payments/approvals, effective balance collection, private writes, cross-school/family isolation, legacy corruption, closed-day preservation and negative-day reconciliation. The [manual checklist](POST-DEPLOY-QA.md#approved-fee-changes-and-payment-entry-reversals) records the full office/family flow and distinguishes local regressions from hosted evidence.

Local Chromium and hosted demo QA passed a ₹100 reduction, ₹50 additional charge, self-review denial and another ₹50 reduction after a genuine payment/approval lock-wait conflict. The sole new ₹50 payment committed first while both calls waited on the same synthetic fee row; stale approval returned PT409, preserved the pending request/reason and recovered through explicit refresh, rejection and a fresh proposal. Two concurrent exact approvals of a prior-day ₹100 receipt produced one reversal; discarding the successful browser response, hard reloading and retrying recovered that same entry. The source receipt/fee and the prior closed-day snapshot stayed unchanged. A cached ₹350 cash close conflicted, then refresh/recount ₹250 closed with zero variance. A second reversal approval after close was denied without effects, while the earlier successful retry still recovered.

Independent trusted SQL and authenticated readers agree on ₹1,700 effective fees, ₹550 gross payments, ₹100 reversed, ₹450 credited and ₹1,250 outstanding. Six proposals finish as four approved/two rejected with exactly three adjustments and one reversal. The new day's three receipts reconcile to ₹450 gross/₹350 net/₹250 net cash. Student and guardian hard reloads retain their three own receipt amounts, reversal metadata and ₹900/₹350/₹550 pupil balance; other pupils' records and office reasons remain unavailable. Phone 390 px and desktop 1440 px checks passed without page overflow or monitored errors. QA clients/browsers were closed, local sessions signed out and the owned server stopped. Source remains local; no commit, push or deployment was made. Partial/actual bank refunds, advance credits and school-approved policy/cycle sign-off remain subsequent FIN-01 work.

## Login visual redesign — local review checkpoint

The login screen uses a generated school/community illustration on a pale left panel, an organic divider and a compact right-hand form. Blue/navy brand colors and existing theme surfaces remain. Login-specific primary-action colors `#3157E8` → `#6147E8` give white text 5.74–5.87:1 contrast, replacing the old theme-dependent login gradient that reached 2.90:1 in dark mode. The exact prompt and palette measurements are in [the visual direction](../design/login-visual-direction.md).

Matching viewport gutters/frame height fixes the previous laptop overflow. At normal laptop sizes the image shrinks inside the frame; phones hide it, and short screens allow vertical scrolling. Password reveal, a recovery link, autocomplete, visible focus and error alerts improve form use. Both sign-in methods share a pending-action lock and recover from returned or thrown failures; Supabase endpoints and dashboard/callback routes keep their existing contracts.

Local installed Chrome checked light/dark at 1440 × 900, 1366 × 768, 1280 × 720, 1024 × 768, 390 × 844, 375 × 667, 320 × 568, 1280 × 600 and 683 × 384, plus an invalid-password state in both themes. The normal laptop and 390 × 844 views have no document overflow, and the laptop error state has no nested scrollbar. Small/short screens retain vertical scrolling without horizontal overflow or clipped form content. Invalid-password HTTP responses were intercepted locally; no real account was signed in or changed. All 65 focused login/auth/recovery/shell tests across five files, whole-project lint, TypeScript and diff checks passed after the redesign. The earlier full audit's 847-test checkpoint is separate; no fresh production build was run for this visual change.

The [login checklist](POST-DEPLOY-QA.md#login-screen-redesign) leaves actual provider login, inbox recovery, real browser zoom and post-deployment founder results pending. The development server remains available at `http://127.0.0.1:3120/login`. No commit, push or deployment was made. The separately requested codebase audit remains a read-only report; its backend findings were not changed by this UI work.

### SMS branding and automatic-theme follow-up

Product headers now use a bold uppercase SMS wordmark without a graduation-cap badge; login, dashboard, activation/invitation headers, recovery copy and the document title agree. Login has no theme switcher and follows the device automatically, while the dashboard has a compact native System/Light/Dark selector in the desktop sidebar or mobile Workspace menu footer. Workspace preferences remain saved independently of the login's System scope. The theme engine's bootstrap resolves the login preference before hydration and responds to live system changes; Tailwind dark utilities now use the same selected class so manual preferences also style navigation correctly.

All 69 focused theme/login/auth/recovery/shell tests and 23 invitation regressions passed, alongside whole-project lint, TypeScript and diff checks. Local Chrome verified opposite saved/device preferences before hydration, live device changes, SMS wordmarks and overflow at 1366 × 768, 1280 × 720, 1024 × 768, 390 × 844 and 320 × 568 in both themes. An existing hosted-demo QA teacher login verified saved Light restoration, manual Dark after hard reload, System tracking live device changes, a mobile theme change and Logout returning to device Light while retaining dashboard Dark. Navigation colors, visible keyboard focus and the mobile 48px label/46px native hit area passed. The QA user was signed out; school records were not edited. [Updated founder checks](POST-DEPLOY-QA.md#login-screen-redesign) keep Google, inbox recovery and deployed results pending. No commit, push, new production build or deployment was made; the dev server remains available.

## Fees phase 3: student advance credit and offline refunds

The dedicated Advance credit module keeps one retained student account across academic sessions, with explicit school/student context. School Admin, Principal and Finance can record cleared funds already received through manual office channels, apply available credit to the student's fee debt and request reviewed corrections/refunds. Advance receipts and fee applications are separate entries: allocating stored money increases fee-applied payments without counting it as another cash receipt. Independent approval can partially return an original allocation to credit and reopen that fee amount, retaining the original allocation. Full advance-receipt corrections retain the source and require sufficient available unreserved credit and an open cashier day.

Unused-credit refunds follow Pending → Approved/reserved → Paid. A different Admin/Principal reviews the request. Approval reduces available credit but records no payout or cash movement; a separate confirmed offline payout records its actual manual method/proof and current IST posting day. Reviewers can cancel an approved unpaid reservation with a reason, releasing it without cash. A completed payout cannot be cancelled. New receipts/refunds require a unique normalized proof reference within their school and entry type, and exact actor/payload/UUID retries recover their original result, including after day close. Original approval retries after a refund was paid/cancelled return its actual current state without reserving again.

Financial writes use exact decimal money, private account mutexes, fee-before-account-before-day lock ordering, current role/profile locks and post-lock volatile state reads. This avoids using a public pupil row as the wallet mutex, which could conflict with original payment foreign-key locks. Available credit excludes approved unpaid reservations, so allocations and refunds cannot spend the same entitlement. Pending/rejected requests have no financial token effect. Stale immutable proposals require rejection and a refreshed request; they cannot become valid by clicking Refresh. Unknown browser outcomes retain the same scoped operation across reloads. An unreadable saved retry blocks new financial actions until the operator inspects Activity/Requests and explicitly clears only that local retry after reconciliation.

Canonical fee positions, family fee cards and office payment caps now include net advance allocations. Finance Reports, Admin cash cards and cashier-day summaries count actual advance receipts once and subtract actual offline payouts separately from recorded-entry reversals. Allocation, return, reservation and cancellation do not enter the cash union. Old closed-day summaries keep their original JSON. Incoherent or underfunded trusted legacy journals withhold credit and affected fee totals; family activity excludes incoherent sources and carries no office reasons, actors, tokens or request payloads. Student/guardian Advance credit is read-only with linked-child switching, paging and refresh.

Provider-specific behavior stays outside the ledger. Shared INR/paise helpers live in `lib/finance/money.ts`, manual method definitions in `payment-methods.ts`, and typed credit RPCs in `advance-credit.ts`; office access resolution, scoped forms and family statements are separate components. No gateway SDK, checkout, webhook or success simulator was added. The [settlement boundary](FEE-SETTLEMENT-BOUNDARY.md) defines the future server adapter, verified settlement/idempotency and refund confirmation requirements. The current slice covers unused advance refunds, including credit returned from its own allocations. Historical credit import, ordinary legacy receipt partial refunds and school fee-policy sign-off remain separate work.

Demo migration `20261105170615_office_student_advance_credit.sql` is applied; hosted/local SQL MD5 matches `0090e3658da4a551b824d62eaf20084f`. Three private RLS tables hold account locks, immutable entries and reviewed requests. Nine public wrappers use SECURITY INVOKER with authenticated-only checked implementations; internal helpers remain inaccessible to API roles. Independent catalog comparison matched all 34 function bodies/attributes, preserved 45 baseline finance routines/ACLs, and verified both triggers and all 12 indexes. Existing advisor warning counts are unchanged, with three expected informational [private RLS/no-policy notices](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy). All 847 automated tests across 89 files, whole-project lint, TypeScript and production build pass. The [manual checklist](POST-DEPLOY-QA.md#student-advance-credit-and-offline-refunds) records exact verification and manual repeat setup.

Local Chromium and hosted demo QA passed receive ₹1,000 → apply ₹600 → reserve/pay ₹150 → independently return ₹100 allocation → reserve/pay another ₹100. A real account-lock overlap let one ₹150 authorization succeed while a competing ₹300 request returned PT409; the browser kept its reason and recovered through explicit rejection. Concurrent exact payout calls, a discarded successful browser response, same-context hard reload and saved-operation retry produced one payout. Duplicate physical proof under a new UUID, self-review, invalid amounts and foreign/role access were denied. A cached ₹850 cashier close conflicted; refreshed ₹750 closed with zero variance. A confirmation prepared before close and sent afterwards was denied without losing its reservation, then cancellation released it without cash effects. Prior successful payout retries still recovered after close.

Independent trusted SQL and all readers agree on ₹250 remaining advance, zero reserved, ₹500 net allocated and ₹250 refunded. The school ledger is ₹1,800 net / ₹600 applied / ₹1,200 due; today's cash is ₹1,000 gross less ₹250 actual payouts = ₹750. Seven requests finish as two paid, one approved return, two rejected and two cancelled, with five journal entries and no new ordinary fee-payment row. Original fee/receipt evidence and the prior ₹100 close are unchanged. Student/guardian statement and fee cards survive reload with no other-child data or office metadata; phone 390 px and desktop 1440 px pass without page overflow or page errors. QA browsers/API clients were signed out/closed. Per the user's request the owned dev server remains running at `http://127.0.0.1:3120` for manual review. No commit, push or deployment was made; the backend migration is applied only to the demo project.
