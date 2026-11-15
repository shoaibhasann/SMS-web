# SMS Web handoff for Claude

Use [AGENTS.md](AGENTS.md) for repository instructions and [codex.md](codex.md) for the current implementation, release references and QA steps. The [README](README.md) covers local setup. SMS Web uses Next.js, React, TypeScript and Supabase Auth with PostgreSQL.

## Assessment workflow

- Teachers enter scores in **Exam / Marks** and submit completed, fully marked assessments in **Result publication**. The marks editor opens in a dialog with Save feedback beside its actions. A confirmed submission moves attention to **My publication requests**, where pending and unchanged published assessments stay in history.
- An independent School Admin or Principal opens the saved snapshot in **Result publication** and reviews it with a reason. The reviewer must be separate from the requester and the staff who entered the captured marks.
- Students and linked Guardians use **Published results**. They see their pupil’s latest published revision, and the family layout keeps the score and print action together. The child selector is available when a Guardian has multiple choices or needs to recover from an unavailable link.

## Continue QA

The synthetic assessment **QA Independent Review 15 Nov** was published as revision **1** for **Android APK QA Student** at **14/20 (70%)**. Both family roles loaded this result. Print it from each role and compare the pupil, score, revision and IST publication time with the screen. Use a separate pending QA request to test that a changed source blocks publication. [Manual checklist](public/qa/result-publication-checklist.md)

Run `npm run typecheck`, `npm run lint` and the tests for the workflow you touch. Keep login details in the private QA handoff. Links to the implementation and checks are in [codex.md](codex.md).
