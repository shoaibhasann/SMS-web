# Student leave requests — Production release QA

**Hosted rollout update · 6 November 2026:** the requested nine migrations plus two verified HTTP/performance fixes are now applied, with exact recorded-source hashes in the verified engineering rollout ledger. Use [the stable Production founder checklist](/qa/production-founder-checklist.md) for the matching frontend release. The dated local evidence below remains historical; it is not a new hosted acceptance claim.

6 November 2026 · Production release checklist · Hosted rollout/founder confirmation pending

Use the stable Production URL recorded in [the current release checklist](/qa/production-founder-checklist.md) after the full SQL/frontend release is verified on `main`. Passwords and share secrets stay in the private handoff. Use synthetic students and dates within their current academic year; leave reasons can contain sensitive information.

## Release prerequisite

The operational release requires the complete **nine-migration chain** in manifest order, from `20261105184935_freeze_legacy_client_mutations.sql` through `20261106092647_reviewed_assessment_results.sql`, and its matching frontend. The leave migration is `20261106065206_governed_student_leave_requests.sql`; it is not the final chain step. Hosted rollout remains unconfirmed in this checklist until the release record verifies it. An older schema must show an update-required error; there is no browser-demo or unsafe table-write fallback. [Recovery commands and limitations](../../supabase/recovery/README.md).

Use a same-school Guardian, its linked Student, and an independent Admin/Principal. Include a second linked child, an unlinked child, another school and a mixed Teacher/Guardian account. Record the deployment revision before testing. **Leave approval records a decision; it does not mark attendance or change fees.** Existing Staff Leave remains separate.

| Field | Founder entry |
|---|---|
| Stable Production URL and `main` revision | Pending release confirmation |
| Tester, date, browser and device | |
| Overall result | Pending |

## Founder flow

- [ ] **SL-01 · Submit and refresh.** Guardian → **Leave requests** → select the intended child. Enter ordered dates and a reason of 3–1,000 characters. Submit once. Expect one Pending review item with the pupil, admission number, original class/session, dates, reason and requester. Reload the browser: the same item remains. Repeat with the Student login; only its own history appears.
- [ ] **SL-02 · Independent approval.** Admin/Principal → **Leave requests**, choose the authorized school and Pending review. Open the request, add a review reason and approve. It leaves the pending filter. All requests/Approved shows the decision, reviewer, reason and timestamp. Guardian and Student refresh: both see the same Approved record. Check the attendance register and fee balance: both are unchanged.
- [ ] **SL-03 · Rejection.** Submit a separate non-overlapping request and reject it with a reason. Refresh both office and family views. The rejection remains visible; a new request for those rejected dates is allowed. Neither final decision can be edited/reversed through this flow.
- [ ] **SL-04 · Duplicate/overlap.** Double-click submit and retry after a simulated connection loss. The same unchanged request produces one record. A second pending or approved request that shares even one date is rejected, including requests by another linked guardian or the Student. Adjacent non-overlapping dates are allowed. A changed payload cannot reuse a previous request reference.
- [ ] **SL-05 · Validation and recovery.** Try an empty/too-short reason, reversed dates and dates outside the current academic year. Expect validation without a saved record. Go offline during submit/review: keep dates/reason and show an unconfirmed outcome. Go online and retry the unchanged action or refresh saved history; do not assume the first write failed. Error states must not look like an empty successful list.
- [ ] **SL-06 · Child/school boundaries.** Switch between linked siblings and refresh. Each history stays with its child. Wrong child/school IDs must not reveal reasons or permit submission/review. Teacher, Finance and unrelated accounts cannot open office review. A mixed Teacher/Guardian reaches family history using `?view=guardian`; Teacher finance permissions remain unchanged.
- [ ] **SL-07 · Revocation and account state.** Revoke one child's guardian link, then refresh linked students and history. That child disappears and direct requests are denied. Independently linked siblings/other guardians still work; the office retains the original request. Disabled, banned, unverified or role-removed accounts cannot submit/review; an account cannot approve its own request even if it also has an office role.
- [ ] **SL-08 · Competing reviewers.** Open one pending item as two authorized reviewers. Submit conflicting decisions. Exactly one final decision remains; the other reviewer sees a conflict and retains the note until reconciliation. Retry the same saved decision by its original reviewer: no second review is created. Native concurrent PostgreSQL acceptance is still pending, separate from serial local tests.
- [ ] **SL-09 · Historical placement.** Submit before a class move/promotion, then change placement using the existing roster flow. Old leave still shows its original class/session. Withdrawing the pupil blocks new requests while currently authorized family/office history remains. Revoking a guardian never deletes requests, attendance or fee history. School post-withdrawal retention/access policy still requires sign-off.
- [ ] **SL-10 · Phone, keyboard and pagination.** At 390 px and laptop widths, complete child selection, dates, reason, submit and review. No horizontal page overflow; labels/focus, readable status text, light/dark themes and disabled saving controls work. Next/Previous pages and All/Pending/Approved/Rejected filters preserve school/child scope. Refresh after paging and an error recovers correctly; delayed old-scope responses cannot replace a new child/school.
- [ ] **SL-11 · Existing flow regressions.** Mixed Teacher/Guardian → Receipts retains guardian scope through desktop/mobile navigation and search. Teacher-only login gains no invoice route. Dashboard upcoming-exam counts include the seventh day across month/year boundaries and browser timezone changes.
