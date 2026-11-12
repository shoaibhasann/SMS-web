# Family notifications — implementation and QA

6 November 2026 · Notifications v2 · Founder acceptance pending

Use the single [SMS Production login](https://sms-web-shoaibhasann.vercel.app/login). The stable hostname alone does not prove this frontend revision is deployed. Record its commit/deployment below before running the founder checklist; no Preview URL is required.

## 9 November update for exam schedules

The v8 web inbox adds **Exam scheduled** and **Exam schedule updated** for the Student and their eligible linked Guardians. **Exam schedule** also lists existing upcoming assessments for the current academic year; the migration does not backfill alerts. An exact link opens only the live scheduled assessment. The page shows the date, subject, class, section and instructions. Marks stay in the separate result workflow.

A no-op save or marks-only edit preserves each recipient's read state. A change to visible schedule details creates a new unread revision; marking the old alert cannot mark the new one. A class-wide exam can match multiple siblings but appears once in a Guardian's inbox. Completed, elapsed and out-of-scope assessments are hidden, and removing the only qualifying child link removes access.

Local recovery and UI tests cover Teacher/Admin writes, both family roles, role and school isolation, siblings, rescheduling, completion, exact links, existing schedules, paging and independent reads. All 3,659 tests, lint and the production build passed.

Hosted migration `20261109153905` matches the repository SQL. Rollback-only hosted QA passed Teacher save, both family roles, wrong-section denial, separate reads, no-op save, reschedule, completion and v7 parity. All eight existing assessments and 55 marks were unchanged; no QA events, receipts or sessions remained. Anonymous HTTP requests to all six new RPCs returned permission denied. Use [FN-28 to FN-30](../../public/qa/family-notifications-checklist.md#exam-schedule-alerts) for browser acceptance. Native push delivery for exam schedules is pending.

## 9 November update for fee payment confirmations

The v7 web inbox adds one confirmation per newly recorded receipt for the Student and currently linked Guardians. Each recipient and role has a separate read state. An approved reversal changes the original item's status and shows the original receipt and effective recorded amount.

Hosted migration `20261109152742` matches the repository SQL. Rollback-only QA exercised the governed payment, retry, independent reversal approval and family readback. Synthetic timestamps were aligned with the management SQL clock within the same business day. The ledger comparison covered 3,587 demands, 17 payments, reversal and change requests, and fee-day records. All 3,643 repository tests, lint and the production build passed. [FN-25 to FN-27](../../public/qa/family-notifications-checklist.md#fee-payment-confirmations)

## 9 November update for fee due reminders

The v6 web inbox lists one item per eligible due or overdue fee demand, using the India calendar date. Each item sorts at the later of midnight India time on its due date and the demand's creation time (migration `20261111220400`), so a demand created after its due date appears at the top as new. The exact detail shows the pupil, fee, due date and current outstanding balance from the same calculation as the fee ledger. Each recipient and role has its own read state. When a fee settles, the item disappears. If the same demand becomes outstanding again, its prior read state returns.

Hosted migration `20261109144911` matches the repository SQL. Rollback-only QA verified family scope, partial payment, settlement and restored read state after rollback. The hosted ledger comparison covered 3,587 demands, 17 payments, adjustments, credit entries and reversals. The local suite also exercised payment reversal and advance allocation. All 3,626 repository tests, lint and the production build passed. [FN-22 to FN-24](../../public/qa/family-notifications-checklist.md#fee-due-reminders)

## 9 November update: homework assigned

Publishing section homework adds one item per eligible account and role to the v5 web inbox. A Guardian with multiple children in the section sees it once. Drafts, older homework and previous placements do not create alerts. The exact link rechecks the current pupil or Guardian scope. Students can use the existing submission panel, and Guardians see read-only details.

Hosted migration `20261109144029` matches the repository SQL. Rollback-only hosted QA passed exact Student and Guardian detail, draft and section exclusion, independent reads and v4 compatibility. All 15 academic logs and 32 activities were unchanged afterward. Local Teacher draft → publish, access denial and submission UI tests passed, as did all 3,609 repository tests, lint and the production build. [FN-19 to FN-21](../../public/qa/family-notifications-checklist.md#homework-assigned) cover browser acceptance. Native push is outside this release.

## 9 November update: school announcements

New notices appear at publication in the v4 Student and Guardian web inbox for their current audience. Each recipient and role has independent read state. Opening a notification rechecks the exact notice, expiry and current access. The release adds no historical backfill or external delivery, and earlier inbox versions are unchanged.

Hosted migration `20261109142815` matches the repository SQL. The seven existing notices and the v3 inbox definition are unchanged. A rolled-back hosted check exercised Admin publication, both family roles, section/role isolation, exact detail and independent reads; no fixture sessions or rows remained. The full local suite passed 3,593 tests and the production build passed. Use [FN-16 to FN-18](../../public/qa/family-notifications-checklist.md#school-announcements) for browser acceptance.

## Included behavior

Student and Guardian Notifications share a read-only event inbox with independent recipient read state. A verified eligible Student sees its own published result and approved/rejected leave events. Each currently eligible linked Guardian receives its own corresponding events. Guardian absence alerts remain in the same inbox with their original IDs and read timestamps; this phase does not add student absence alerts.

Events are created by the saved publication/leave decision, not by opening a page. Pending leave and pending/rejected result-publication requests produce no event. Repeating the same finalized action must not duplicate recipient events. Decision and event writes are one transaction: a failed recipient write rolls the source decision back as well.

All/Unread filtering occurs on the server before keyset pagination. Full pages contain at most 30 notifications; the summary asks for five. **Older notifications** replaces the current page; **Latest notifications**, Refresh, filter changes and foreground refresh return to the latest authorized page. Marking one notification read refetches the current page (an Older page stays where it is); **Mark all as read** returns to the latest page. The unread count covers the entire eligible inbox, including unread rows beyond the current page. Individual read and atomic **Mark all as read** use recipient/role-scoped RPCs; the bulk action is not a client loop over loaded rows.

The Student/Guardian header bell is available on desktop and mobile. A successful mark broadcasts only a user/role-scoped refresh hint: the inbox and bell independently refetch saved counts. Focus/visibility refresh, cancellation and account/role-keyed component state prevent late old-context responses from restoring another account's UI. A browser-provided count is never trusted.

## Target links and authorization

Links are constructed locally from validated fields, never from an arbitrary database URL. Guardian links retain `view=guardian`, including mixed-role accounts.

| Event | Destination scope | Required behavior |
|---|---|---|
| Guardian absence | Attendance with exact linked `child` | Open that child's retained attendance history; never substitute the first sibling. |
| Result published | Results with exact `child` and `assessment` | Use the bounded exact-target reader, even when the assessment is older than the first 50 normal history rows. Show that pupil's latest published revision for the assessment, including a valid zero mark. |
| Leave approved/rejected | Leave requests with exact `child` and `request` | Use the bounded exact-target reader, even beyond the first 50 history rows. Show the reviewed request, not a newer unrelated request. |

Changing child, assessment, request, role or school parameters must recheck current database authorization. An unavailable/foreign target must show unavailable/access-changed state without falling back to another child's data. Superseded result revisions disappear from the eligible inbox; their stored read timestamps remain retained, and a later rejected publication request does not hide the latest published revision.

Current eligibility is checked at event time and again on every read/write. Revoke one child link, remove the relevant role, disable the profile, invalidate the native session or use an unverified account: the affected API access must be denied. Other eligible siblings/recipients keep their access. A role-bearing JWT cannot override current database role/session state. Anonymous callers, unrelated school/recipient accounts and direct private table/helper access are denied. No peer marks, private reason/review note or raw internal event payload is included in the notification summary.

## Rollout and retained history

The local migration is `supabase/migrations/20261106144905_family_notification_inbox.sql`; the applied hosted migration version is **`20261106150230`**. Its exact source SHA-256 is **`e7da66dbae68b24228446c2e487259b2f02dac5e72c594fd5472d5bcbafc2914`**, matching the local SQL and recovery manifest.

The hosted pre-apply safety backup covered **7 tables, 1,405 rows and 4 routines**; its private restoration check completed. The pre/post source-row comparison was identical and the new notification table was empty immediately after migration. These checks establish additive application and source preservation; they do not establish browser acceptance or concurrent hosted Auth behavior.

There is deliberately **no historical result/leave notification backfill** and no retroactive delivery to a newly linked Guardian. Existing published results and leave history remain accessible through their authorized modules. Only new qualifying saved decisions create new event rows. Legacy guardian absence rows and their original read state remain available through the union. Attendance, fees, marks and source leave/publication records are not rewritten to fill the inbox.

## Verification ledger

| Check | Status | Evidence/limit |
|---|---|---|
| Additive recovered-schema database tests | PASS — 15 cases | Real PostgreSQL-engine assertions in local PGlite: migration over existing decisions, no backfill/history mutation, exact recipient delivery, transaction rollback, role/session/school/revoke denial, independent reads, atomic bulk read beyond 100 rows, tied-key pagination, exact targets and latest result revisions. Serial local tests are not simultaneous native-connection proof. |
| New client/deep-target tests | PASS — 20 cases | Server filter/cursor parameters, strict response validation, safe links, exact result/leave mapping outside the first history page and error handling. |
| Inbox/bell/AppShell UI tests | PASS — 53 cases across 3 files | Mixed five-row summary, own role/mobile header, server filtering, replacement pages, read persistence, bulk counts, scoped cross-component refresh, failed writes and stale/account-change requests; existing shell/account behavior retained. |
| Focused UI/DB lint | PASS | No new dependency or global notification provider. |
| Full repository test/lint/typecheck/build/recovery rerun | PASS | 1,867 tests/142 files passed, including target-mode leave-submit guidance. Whole-project lint and optimized Next build including TypeScript pass. Recovery has 84 sources/14 patches,106 tables/five views. An empty notification status region is no longer rendered while its count is loading. |
| Hosted migration/source preservation | PASS | Hosted version/hash and additive pre/post checks above. |
| Hosted new-event and read-state preservation QA | PASS | Exactly 2 new one-day leave decisions and 1 new assessment/11 complete marks including zero → Teacher request → independent Principal publish. Retries deduplicate, recipients/role/foreign/sibling/anonymous calls isolate, exact target/filter/cursor/count checks pass. Original source/attendance/fee/payment/link/absence read-state fingerprints are unchanged. Only new event read fields were exercised. All8 owned native SDK Auth sessions were closed locally. |
| Native/browser Student + Guardian flows | PASS for recorded scope | Local browser: Guardian exact result18/20 + approved leave survive reload; marking only the new result changes count5→4 and persists. Student own inbox remains3read/0unread. Production: separate Student and Guardian logins show the same independent state; Student result18/20 survives hard reload; Guardian4unread survives hard reload and its approved link opens the exact reviewed request. No Production school writes were needed for browser readback. Live revoke/relink, >50 history and simultaneous connections remain unverified on shared founder fixtures. |
| Native concurrent publication/mark-all/session races | PENDING | Do not infer simultaneous-connection behavior from serial local tests. |
| `main` Production deployment | PASS | Feature source `dbf12d642adc82e1e03037c04bbf4a00a3103af4`, deployment `dpl_4cucpHfpWhvSsSPLzprqzCEzShSk` Ready and assigned the stable alias. Public checklist HTTP200 bytes match source. Subsequent documentation-only commits retain this feature source. |
| Founder/manual acceptance | PENDING | Every founder box remains unchecked in [the public checklist](../../public/qa/family-notifications-checklist.md). |

## QA procedure and data preservation

Use synthetic records and existing private QA credentials; do not put passwords, tokens, emails, private backup paths or privileged SQL results in public documents. For the remaining manual isolation scenarios, prepare two eligible linked Guardians for one child, an independent sibling link, the child's Student account, an unrelated child/school and an office reviewer. Use fresh disposable recipients for destructive-to-unread-state acceptance where practical.

The engineering run preserved original shared unread fixtures by marking only events created in this phase. Before further tests marking shared QA notifications, privately capture the exact existing recipient IDs, kinds and `read_at` values across both legacy absence alerts and new events. Preserve that baseline after the run: restore only the intended QA read fields through the controlled engineering procedure and compare exact values/row membership. Do not bulk-clear historical read timestamps or delete school source records. If safe restoration is unavailable, keep shared unread fixtures untouched and use disposable synthetic recipient/event fixtures instead. Founder results must state whether the shared baseline was preserved.

1. Save a new approved leave, a separate rejected leave and a new reviewed result publication. Check both intended family recipient views and independent read state; pending/rejected publication requests must not appear.
2. Reload each recipient's browser and compare own rows, count, bell and exact target details with the saved source. Test both siblings; mutate URL references to exercise denial without exposing another child.
3. Use a prepared history with more than 50 result/leave sources and more than 100 eligible unread notifications. Test exact older targets, Older/Latest pages, tied timestamps, server Unread and one atomic Mark all beyond the loaded page. Mark Blocked if a required browser fixture is absent; local fixture evidence does not tick a founder box.
4. Mark one item for Guardian A. Guardian B and Student must retain their own state. Bulk mark A, refresh/reopen and recheck every other recipient. Restore the engineering read baseline afterward and verify parity privately.
5. Revoke one child link, refresh/focus and retry that child's inbox/mark/target requests. Deny the revoked scope immediately while retaining sibling history and school source records. Check account switch/sign out during delayed reads/writes; no late response may restore the old data or badge.
6. At 390 px and laptop width, test keyboard focus, All/Unread, paging, deep links, skeletons, errors, light/dark and refresh. A failed write must retain the saved count until a verified server read; an uncertain save is reconciled by refresh.

This slice provides **in-app notifications only**. It does not send SMS, OTP, push or email, enable a provider, add a paid delivery fallback, expose notification editing or promise background polling. Hybrid authentication/provider work remains a separate capability.

| Release field | Recorded value |
|---|---|
| Stable URL | https://sms-web-shoaibhasann.vercel.app/login |
| Verified feature commit / deployment ID | `dbf12d6` / `dpl_4cucpHfpWhvSsSPLzprqzCEzShSk` · Ready; same stable alias |
| Full checks and browser/native evidence | 1,867 tests/142 files; lint/types/optimized build; native SDK flow + two-role local/Production readback above |
| Shared QA read-state restoration/parity | Original absence IDs/read_at unchanged; deliberate new-event read states retained for demo |
| Founder acceptance / outstanding cases | PENDING |

## Preserved demo and founder starting state

The last global comparison retains all original1,405rows unchanged:20legacy absence alerts,1,307attendance rows,18student fees,16payments,34guardian links and the original5leave/5publication rows. New QA adds2leave decisions and1publication; original school records and original read timestamps remain identical. No whole-project/native managed-service restoration is implied.

Use the existing private Fee Credit Student and Guardian accounts. The new result is titled `SMS-NOTIFICATIONS-V2-QA-20261106 · published practice` (own target18/20); the new leave dates are9November approved and10November rejected. Guardian starts with6events/4unread after the deliberate new-result read, including all3original absence alerts still unread. Student starts with3events/0unread after the new-event-only bulk test. Counts may change as the founder tests; these are the recorded engineering starting values.
