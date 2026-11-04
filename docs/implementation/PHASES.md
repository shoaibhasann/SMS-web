# Implementation phases

Updated 2 November 2026. Work one operational flow at a time: implement, run failure/regression tests, review integration, then advance. No new feature sweep until existing data risks are resolved.

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

## Phase 3: one sellable office workflow

Finish fee demands, allocations, approved adjustments/reversals, receipts, day closing, dues and chosen message channels. Verify against approved opening balances and one fee cycle.

## Phase 4: daily school use

Complete guardian attendance/receipt views, notices, homework/catch-up and acknowledgments. Add school-approved results/report cards, promotion, certificates and timetable as separately tested flows.

## Phase 5: expansion from repeat paid demand

Introduce requested admissions, transport, library, inventory, payroll and integrations when support cost and demand justify them. Keep acceptance gates explicit.
