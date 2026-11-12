# Reviewed assessment results — Production release QA

**Hosted rollout update · 6 November 2026:** the requested nine migrations plus two verified HTTP/performance fixes are now applied, with exact recorded-source hashes in the verified engineering rollout ledger. Use [the stable Production founder checklist](/qa/production-founder-checklist.md) for the matching frontend release. The dated local evidence below remains historical; it is not a new hosted acceptance claim.

6 November 2026 · Production Ready · Founder/manual acceptance pending

Use [stable SMS Production](https://sms-web-shoaibhasann.vercel.app/login), deployed code `2dfb1e26` (`dpl_Hn7b55aj4ThnjDC1tykBJAGxHP1J`), and [the current release checklist](/qa/production-founder-checklist.md). The complete **eleven-patch chain** is applied and source/history verified: nine requested migrations plus two hosted-QA fixes, from `20261105184935_freeze_legacy_client_mutations.sql` through `20261106110537_bound_assessment_publication_candidates.sql`. This feature began with `20261106092647_reviewed_assessment_results.sql`; the two later patches correct stale-mark HTTP conflicts and bound the teacher candidate query. Founder/manual acceptance remains pending. Missing RPCs on a mismatched environment must fail visibly. Credentials/share secrets stay private. Use the SMS brand guidance in [the Production founder checklist](/qa/production-founder-checklist.md) for visual acceptance.

## Flow and boundaries

Teacher enters marks in **Exam / Marks**, then opens **Published results** → chooses its own currently assigned assessment → previews every eligible pupil → **Request publication**. The source must be completed, fully marked and coherent with the current roster. Zero is a valid score; an unmarked pupil is not zero. A request freezes a private snapshot.

An independent Admin/Principal chooses its school, opens the snapshot and supplies a reason to publish or reject. The requester and anyone who entered the captured marks cannot review their own work. Only publication exposes each pupil’s own saved result to the Student and currently linked Guardian. Families see the latest published revision of an assessment, with the original class/session labels, score, remarks, publisher and date; no peer roster, rank, private review reason or raw mark identifiers.

| Record | Founder entry |
|---|---|
| Stable Production URL / deployed code / migration check | [SMS login](https://sms-web-shoaibhasann.vercel.app/login) · `2dfb1e26` · all 11 patches source/history verified |
| School, assessment and separate reviewer | |
| Student / guardian accounts and test date | |

## Founder checklist after rollout

- [ ] **RP-01 · Complete source.** As Teacher, prepare a completed assessment with a full valid roster, including one explicit score of 0. Preview every pupil, class/section/subject/session, maximum marks and remarks. Leave one mark missing or use a scheduled assessment: show issues and block submission. Restore the missing mark and explicitly refresh the preview before requesting.
- [ ] **RP-02 · Request and reload.** Request once, reload and open My publication requests. Confirm one Pending review snapshot with unchanged scores and labels. Student/Guardian must still see no result for it. Double-click or retry an unconfirmed identical request: keep one outcome and its request reference, not duplicate submissions.
- [ ] **RP-03 · Independent review.** In a different authorized Admin/Principal account, choose the correct school and open the request. Read the complete frozen roster, add a 3–1,000 character reason and publish. Reload office and Teacher: status, reviewer and decision persist. Requester/marker self-review must deny, even if that account also has an office role.
- [ ] **RP-04 · Own family result.** Login as Student and Guardian, open Published results and reload. Confirm only the own/currently linked pupil’s score, remarks and original assessment labels. No classmates or private school review notes. A mixed-role Guardian uses `/modules/published-results?view=guardian`. Refresh linked students after changing links.
- [ ] **RP-05 · Print.** Print this result. Confirm only that pupil’s assessment appears with score, revision and publication details; the assessment date and publication time read like the on-screen card (for example 6 Nov 2026, 1:00 am IST), never a raw ISO timestamp. If the browser blocks the window, show the explicit popup message. Names/remarks containing HTML-like text must print as text. Printing does not create a stored PDF or public file link.
- [ ] **RP-06 · Changed source.** Preview/request, then change a mark, assessment or roster before the next action. A stale request/publication must fail with `PT409`, preserve the saved snapshot and never publish silently changed marks. A stale pending snapshot may be rejected, or its requester may cancel it with a reason, refresh the source and submit again.
- [ ] **RP-07 · Reject, cancel and retry.** Reject a pending request; confirm the private reason and terminal state survive reload. Separately cancel as the original Teacher requester. Identical terminal retries return the same outcome; a different decision/reason cannot rewrite it. A removed assignment does not prevent an otherwise active original Teacher requester from cancelling their own pending request.
- [ ] **RP-08 · Revised publication/history.** Correct a source mark after publication, request a fresh independent review and publish the next revision. Family sees the latest revision only; the prior published snapshot stays immutable private history. Promote/transfer the pupil and verify the saved original labels and published history remain correct; do not reconstruct history from today’s class.
- [ ] **RP-09 · Access loss.** Revoke one guardian-child link and refresh: that child’s results deny while another valid linked child remains accessible. Remove roles/disable accounts, test unrelated children/schools and delayed responses from a previous session: no result leakage. Family reads do not grant attendance/marks editing rights.
- [ ] **RP-10 · UX and pages.** Check 1440 px light and 390 px system dark, keyboard focus, clear loading/error/empty states and pagination beyond 50 records. Draft review reasons must survive an unknown response; school/status/context changes stay locked until the draft is resolved or explicitly discarded.

## Engineering evidence and limits — local publication phase, 6 November 2026

**56 database tests + 34 client/UI tests** cover source coherence, missing-versus-zero marks, immutable snapshots, independent review, retries, stale versions, revisions and role/child isolation. Controlled browser QA passed **11 flows**, intercepting all **131/131 school requests** and executing **75 real RPCs in recovered local PGlite**, with **zero hosted school writes**. This proves the local UI-to-database contract; it is not hosted endpoint acceptance or native concurrent PostgreSQL QA. See PHASES.md in the engineering implementation log for current full checks and release state.

A saved mark for a pupil later withdrawn from the assessment's class/section no longer blocks publication: the mark is kept but left out of the snapshot. Other saved marks outside the current roster (for example a pupil now actively placed in another section) still block, so older assessments whose historical marks no longer match that roster stay blocked; reviewed historical-roster recovery is not implemented. This phase provides single-assessment results: no term report cards, grading/pass-fail policy, class ranks, stored PDFs or publication withdrawal. Hosted concurrency, email delivery and founder acceptance are separate checks and remain unticked here.

| Case | Pass / Fail / Blocked | Role/device, expected / actual, evidence |
|---|---|---|
| | | |
