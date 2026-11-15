# SMS Web implementation and QA handoff

Updated 15 November 2026. Read [AGENTS.md](AGENTS.md) before editing. The [Claude handoff](claude.md) is a short entry point. SMS Web uses Next.js, React and TypeScript with Supabase Auth and PostgreSQL. The [README](README.md) documents setup and the stable [Production login](https://sms-web-shoaibhasann.vercel.app/login).

## Result publication by role

| Role | Page and scope |
| --- | --- |
| Teacher | **Exam / Marks** at `/modules/exams` opens the scores for an assessment. The teacher can edit assessments they own and view other marks where access permits. In **Result publication** at `/modules/published-results`, a complete, currently assigned assessment can be sent as a frozen request. |
| School Admin or Principal | **Result publication** at `/modules/published-results` shows requests for the selected authorized school. Another eligible reviewer opens the snapshot and enters a reason to publish or reject. The requester and staff recorded as entering the snapshot marks cannot review it. |
| Student or Guardian | **Published results** at `/modules/results` shows only the signed-in pupil or selected linked child. A mixed-role Guardian can use `/modules/results?view=guardian`. Family cards show the latest published revision with its original labels, score and remarks. Pending and rejected requests, peer marks and private review reasons remain private. |

Zero counts as a score. Missing marks block publication. A changed source blocks publication of an older snapshot. The teacher can cancel their own pending request with a reason. A corrected source can go through independent review as a new revision. [Role routes](lib/modules.ts) · [Result API and validation](lib/result-publication.ts) · [Publication checklist](public/qa/result-publication-checklist.md)

## Recent web changes

- **Marks entry.** Enter Marks opens a focused editor with local save, error and unsaved states. It fits short rosters on desktop and uses the available viewport on phones. Closing and reopening the same assessment preserves its unsaved draft. After saving, the editor offers a link to Result publication. [Teacher views](components/teacher/teacher-views.tsx) · [Workflow PR #17](https://github.com/shoaibhasann/SMS-web/pull/17) · [Desktop sizing PR #18](https://github.com/shoaibhasann/SMS-web/pull/18)
- **Request history.** A confirmed request hides the source preview and moves focus to My publication requests. Saved pending requests and published snapshots whose source still matches stay in history after refresh. A changed source can open a new preview. [Workflow PR #17](https://github.com/shoaibhasann/SMS-web/pull/17)
- **Snapshot dialog and cursors.** Open result snapshot opens a dialog for review or cancellation. Close and Escape protect a draft reason and restore focus. Shared cursor rules give enabled buttons and disclosure controls a pointer and disabled controls an unavailable cursor. [Publication workspace](components/academic/result-publication-workspace.tsx) · [Global styles](app/globals.css) · [PR #19](https://github.com/shoaibhasann/SMS-web/pull/19)
- **Compact family results.** This change combines the family heading, selected child, and refresh controls. The Guardian picker appears when needed, and the result card keeps key details and print together. Family access is checked when opening results or a notification link. [Publication workspace](components/academic/result-publication-workspace.tsx)

The recent main branch also includes sign-in redirects and a 404 page, stable pages when returning to a tab, and phone layout fixes for the attendance register and calendar. Use the implementation log for the wider project history. [PR #12](https://github.com/shoaibhasann/SMS-web/pull/12) · [PR #13](https://github.com/shoaibhasann/SMS-web/pull/13) · [PR #14](https://github.com/shoaibhasann/SMS-web/pull/14) · [PR #15](https://github.com/shoaibhasann/SMS-web/pull/15) · [Implementation phases](docs/implementation/PHASES.md)

## QA on 15 November 2026

The synthetic **QA Independent Review 15 Nov** assessment shows **14/20 (70%)** for **Android APK QA Student**, published at **4:38:49 PM IST** as **revision 1**. Both Student and linked Guardian loaded it. Use the private QA handoff for logins.

1. In both family roles, open that assessment and choose **Print this result**. Check the pupil, score, percentage, revision, original class and session, and readable IST publication time. Check that the print view contains only this pupil and no private reasons or peer scores.
2. On a separate disposable assessment, request publication, then change a mark. The independent reviewer should be unable to publish the old snapshot. Cancel as the teacher or reject as the reviewer, then refresh the source and request a fresh review.
3. When testing revisions, publish the corrected snapshot and confirm that families see only the latest version. Also verify the compact family layout at desktop and phone widths.

Read [RP-04 through RP-10](public/qa/result-publication-checklist.md#founder-checklist-after-rollout) and the [founder release checklist](docs/implementation/FOUNDER-RELEASE-QA.md) for manual acceptance.

## Local checks

Use `npm ci` to install dependencies and `npm run dev` to start the local app with the intended QA configuration. [Local setup](README.md#local-setup)

```sh
npm test -- tests/academic-loading.test.tsx tests/result-publication-workspace.test.tsx tests/result-publication-requester-cancel.test.tsx tests/result-publication-client.test.ts
npm run typecheck
npm run lint
npm run build
```

`npm test` runs the full suite and `npm run test:db` runs the local database tests. Record the verified deployment revision separately from the local checks. Keep environment files, credentials and tokens out of Git.
