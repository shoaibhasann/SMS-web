# SMS — founder release checklist

Current founder run: [stable SMS Production](https://sms-web-shoaibhasann.vercel.app/login) · [Production checklist](PRODUCTION-RELEASE-QA.md). Historical Preview release records below are superseded for new testing.

5–6 November 2026 release · Independent founder testing · Founder results pending

Is file ko **is release ke deployed URL** par use karo. Har checkbox apne test ke baad tick karo; earlier local QA ya older Preview ka Pass yahan copy mat karo. Quick smoke se start karo, phir detailed flows ke liye separate role sessions use karo. Full steps and earlier engineering evidence: [comprehensive checklist](POST-DEPLOY-QA.md).

## Latest dashboard UI Preview — 6 November 2026

[Open Sora dashboard Preview](https://kids-corner-erp-frontend-c8ex0atk2-shoaibhasanns-projects.vercel.app/login) · [use this focused founder checklist](DASHBOARD-FOUNDER-PREVIEW-QA.md). Start with Shoaib’s private shareable access link. Existing four-role logins and demo records are unchanged. This dashboard-only release is `dpl_J3fREXZNV1oDz5VpFWAmzi1cxWAC`; it excludes the nine pending SQL phases. The earlier full-feature release and its historical cases remain below. Deployed engineering smoke passes all four role logins, real demo reads, refresh, Sora and desktop/mobile checks; founder acceptance remains unticked.

## Release and test record

| Field | Fill before testing |
|---|---|
| Deployed login URL | [SMS founder Preview](https://kids-corner-erp-frontend-fe0o5b1oc-shoaibhasanns-projects.vercel.app/login) — open the private access link first |
| Code commit / deployment ID | `b9d4e3f377bcec0b0db68e3475226d814ee0dd36` / `dpl_k6Mh2y4eZMn9bRwdn7jvrW3vi9us` |
| Founder, date and time (IST) | |
| Desktop browser and viewport | |
| Phone model/browser and viewport | |
| QA school and academic year | |
| Overall outcome | Pending — Pass / Fail / Blocked |

Open Shoaib's private shareable access link first if Vercel asks for a login; then use the ERP QA account. The access token stays in the private handoff, never in this repository. Engineering pre-release checks passed: **859 tests across 91 files**, whole-project lint, TypeScript and an isolated optimized production build. The demo project already has the 16 new academic/homework/fee migrations. These engineering results do not tick the founder's cases below.

Deployed engineering smoke passed on **6 November 2026 IST**: a fresh external browser opened the share link and reloaded without Vercel login; SMS branding, illustration, automatic dark theme and the phone frame were visible. Existing demo Teacher, Admin, Finance, Guardian and Student accounts signed in successfully. Teacher theme refresh, attendance/homework pages, admin substitute coverage, and office/family advance-credit/receipt pages passed read/reload checks with no monitored page errors. Family credit remained read-only. Accounts were signed out; no school/financial rows were posted by this release smoke. New submit/grade, money posting and delivery cases below remain independent founder tests.

Use only synthetic QA data. The current audit has unresolved database permissions for legacy payroll/marks/audit records, revoked teacher exam access and inactive-admin role grants, plus recovery/reproducibility gaps. This is a demo QA release; functional founder approval does not clear those findings for real school onboarding. Engineering must close them before real school data is introduced.

6 November engineering update: local fixes and student-activation regressions are tracked in [the next security-phase checklist](ACCESS-SECURITY-QA.md). They have not changed this Preview's database. Continue the release cases here; SEC-01 through SEC-10 are for the next scheduled database rollout.

The subsequent [marks/notices/history checklist](ACADEMIC-INTEGRITY-QA.md) adds INT-01 through INT-10 for the next release. Its versioned saves and complete reads also remain local; this Preview is unchanged.

The [recovery checklist](DATABASE-RECOVERY-QA.md) now records the offline schema/restore foundation and the separate real recovery rehearsal. No new UI or restored hosted target is available from this local phase; continue testing the current release here.

The next local [student leave checklist](STUDENT-LEAVE-QA.md) covers family submission, independent office decisions, current-child permissions, overlap/retry handling and preserved history (SL-01–SL-11). The current Preview does not contain this flow or the mixed-guardian receipts/date-boundary fixes; leave those cases pending until the matching SQL/frontend release.

The next local [timetable checklist](TIMETABLE-QA.md) adds TT-01–TT-12 for school scheduling, teacher/class conflicts and scoped readers. It is not available on this existing Preview; test it only after the reviewed SQL/frontend rollout.

The [dashboard implementation checklist](DASHBOARD-QA.md) covers the redesigned Admin, Teacher, Guardian and Student interfaces. The newer Sora dashboard-only Preview is linked in the latest release section above; this older release URL retains its earlier interface. On explicit user request the existing QA school now contains 42 synthetic pupils and populated attendance/learning/notices; accounts, child links and finance rows are unchanged. This hosted data addition does not imply a frontend release or migration rollout.

The [assessment publication checklist](RESULT-PUBLICATION-QA.md) covers independently reviewed marks and published family results. It requires the complete nine-migration pending chain plus the matching frontend rollout; leave its hosted cases pending on this release.

## Accounts and setup

Get the private login handoff from Shoaib. **Passwords, invitation tokens, email confirmation links and deployment-access tokens must not go in this file, screenshots or GitHub issues.** Keep roles in separate browser profiles/private windows; signing out in a shared tab can otherwise mix the run.

| Account | Used for |
|---|---|
| School Admin | Setup/import, roster, guardian links, coverage, fee requests/reviews |
| Principal | Independent review of attendance/fees/refunds and substitute coverage |
| Accountant / Finance | Demands, collection, credit, reports and cashier close |
| Assigned teacher | Current class attendance, homework/materials and grading |
| Substitute / unassigned teacher | Temporary attendance and denied unrelated academic access |
| Student One and Student Two | Own attendance, own submission/file/result and fee statements |
| Guardian | Two linked children; attendance, notifications, receipts and credit statements |
| Other-school / unlinked account, if supplied | Negative school/child boundary checks |

Before write tests, record the starting roster, marks, fee demands, receipts, credit balance and cashier-day status. Prepare disposable QA pupils for imports/placement/guardian removal and a fresh homework task. Do not remove a shared account's final access or rewrite retained evidence just to restart a test.

The fee/advance fixture's guardian starts with one linked pupil. **SMK-05 / GDN-02 require two links**: use the existing two-child attendance fixture, or first create and accept an invitation for a second disposable pupil with the supplied verified guardian account. Check the school and child label before comparing results across roles; fixtures from different schools cannot be compared as the same pupil.

- **Money tests:** run before closing the current **server-displayed IST business day**. The retained advance-credit and fee-change fixtures have their **5 November** cash day closed. Check the new day's actual status before a 6 November or later run; use an open day/disposable fixture. Do not reopen an old close or create a fake extra receipt to make the screen match an example.
- **Debt imports:** use a new unbilled month and fresh eligible opening-balance pupils. An opening balance is additional off-system debt; exclude debt already present in ERP demands.
- **Homework:** the retained homework fixture ends with its teacher assignment removed. Admin must restore the exact class/section/subject assignment before a positive grading run; use Pending Practice or a new task for a new submission.
- **Coverage/promotion:** expiry and session activation depend on actual IST date/session boundaries. Ask engineering for the prepared expired/readback fixture where needed; do not change the computer clock or school calendar to force a Pass.
- **Delivery:** controlled inboxes, the deployment callback allowlist and enabled providers are needed for Google, signup/recovery/email change. The shared demo SMS provider is disabled; its correct unavailable state is testable, carrier delivery is not.

If any prerequisite is missing, mark the dependent case **Blocked** and continue independent read/UI cases.

## Quick smoke — start here

These ten checks are the first pass, not final school acceptance. Keep the current data unchanged where possible.

- [ ] **SMK-01 · SMS login.** Open the deployed URL on laptop and phone. Expect bold uppercase **SMS** with the SMS logo tile (blue ribbon S) beside it, the same tile as the browser tab icon, no graduation-cap badge and no theme control on login. At 1366 × 768 / 1280 × 720 the form and illustration fit; phone shows the form without horizontal scrolling.
- [ ] **SMK-02 · System theme.** Change device/browser color preference to Light, then Dark while login stays open. Login follows it. Sign in as Admin, choose Light/Dark in the dashboard selector and refresh; the manual choice remains. Mobile selector is in More → Workspace menu.
- [ ] **SMK-03 · Role and logout.** Confirm the correct role/dashboard, refresh, then logout. A direct `/dashboard` visit returns to login and previous-user content is hidden. Login again using a different QA role.
- [ ] **SMK-04 · Attendance round trip.** As assigned teacher save a mark on the current IST day for a disposable pupil. Reload the register; as Admin, Student or linked Guardian refresh and compare that same pupil/date/status.
- [ ] **SMK-05 · Guardian child scope.** Switch the guardian between its two linked children and refresh. The selected child/history remains correct; the unrelated pupil is absent.
- [ ] **SMK-06 · Notifications.** Open guardian Notifications, compare All/Unread and the unread count, mark one alert read and refresh. The state persists. A second guardian's read state stays independent.
- [ ] **SMK-07 · Homework.** As Student open an existing own submission/result and its file, then refresh. As the assigned teacher open that task's submissions and compare the saved response/grade. Use detailed homework checks below for a new write.
- [ ] **SMK-08 · Fees and family receipt.** As Finance inspect an existing demand, receipt and outstanding balance. As its Student/Guardian refresh Invoices & Receipts; the pupil, receipt number, original amount and applicable reversal label agree.
- [ ] **SMK-09 · Advance statement.** Compare an existing pupil's available/reserved/applied/refunded credit between Finance and the linked family statement after refresh. No office request/review controls or internal reasons appear in the family view.
- [ ] **SMK-10 · Everyday UX.** At 390 px and laptop size use More, Find a page, child/date selectors and primary actions with touch and keyboard. Labels wrap safely, focus is visible and no action is unreachable. Record confusing copy or unnecessary steps, even when the data is correct.

## Detailed access, setup and import checks

- [ ] **ACC-01 · Role boundaries.** As Student/Guardian open Teaching Assignments and Finance Reports directly; office actions must be denied. As an unassigned teacher open the target class's academic work; authoring/grading is unavailable. Repeat school/child isolation with the supplied other-school account. This UI check does not replace the open database audit work.
- [ ] **ACC-02 · Theme persistence and navigation.** In the dashboard choose System and change the device preference live; navigation and cards follow the same mode. Choose the opposite manual mode, refresh, logout and login again: login follows the device, dashboard restores the manual preference. Check keyboard selection and mobile footer spacing.
- [ ] **ACC-03 · Real providers and recovery.** With a controlled allowed inbox, test fresh invite-account confirmation and Forgot password through the actual email link in the initiating browser. Old password should fail after reset and linked children should remain. Test Google with an allowed QA identity. Record delivery/callback failure as Blocked, not Pass from a simulated response.
- [ ] **ACC-04 · Search, focus and errors.** Find a permitted page with Ctrl/Cmd+K and Enter; an unavailable role's page must not appear. Open/close More with keyboard and verify focus returns. On an open read screen, go offline then reload its data: an error appears instead of false empty/success, and a retry works after reconnecting.
- [ ] **CSV-01 · Students.** Download the Students CSV template, preview two disposable new admissions and import. Refresh and reconcile both class/section mappings. A mixed valid/duplicate or unknown-mapping file must reject the batch without creating the valid row. Retrying an already-imported file must not duplicate pupils.
- [ ] **CSV-02 · Staff and guardians.** Preview/import staff with unique employee IDs, then guardians using exact pupil admission references. Check duplicate email/employee/admission errors and sibling mapping. Refresh the directory/links. Importing a guardian record must not let an arbitrary unverified login claim the child.
- [ ] **CSV-03 · Academic structure.** Import classes, sections and subjects in dependency order from their templates. Inspect preview counts and mappings before confirming, then reload. Duplicate names/codes and an unknown parent class must show useful errors without partial creation.
- [ ] **CSV-04 · Teaching assignments.** Preview assignments mapped to the intended staff member, session, class, section and subject. Missing/duplicate/foreign mappings must fail. After a valid import, the assigned teacher gains only that intended scope; refresh and compare the office assignment list.
- [ ] **ROSTER-01 · Same-session transfer.** On an unmarked disposable pupil, transfer class/section with a reason. Refresh both rosters: same admission number, destination only from the effective date. Older attendance and fee/receipt history still identify the original pupil/session. An already-marked current-day transfer should be blocked.
- [ ] **ROSTER-02 · Promotion readiness.** Stage and revise a disposable pupil's later-session placement; current placement stays active. Check missing-pupil/readiness blockers before activation. Use the prepared completed fixture to inspect activated-session readback if its real date window is not open; verify older attendance and fee history remain. Do not tick a new activation Pass from readback alone.

Details: [imports](POST-DEPLOY-QA.md#staff-and-guardian-csv-imports), [academic imports](POST-DEPLOY-QA.md#classes-sections-subjects-and-teaching-assignment-csv-imports), [placement/promotion](POST-DEPLOY-QA.md#same-school-transfer-and-session-promotion).

## Attendance, guardian access and notifications

- [ ] **ATT-01 · Save, discard and refresh.** On today's assigned register set one pupil Present and another Absent, save and refresh. An untouched pupil remains Unmarked. Make another unsaved change, discard/reload and confirm the saved status returns. Re-saving unchanged state must not create duplicate absence alerts.
- [ ] **ATT-02 · Historical correction.** Teacher requests a past-day change with a reason; the existing mark stays until a different eligible Admin/Principal approves with a reason. Verify original/new values in history and the family readback. Reject another request and confirm no attendance change; a requester cannot approve their own request.
- [ ] **ATT-03 · Cutoff and stale draft.** Configure the demo school's cutoff with an audit reason and compare partially marked/complete section progress after refresh. For a stale attendance/correction draft, have a second session save/review a newer state: the old action should conflict, retain useful input and require explicit reload rather than overwrite.
- [ ] **GDN-01 · Invite boundaries.** Create a guardian invite for one active disposable pupil and the exact verified guardian email. Wrong-account acceptance, an older replaced link and replay must fail; the latest valid acceptance links only the intended child and persists after refresh. Share tokens privately.
- [ ] **GDN-02 · Revoke and re-invite one child.** Remove one of a guardian's two child links with a reason. In the already signed-in guardian session, refresh: that child and its alerts disappear while the sibling/other guardian links remain. Re-invite through the dedicated flow and accept; original attendance history returns without new marks. The old link cannot restore access.
- [ ] **GDN-03 · Read state and verified contact.** Confirm an absent child's eligible guardians receive one in-app alert, each with independent read status. Mark all as read while Unread is selected; refresh and compare count/All history. On a disposable guardian, verify both inbox confirmations for email change preserve accepted child links and invalidate old pending invitations. When demo SMS is disabled, contact settings must explain verification is unavailable instead of claiming a sent code.

Details: [attendance/cutoff](POST-DEPLOY-QA.md#school-attendance-cutoff-and-daily-register-progress), [revoke/re-invite](POST-DEPLOY-QA.md#revoke-and-re-invite-a-guardian-for-one-child), [notifications](POST-DEPLOY-QA.md#guardian-notifications-filters-and-mark-all-as-read), [recovery/contact](POST-DEPLOY-QA.md#guardian-recovery-and-verified-contact-changes).

## Substitute coverage

- [ ] **SUB-01 · Scheduled and active access.** Admin/Principal assigns a different same-school teacher to an existing class-teacher register with an inclusive date range and reason. Reload. Future coverage grants no current register; active coverage grants the labelled covered register and saves today's mark after reload.
- [ ] **SUB-02 · Revoke live.** Revoke the active coverage with a reason. In the substitute's existing session refocus/refresh: temporary access disappears, new reads/saves fail and the original teacher still sees the saved mark. Revocation history retains the reason.
- [ ] **SUB-03 · Expiry and scope.** Use the supplied expired fixture: the substitute has no effective register beyond its end date. Another section/date/school remains inaccessible. Attendance-only coverage must not grant homework, study-material authoring, pupil admission or historical correction rights.
- [ ] **SUB-04 · Invalid and duplicate assignments.** Try overlapping coverage, an unrelated-school substitute and repeating the same request. Expect validation or the one retained result, without duplicate grants. On a disposable source assignment, remove/change it and confirm its coverage becomes Invalid without widening access.

Details: [substitute coverage](POST-DEPLOY-QA.md#substitute-attendance-coverage). Expiry checked from an already-expired fixture is not proof of an observed midnight rollover.

## Homework and private files

- [ ] **HW-01 · Publish and submit.** Assigned teacher creates a fresh homework item with maximum 10 marks in the exact class/section/subject. As Student One submit text plus a real PDF/JPEG/PNG up to 10 MiB. Refresh: one Submitted response and the original file are downloadable.
- [ ] **HW-02 · Validate and isolate.** Empty/unsupported/oversized or header-mismatched files must show errors. Student Two must not see Student One's response/file; a linked guardian is read-only. An unrelated teacher cannot open/grade these responses, and submitted attachments cannot be overwritten or removed.
- [ ] **HW-03 · Grade round trip.** Assigned teacher reads/downloads the actual response and saves 8/10 plus feedback. Refresh teacher and pupil pages: the same grade/feedback returns and the graded response is read-only. Over-maximum/negative marks fail; a task without maximum marks supports feedback-only grading.
- [ ] **HW-04 · Stale work and revoked assignment.** In two sessions keep an older grade/submission draft, save a newer version and try the stale one: conflict, draft retained, no silent overwrite. Remove only a disposable source teacher assignment; current grading/file access must stop while own pupil/linked guardian history remains. Move a class-subject assignment to another teacher: the new teacher must see and grade the earlier published homework (not edit it), and the old teacher must be denied. Check long filenames and controls at 390 px.

Details: [homework UI](POST-DEPLOY-QA.md#homework-submission-and-grading-ui), [academic permissions](POST-DEPLOY-QA.md#academic-authoring-permissions). Downloaded bytes cannot be recalled from a device.

## Fees, batches, collections and readback

Use separate disposable pupils for ordinary fees, adjustments and the advance-credit example, so one test's balance changes do not invalidate another's starting assumptions. Record starting amounts before each group. All entries below are synthetic demo accounting records; no real funds transfer is needed or initiated.

- [ ] **FEE-01 · Baseline and fee scope.** Finance selects the exact school/session/pupil and inspects fee structures, issued demands, paid/outstanding amounts and the paged ledger. Reconcile the whole selected scope, not just visible rows. Teacher, Student and Guardian must not get office posting actions.
- [ ] **FEE-02 · Monthly batch.** Preview a new unbilled month with an explicit due date, then narrow by section and review counts/amounts. Preview alone posts nothing. Confirm and reload; previewing the same month again shows existing demands without charging twice. A pupil moved to another class mid-month shows as already billed in the new class's preview for the same fee head (e.g. Tuition Fee) that month, while a different head (e.g. Transport) still bills once; 'Other' fees are never treated as duplicates. A changed fee/roster preview should require fresh review.
- [ ] **FEE-03 · Opening debt.** Upload `admission_no,amount` for fresh eligible pupils with source/reason and an as-of date up to today. Duplicate/unknown admissions and invalid money reject the whole batch. Confirm valid additional off-system debt: demands increase but receipt count/cash do not. A repeat retains the original opening debt.
- [ ] **FEE-04 · Office collection.** On an open day open Record payment, search the pupil, pick the demand by admission no./billing month/due date (nothing is preselected), enter a partial synthetic payment, press Save payment, inspect the review of pupil/admission no./fee/period/method/amount, then Confirm and save and hard reload. A multi-school finance user picks the school with the Finance school selector on Fees, Invoices & Receipts and Finance Reports. Collect the remaining balance with a different method/reference where supported. Each real posting has one receipt and the fee moves Partial → Paid correctly.
- [ ] **FEE-05 · Invalid and uncertain results.** Try zero/negative/over-precision/over-balance payment input; no money/receipt should post. With engineering assistance, drop the response to one committed operation, reload the same tab and use its saved exact retry. It must recover the one original receipt/batch, not create a new payment. Do not submit a fresh payment just because success was unclear.
- [ ] **FEE-06 · Family and totals.** Hard reload Fees, Finance Reports, Admin dashboard and Student/Guardian Invoices & Receipts. Receipt numbers/original amounts, applied payments, opening labels and outstanding agree. Office Invoices & Receipts rows and receipt detail show each receipt's fee head and billing month (Fee · period), matching the family receipt. Print / Save as PDF one receipt and one invoice and download each as CSV; confirm only that document is printed and it shows the school name, pupil, admission no., fee, period, amounts and IST date. Other pupils' data and private office notes/tokens must be absent from the family view.

Details: [batch/opening balance](POST-DEPLOY-QA.md#fee-batches-and-opening-balances), [office/family](POST-DEPLOY-QA.md#office-and-family-qa).

## Approved fee changes and recorded-entry reversals

- [ ] **CHG-01 · Independent review.** Request a reduction/additional charge with a clear reason. Pending requests do not alter the balance. Requester/self-review is denied; a different Admin/Principal approves with a review reason. Reload: one adjustment updates effective dues while retaining the original demand.
- [ ] **CHG-02 · Reject invalid changes.** Reject a pending proposal and verify no balance/cash effect. A reduction below credited payments or beyond outstanding, invalid precision and a fee from another pupil/school must not post. Review history retains actor/reason/outcome.
- [ ] **CHG-03 · Full recorded-payment reversal.** On an eligible disposable original receipt, request its full reversal and obtain independent approval on an open day. One counterentry reopens the effective balance; the original receipt and its old closed day remain unchanged. A second reversal fails. This corrects accounting and does not send money back to a bank.
- [ ] **CHG-04 · Stale review and recovery.** Keep a proposal open, post another valid payment against its fee, then try the old review. Expect conflict and retained reason, not approval. Refresh, reject the obsolete proposal and create a new one. With engineering help, recover a dropped successful review through the same saved retry and verify one adjustment/reversal.

Details: [fee changes/reversals](POST-DEPLOY-QA.md#approved-fee-changes-and-payment-entry-reversals).

## Advance credit and unused-credit refunds

For the numbers below, start with a **fresh zero-credit pupil and a separate unpaid ₹1,000 demand**. Run ADV-01 → ADV-05 in order, using unique synthetic references. Existing retained fixtures have different final balances; they are readback examples, not a reset starting point.

- [ ] **ADV-01 · Receive once.** Finance records a ₹1,000 demo advance with method, unique proof/reference and reason, then confirms. Refresh: ₹1,000 available, no fee settled and one money receipt. Reusing the normalized proof for a new entry is denied; an exact retry returns the saved entry.
- [ ] **ADV-02 · Allocate without new cash.** Apply ₹600 to that pupil's ₹1,000 demand. Refresh: available credit ₹400, net allocated ₹600 and fee outstanding ₹400. Cash/receipt count stay unchanged. Excess credit, excess fee allocation and another pupil's demand must fail.
- [ ] **ADV-03 · Reserve, then record payout.** Request a ₹150 unused-credit refund; a different Admin/Principal approves. Before payout expect ₹250 available + ₹150 reserved, with no cash outflow. Record only a synthetic completed offline payout in the demo using its unique proof: reserved becomes ₹0, available/held ₹250 and refunded ₹150. The app must not launch a gateway or claim it transferred funds.
- [ ] **ADV-04 · Return an allocation.** Request return of ₹100 from the original ₹600 allocation and get independent approval. Refresh: available ₹350, net allocated ₹500 and fee outstanding ₹500; refunded stays ₹150. The original allocation/receipts remain, a return references it and cash does not change. Over-return must fail.
- [ ] **ADV-05 · Cancel and family readback.** Request/approve a separate ₹50 refund, then cancel it before payout with a reason. Reservation releases; available returns to ₹350, reserved ₹0, no payout/cash effect. A completed payout cannot be cancelled. Student/Guardian hard reload shows the correct own-pupil totals/activity without office reasons or actions; sibling switching must not mix statements.

Details: [advance credit/refunds](POST-DEPLOY-QA.md#student-advance-credit-and-offline-refunds). Engineering-assisted exact-retry, competing reservation and private-table tests are in the comprehensive checklist. Do not simulate real money movement to repeat them.

## Reconcile and close — run last

- [ ] **DAY-01 · Reconcile all money.** Compare the ledger, receipts, advance journal, refund/reversal entries and Finance Reports for the same school/day. Cash equals cash fee/advance receipts minus cash book reversals and recorded cash refunds. Allocations, allocation returns, approval/reservation and cancellation add no new cash receipts. Earlier closed-day totals remain unchanged.
- [ ] **DAY-02 · Reject a stale close.** Finance enters counted cash/note and keeps the close review open. Another authorized session records a valid synthetic cash event. The cached close must conflict, retain the input and leave the day open. Refresh, recount and complete both confirmation steps; hard reload shows one close. Explain any variance in the note.
- [ ] **DAY-03 · Closed-day guard.** After close, try a new collection or a prepared unpaid refund payout: posting must fail without a new entry/cash event. An approved unpaid refund reservation remains until legitimately cancelled; do not pay real money to test this. Identical retries of operations already completed before close still recover their original results.

Details: [day-close conflict recovery](POST-DEPLOY-QA.md#attendance-and-fee-conflict-recovery), [settlement boundary](FEE-SETTLEMENT-BOUNDARY.md).

## Record problems and make the decision

For each failing/blocked case, record exact steps and visible feedback. Use screenshot/video where useful, after hiding private emails, invitation links and account details. **Fail** means the expected behavior was wrong. **Blocked** means the account, fixture, provider or date prerequisite was missing. An engineering-assisted race not run is Blocked/Pending, not Pass.

| Case ID | Pass / Fail / Blocked | Role + route + device | Steps, expected vs actual, evidence |
|---|---|---|---|
| | | | |

| Founder decision | Result / owner / next action |
|---|---|
| Core workflow usability | |
| Incorrect data or cross-account exposure | |
| Fee/credit reconciliation | |
| Phone/keyboard/theme usability | |
| Google and actual inbox/carrier delivery | |
| School fee policy, receipt/report formats and pricing | |
| Critical engineering audit findings closed | Pending engineering verification |
| Real-school pilot approval | Pending — requires scope, data agreement and critical-fix sign-off |

This release does not connect a payment gateway. Historical advance import, partial refunds of ordinary legacy receipts, a restorable database baseline and full commercial-module acceptance remain separate work. Do not treat placeholder/demo department screens or untested PRD requirements as delivered school-ready features.
