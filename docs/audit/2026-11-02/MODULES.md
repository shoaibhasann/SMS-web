# SMS-web frontend module audit

Audit scope: source inspection of every frontend route and all `lib/`, `components/` files in the supplied web checkout, 2026-11-02. Read-only: no application files changed. Findings below are reproducible from source; authenticated browser/database behavior was not tested by this subagent. Supabase base schema, existing policies, and deployed migration state are not available here.

## Verdict

This is a teacher-centric functional prototype with a broad admin demo shell, not a full school-management system. Of 25 visible admin module links, 19 route to local demo implementations; six have live Supabase integration with important workflow gaps. The seven remaining catalog modules are hidden from admin navigation but accessible by direct URLs. No module is classified production-complete merely because it has a screen or a database call.

The closest coherent value loop is teacher classwork/homework publishing -> student/parent read access -> absence-linked missed-work view. Fee collection, attendance editing, staff governance and parent communication need correctness work before use with real school data.

## Capability matrix

Legend: LP = live-partial code; LD = local demo; PH = placeholder; BR = incorrect role destination; NA = not granted by current role registry. Live-partial means code calls Supabase; it is not evidence of deployed policy compatibility or successful real use.

| Module / route | Admin | Teacher | Student / Parent | Principal / Finance / Reception | Actual scope |
|---|---|---|---|---|---|
| `/dashboard` | LP | LP | LP | Principal LP, Finance LP, Reception link grid | Real queries; role-specific limitations below |
| students | LD | NA | NA | Finance/Reception PH, Principal PH | Admin demo name/contact/class strings; no real admin student creation/edit lifecycle |
| parents | LD | NA | NA | Reception/Principal PH | Demo children field is text, not real relation provisioning |
| teachers | LD | NA | NA | Principal PH | Demo staff and assignments strings; no real user onboarding |
| admissions | LD | NA | NA | Reception/Principal PH | Approval changes local status only; no student/enrollment/fee conversion |
| class-logs | LP read via direct URL, hidden nav | NA | LP read | Principal LP read | Legacy teacher editor branch currently unreachable under teacher role registry |
| classwork | LP read via direct URL, hidden nav | LP create/edit/delete | LP read | Principal LP read | Teacher text publishing; no attachment/submission/completion loop |
| homework | LP read via direct URL, hidden nav | LP create/edit/delete + due date | LP read | Principal LP read | No student hand-in, grading, acknowledgment or overdue tracking |
| assignments | LP read via direct URL, hidden nav | NA | LP read | Principal LP read | No reachable teacher creator in current role routing |
| projects | LP read via direct URL, hidden nav | NA | LP read | Principal LP read | No reachable teacher creator or hand-in workflow |
| study-material | LP read via direct URL, hidden nav | NA | LP read | Principal LP read | Academic activity text only, no upload/download file pipeline |
| missed-activities | LP read via direct URL, hidden nav | NA | LP absence-linked read | Principal LP read | Useful differentiator seed, but log/absence caps limit history |
| attendance | LD read | LP write | BR teacher-only register | Principal BR | Separate dashboard editor can overwrite saved statuses |
| academics | LD CRUD | NA | NA | Principal PH | Visible admin setup never updates real year/class/section/subject masters |
| exams | LP CRUD/marks | LP assigned assessment CRUD/marks | PH | Principal PH | No term aggregation, moderation, report-card publish flow |
| results | LP marks table + JSON preview | LP marks/ranks table | PH | Principal PH | Parents/students cannot view final report cards/results |
| timetable | LD rows | NA | PH | Principal PH | No real schedule, clash checking, substitution or teacher timetable |
| fees | LP reads/structure creation/payment preview | LP assigned-student read | PH | Finance PH module; LP collection only on dashboard | No existing-demand instalment workflow, reliable posting ledger, refunds or reconciliation |
| invoices | LP read + JSON preview + whole-page print | NA | PH | Finance/Principal PH | No branded isolated invoice/receipt artifact |
| finance-reports | LP totals + demo class dues | NA | NA | Finance/Principal PH | No ledger export, bank settlement reconciliation, date-range reports |
| notices | LP CRUD | Create own notices on dashboard only | PH | Reception/Principal PH | No recipient inbox/acknowledgment/delivery state |
| events | LD | NA | PH | Reception/Principal PH | No shared calendar/reminders |
| notifications | LD “Send” changes local status | NA | PH | Principal PH | No SMS/WhatsApp/email/push integration |
| library | LD catalogue/issue/return | NA | NA | Principal PH | Unvalidated name-based issue records; no actual barcode/fine ledger |
| transport | LD vehicles/allocations | NA | NA | Principal PH | No real route/student relationships, location, attendance or notifications |
| inventory | LD stock/movements | NA | NA | Principal PH | Name-matched local quantities, no authoritative stock ledger |
| hr-payroll | LD | NA | NA | Principal PH | Salary strings/records only; no payroll run, payslip or approval |
| leave | LD approve/reject | NA | NA | Principal PH | No employee request or balance workflow |
| profile | LD | LP read + phone RPC/password reset/logout | PH | Principal PH | No admin school branding or contact settings persistence |
| documents | LD metadata strings | NA | NA | Reception/Principal PH | No actual storage upload/download/access lifecycle |
| reports | LD “Generate” status | NA | NA | Finance/Principal PH | No generated report output |
| audit-logs | LD mutable CRUD | NA | NA | Principal PH | No immutable audit trail |
| settings | LD | NA | NA | Principal PH | Settings do not configure live modules |
| `/modules/teacher-assignments` | LP direct URL, hidden nav | LP direct URL, hidden nav | NA | NA | Teacher self-managed class/section/subject + class-teacher designation |
| `/modules/academic` (singular) | LP old setup | Has no page-level role guard | Has no page-level role guard | Has no page-level role guard | Old standalone live subject-add screen; different from visible plural academics route |

Routing proof: `app/(dashboard)/modules/[module]/page.tsx:168-241`. Role/nav registry: `lib/modules.ts:48-134`. Local persistence: `lib/admin/admin-demo-service.ts:160-187`. Specific singular academic page: `app/(dashboard)/modules/academic/page.tsx:69-95,173-189`.

## Prioritized correctness findings

### P1 — Teacher dashboard can overwrite saved attendance with Present

`components/dashboard/role-dashboard.tsx:325,470-485,608-624,840-859`

Attendance edit state starts `{}` and is never populated with the selected date's persisted records. The only attendance query feeds a separate today-summary state. Each unset dropdown and save payload defaults to Present. Reproduction: mark a student absent in the dedicated register, reload dashboard, click Save Attendance without changing any dropdown. Existing absent/leave/holiday status gets overwritten with Present. Changing the dashboard date reuses the previous date's edit state. Required fix: load selected section/year/date register, show unmarked explicitly, block stale saves, and use optimistic version/concurrency handling.

### P1 — Finance collection does not apply instalments to an existing fee

`components/dashboard/role-dashboard.tsx:972-1018`

Every Collect action inserts a new `student_fees` row for the current month and then separately inserts a payment. There is no selection/reuse of existing student-fee demand and no transaction/idempotency key. Example: monthly demand 1000, payment 400 then 600 produces two 1000 demands (or fails the second insert if a missing base-schema uniqueness constraint prevents it), rather than settling one demand. If the payment insert fails after a successful demand insert, the demand retains paid/partial status without the payment row. Receipt numbers use truncated client timestamps. Required fix: server transaction posting payment allocations to existing demands, authoritative receipt sequence, retry key, reversals, and reconciliation.

### P1 — Admin cannot operate the school through the visible core master screens

`app/(dashboard)/modules/[module]/page.tsx:168-216`; `components/admin/admin-academic-setup-workspace.tsx:24-63`; `lib/admin/admin-demo-service.ts:160-187`

Admin students/parents/teachers, attendance and academic setup all use independent local demo stores. A school admin adding a subject or admitting a student here does not create the live records consumed by teachers, finance or parent accounts. Separate browsers and schools get no shared state. Onboarding, bulk import, year rollover, identity invitation and real relation management are absent. This blocks a pilot regardless of UI polish.

### P1 — Student/parent attendance links resolve to a teacher-only register

`app/(dashboard)/modules/[module]/page.tsx:168-172,522-542`; `lib/modules.ts:63-99`

Students and parents are allowed attendance but all non-admin users are sent to `AttendanceRegister`, which immediately requires a matching `teachers.profile_id` and errors “Teacher profile was not found for this login.” Principal has the same problem. Use role-specific read views instead of sharing teacher mutation UI.

### P1 — Most authorized roles land on placeholders

`app/(dashboard)/modules/[module]/page.tsx:183-241,2218-2237`

All dedicated admin workspaces are guarded by `access.role === "admin"`; teacher gets a handful of specialized screens. Finance's five nav modules and reception's six modules fall through to GenericModule, as do student/parent exams/results/timetable/fees/invoices/notices/events/notifications/profile. Principal gets the admin dashboard but not its module implementations. These screens say “ready for its dedicated management screen.” Parent/student dashboards offer some read data, but menu entries are not actual capabilities.

### P1 — Saving marks cannot clear an existing result and admin saves erase teacher remarks

`components/admin/admin-assessment-workspace.tsx:266-293`; `components/teacher/teacher-views.tsx:454-495`

Blank inputs are skipped and only nonblank rows are upserted. Clearing an old score from 80 to blank then saving leaves 80 in DB; if all inputs cleared the save is refused. Admin constructs every entered row with `remarks: null`, silently erasing teacher remarks while editing scores. Required fix: explicit absent/not-evaluated/withdrawn states, delete/clear intent, preserve remarks unless edited, and auditable corrections.

### P1/P2 — Admin can change assessment scope after marks exist

`components/admin/admin-assessment-workspace.tsx:326-336,424-436`; teacher guard `components/teacher/teacher-views.tsx:383-399`; SQL guards `supabase/migrations/20261101_teacher_assessments_and_profile.sql:56-78,208-239`.

Teacher UI blocks changing class/section/year/subject after any marks exist, but admin UI allows it. Existing marks stay attached to the moved assessment; mark-enrollment checks only run when marks themselves are inserted/updated, not when parent assessment scope changes. A Class 6 result can therefore be relabeled Class 5 with its original students. Move invariant to DB and provide an intentional migration/correction flow.

### P2 — Admin collection totals include non-paid transactions

`components/dashboard/role-dashboard.tsx:1414-1426` vs `components/admin/admin-finance-workspace.tsx:172-192`.

Dashboard collection sums every payment amount in time range without status filter, while finance workspace counts only `status === "paid"`. Pending/failed/refunded/cancelled rows can inflate school summary and disagree with finance totals. Use one ledger definition/server aggregate across all views.

### P2 — Notices audience values do not match canonical roles

`components/admin/admin-notices-workspace.tsx:120-121,149-161`.

Choosing “Students”, “Parents” or “Teachers” serializes `students`, `parents`, `teachers` while Everyone emits `student`, `parent`, `teacher` and edit logic recognizes the singular only. Save a Students-only notice then edit it: audience displays Everyone. Future recipient filtering will misroute/hide these notices. Use an explicit label-to-enum mapping and actual recipient testing.

### P2 — Attendance percentages count holidays as missed school days

`components/dashboard/role-dashboard.tsx:1122,1154-1155,1283,1315-1316`.

Numerator only includes present/late but denominator uses all fetched attendance entries, including holiday, approved leave and half-day. Example one present plus one holiday displays 50%. Metrics also use an unlabeled last-60-record window, potentially spanning years. Define school policy, eligible working days, year/date filters and half-day weighting.

### P2 — School reports silently truncate at API/default or hard-coded limits

`components/admin/admin-finance-workspace.tsx:108-128`; `components/admin/admin-assessment-workspace.tsx:140-176`; `lib/academic.ts:117-128`; `components/teacher/teacher-views.tsx:1008`; `components/dashboard/role-dashboard.tsx:579`.

Finance and marks queries do not paginate; Supabase's configured max rows can silently cap results. Academic logs explicitly load only 200; teacher fees 500; dashboard roster 200 before section filtering. No “showing X of Y” or history paging exists, so real-school totals, children and history can disappear with growth. AdminDashboard paginates collections already, showing the need is understood but applied inconsistently.

### P2 — Parent child switch can show stale/wrong selected child's details

`components/dashboard/role-dashboard.tsx:1276-1313`.

Multiple independent asynchronous writes have no cancellation/request token and old child data is not cleared while selected child changes. Quickly switch A -> B with A's request slower: A can overwrite B's selected UI. Children are already authorized links, so this is a correctness issue rather than a claimed cross-account exposure. Use keyed aggregate fetch and ignore stale responses.

### P2 — Invoice printing prints the entire application

`components/admin/admin-finance-workspace.tsx:421,439`; downloads `:223-264`; `app/globals.css` has no print-specific invoice rendering.

Row Print calls `window.print()` without selecting/rendering that invoice in a print document. Downloads are explicitly JSON previews, not branded receipts usable by school accounts or parents. Build a single-receipt print/PDF view backed by posted immutable receipt data.

## Usability, accessibility and governance gaps

- Global search input has no value/query handler and Bell button has no action: `components/layout/app-shell.tsx:166-183`. Both suggest capabilities that do not exist.
- Menu icon has no accessible name/expanded state; Bell icon has no accessible name: `components/layout/app-shell.tsx:159-164,181-183`. Small-screen sidebar lacks backdrop, Escape handling and focus management.
- Local demo modals are generic fixed div/form overlays without dialog roles, focus trap, initial focus or Escape behavior: `components/admin/admin-demo-workspace.tsx:198-199`; `components/admin/admin-academic-setup-workspace.tsx:79`.
- Fixed hardcoded school branding “Kids Corner”/KC, no effective tenant branding: `components/layout/app-shell.tsx:68-74`. Local storage keys do not include school/user and persist after sign-out: `lib/admin/admin-demo-service.ts:160-183`.
- “Reset demo data” calls load, never `AdminDemoService.reset`; it reloads previously modified local records instead of resetting them: `components/admin/admin-demo-workspace.tsx:60-65,164`, `components/admin/admin-academic-setup-workspace.tsx:24-25,70`.
- Academic setup Subject creation overwrites the practical checkbox with `false`; editing practical does not hydrate checkbox state: `components/admin/admin-academic-setup-workspace.tsx:32,39-45`. Demo correctness only.
- Library issue permits nonexistent books and zero available stock; stock mutation is name matching/clamping instead of validation: `components/admin/admin-demo-workspace.tsx:114-129`. Inventory movement can clamp invalid negative stock to zero, hiding mismatch: `:141-153`. Demo correctness only.
- Admin Audit Logs module allows Add/Edit/Delete through generic local CRUD, not an append-only evidence trail: `components/admin/admin-demo-workspace.tsx:89-109,164,181-187`.
- Notifications “Send” updates local status; Reports “Generate” only sets local status/date: `components/admin/admin-demo-workspace.tsx:185-186`.
- Documents are metadata-only text inputs, no file selection/upload/storage code anywhere in frontend.
- Date handling mixes browser-local calendar dates with `toISOString().slice(0,10)` (UTC). E.g. finance billing/month/today `role-dashboard.tsx:988`; student/parent day helper `:194-195`; admin attendance `admin-attendance-workspace.tsx:11`. In IST before 05:30 local, UTC date is yesterday. School timezone must drive all operational dates.

## Dead/duplicate code that inflates apparent completeness

- `components/admin/admin-people-workspace.tsx` contains a live read-only directory but is never imported by any route. Admin sees demo directories instead.
- `components/dashboard/dashboard.tsx` + `lib/dashboard-data.ts` is an unused static sample dashboard; routed dashboard uses RoleDashboard. `lib/demo.ts` is an unused duplicate sample object. Do not count their metrics as live data.
- `components/academic/teacher-assignments.tsx` is an unused second self-assignment implementation; active manager is embedded in the 2237-line module route.
- Legacy AcademicWorkspace teacher branches can create projects/assignments/material only if teacher can reach class-logs; current `roleModuleKeys.teacher` excludes those routes. Teacher currently creates only classwork/homework through specialized workspaces.
- `/modules/academic` real subject setup and `/modules/academics` local demo setup coexist with separate logic and branding. The visible admin menu points to the demo plural route.
- AppShell, module route, teacher views and role-dashboard embed data access and business rules directly in large client components. Central domain services exist only for some academic helpers; finance/attendance rules are duplicated and already disagree.

## Feature gaps for school adoption (no implementation evidence found)

Real school onboarding/tenant selection and branding; student/parent/staff provisioning/invites; bulk Excel import with preview/error recovery; guardian consent/emergency contact and pickup authorization; admissions conversion and document verification; enrollment promotion/transfer/withdrawal/TC; school calendar and holidays as masters; substitute attendance and correction approval; fee demand generation, existing-demand allocations, concessions approvals, refunds/reversals, receipt sequence and settlement reconciliation; result publish/retract and printable report cards; recipient communication inbox, read receipts and delivery tracking; school-level roles/custom privileges; immutable audit; actual document/file storage; backup/restore/export and offboarding; school migration playbook and support workflow.

## Suggested implementation order

1. Fix attendance overwrite and financial posting before adding modules; require deterministic regression tests around both.
2. Replace admin demo masters with real school-scoped CRUD/import and account invitations. One tenant-scoped identity/enrollment data model feeds every role.
3. Finish the teacher -> parent loop: homework, absence catch-up, notices inbox, receipt and result visibility, delivery/acknowledgment tracking.
4. Complete fees with transaction-based posting, allocations, reversals, official artifacts and daily reconciliation. Pilot reliability beats broad navigation.
5. Offer a sharply bounded paid pilot; expand transport/library/HR only after the core loop is used and demand is demonstrated.
