What this repo does: Kids Corner ERP is a Next.js and Supabase school-management app for administrators, teachers, finance staff, pupils and guardians. It implements attendance, academic work, invitations and office-fee workflows; several remaining administration modules still use browser-local demonstration data. This audit assumes **300–1,500 pupils per school, multiple school tenants, and staff or guardians using concurrent sessions**.

Audit date: **5 November 2026**. This is a one-shot report; the audit changed no application code, configuration or remote database rows. Separately requested login-screen design work is outside these findings.

The current audit checkpoint passed **847 tests across 89 files, lint and TypeScript**. A fresh `npm audit --omit=dev` reported zero known production-dependency vulnerabilities. The checks use local database fixtures and mocked provider boundaries; passing them does not cover the specific missing cases below or establish a complete security test. No fresh production build was run because the user requested the development server remain available; the earlier phase's 22:35 build passed, but that is not a fresh audit build.

Database findings below distinguish **current live catalog checks** from **isolated local database reproductions**. Concurrency findings identified by source review describe a concrete order of operations; they were not reproduced against production. A **1,000-row API limit** is an explicit example in findings 5 and 11, not a confirmed current provider setting or a claim that production data has already been lost. Read-only catalog checks found no explicit `pgrst.db_max_rows` setting, which does not establish the effective REST limit. The old November 2 graph was used for navigation only; metadata-snapshot rules cited as current were checked against the live catalog.

## Must fix

1. **Reception can change legacy payroll and marks, and erase audit rows.** ([school helper](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261104132141_teacher_invitations.sql:7), [payroll policy](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/schema-snapshots/2026-11-02/schema-metadata.json:1174), [marks policy](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/schema-snapshots/2026-11-02/schema-metadata.json:1054), [audit policy](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/schema-snapshots/2026-11-02/schema-metadata.json:346))
   - **What this is:** Database row rules are the final permission check when a caller uses the API directly. These legacy tables grant every school member returned by the helper every operation.
   - **Problem:** The current live helper includes reception and accounting roles, and current table grants and policies permit these writes. Isolated local reproduction changed payroll from 45,000 to 99,999, changed a legacy mark from 30 to 100, and deleted an audit row as reception; these are the legacy `payroll`, `marks` and `audit_logs` tables, not the newer assessment-mark or ordinary fee-payment workflows.
   - **Fix:** Replace broad membership rules with explicit roles and operations for each table. Remove client UPDATE and DELETE access to audit logs.
   - **If we skip it:** Staff can change sensitive legacy records beyond their assigned role, even where the UI hides the module. The bounded 17-table staff-policy fixture excludes these tables, so its passing tests miss this case.

2. **Removing a teacher's role does not revoke exam access.** ([assignment helper](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261101_teacher_assessments_and_profile.sql:99), [exam update rule](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261101_teacher_assessments_and_profile.sql:265))
   - **What this is:** Exam access checks the teacher's linked profile and subject assignment. The helper runs with its database owner's privileges and can read assignment rows that the caller cannot read directly.
   - **Problem:** The current live helper never checks that the teacher role or profile is active. An isolated local reproduction retained the historical teacher and assignment records, left the login with zero role rows, and successfully updated the exam name through the current rules.
   - **Fix:** Require an active profile and the matching school-scoped teacher role before accepting an assessment assignment. Keep historical teacher records without treating them as current authority.
   - **If we skip it:** A former teacher with a valid Auth session can bypass the blocked UI and continue using the exam API. No revoked-role assessment regression test was found.

3. **An inactive administrator can still grant administrator access.** ([role-assignment authorization](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261102163032_harden_school_role_assignment.sql:155))
   - **What this is:** The role-assignment endpoint lets a school administrator grant roles to another existing login. Newer workflows already check whether the actor's profile is active.
   - **Problem:** The current live role-assignment function checks retained role rows but ignores `profiles.is_active`. An isolated local reproduction set the actor's profile inactive and still successfully granted another login the school-administrator role.
   - **Fix:** Lock and check the actor's active profile before approving a role grant. Add an inactive-actor case to the role-permission tests.
   - **If we skip it:** Disabling the profile leaves a privileged endpoint open, allowing the disabled administrator to grant another account access. Existing role tests cover school boundaries and escalation, but not this case.

4. **Saving exam marks can silently overwrite another session's work.** ([mark payload and save](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/teacher/teacher-views.tsx:470))
   - **What this is:** The marks screen loads a class and sends all nonblank marks when the teacher presses Save. Its insert-or-update operation does not check the version originally loaded.
   - **Problem:** Source review shows that two devices can load the same sheet, edit different pupils, and save in sequence. The second save includes the first pupil's old value and silently restores it; this is a concrete code interleaving, not a live production reproduction.
   - **Fix:** Write only changed marks and condition each existing-row write on its loaded version. Report a conflict instead of replacing a newer value.
   - **If we skip it:** Ordinary parallel marking can lose accepted marks while both teachers see success. The existing assessment loading test does not cover competing saves.

5. **A partial activity read can turn an edit into deletion of unseen work.** ([activity read](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/lib/academic.ts:152), [saved activity snapshot](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/academic/academic-workspace.tsx:464), [deletion of omitted activities](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261105134741_academic_optimistic_conflict_http_status.sql:64))
   - **What this is:** Academic-log editing reads activities for up to 200 logs, then saves the chosen log as a complete list of children. The current live save function deletes children absent from that submitted list.
   - **Problem:** The child read has no pagination or completeness check: with an example 1,000-row API limit, 200 logs with six activities produce 1,200 rows and a partial response. A matching parent version does not detect that incomplete read, so saving an affected log can delete an unseen activity that has no submissions; the live API limit and production occurrence were not verified.
   - **Fix:** Page activities in a stable order, verify the exact count, and block complete-list saves when the read is incomplete. Add a test where a child's absence comes from truncation rather than a deliberate deletion.
   - **If we skip it:** An ordinary edit can remove work the teacher never saw. Existing stale-snapshot tests use two children and do not exercise an API row limit.

6. **A stale notice edit can republish a withdrawn, restricted notice.** ([notice payload and update](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/admin/admin-notices-workspace.tsx:206))
   - **What this is:** Notice editing saves the title, content, publication time and audience from the local edit form. The UPDATE matches only notice ID and school.
   - **Problem:** A temporary test using the actual component reproduced this sequence: B opens a published Everyone notice, A retracts it and restricts it to Teachers, then B edits only its title. B's successful save silently restores the old publication and Everyone audience.
   - **Fix:** Capture the notice's version when editing starts and require that version on UPDATE. Treat zero matching rows as a conflict and preserve the draft.
   - **If we skip it:** A staff member can undo another staff member's privacy or publication correction without knowing. Existing notice tests preserve audience fields but do not test competing edits.

7. **Concurrent exam edits can leave a mark higher than the maximum.** ([maximum validator](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261101_teacher_assessments_and_profile.sql:63), [mark validator](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261101_teacher_assessments_and_profile.sql:217))
   - **What this is:** One trigger rejects marks above the exam maximum, and another rejects lowering the maximum below existing marks. Their current live definitions perform independent reads without a shared lock.
   - **Problem:** Source analysis permits one transaction lowering the maximum from 10 to 5 while another inserts 8: each can read the old state, pass its check, and commit, leaving 8 out of 5. This two-transaction schedule was reviewed but not executed against production.
   - **Fix:** Have mark validation lock the assessment row with `FOR SHARE` before reading its maximum, so it conflicts with a maximum change. Add a competing maximum/mark database test.
   - **If we skip it:** Valid-looking requests can create impossible scores and percentages. Current tests do not establish this concurrent invariant.

8. **Student activation succeeds without linking the pupil.** ([activation caller](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/app/(dashboard)/activate/page.tsx:32), [activation function](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/schema-snapshots/2026-11-02/schema-metadata.json:2460), [pupil readback](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/lib/attendance/family.ts:31))
   - **What this is:** A new pupil verifies admission number, date of birth and registered mobile to activate a school login. Family screens subsequently locate the pupil through `students.profile_id`.
   - **Problem:** The exact current live activation function updates the profile's school and creates the student role but never sets that pupil link. An isolated local reproduction returned success and the pupil identifier while `students.profile_id` stayed empty.
   - **Fix:** Replace the claim with one atomic operation that locks the account and pupil, rejects conflicting existing links, and sets `students.profile_id` before returning success. Add a first-time activation test starting with an unlinked pupil.
   - **If we skip it:** A newly verified pupil reaches a dashboard that cannot load their attendance, academic work or receipts. Existing student fixtures start already linked.

9. **Deleting an empty generated log can erase a newly added activity.** ([separate empty check and delete](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/academic/teacher-activity-workspace.tsx:422))
   - **What this is:** Removing an activity also cleans up its generated parent log if a separate request finds no remaining activities. Deleting the parent cascades to its children, as confirmed in the current live foreign-key definition.
   - **Problem:** Source review permits a second session to append an activity after the empty check but before the parent DELETE. The parent deletion then removes that new, unsubmitted activity; the log guard protects submissions but does not require the parent to remain empty.
   - **Fix:** Leave the harmless empty generated log, removing the cleanup requests. If cleanup is required, make the emptiness check and deletion one locked database operation.
   - **If we skip it:** Parallel authoring can lose newly added work. No test covers this interleaving.

10. **A parent who is also a teacher cannot open their child's receipts.** ([guardian route selection](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/app/(dashboard)/modules/[module]/page.tsx:48), [parent navigation](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/layout/app-shell.tsx:30))
    - **What this is:** Mixed-role users keep a primary staff workspace and can explicitly open guardian views. Receipts already have a family component and valid family database permissions.
    - **Problem:** Current compiled role helpers choose Teacher over Parent and deny Teacher access to Invoices. Both the parent-shell Receipts link and a manually entered `?view=guardian` URL fail, because Invoices is missing from the guardian-view whitelist.
    - **Fix:** Add guardian-scoped receipts to the existing whitelist and generate that URL from parent navigation. Add the mixed teacher/parent receipt case to the route tests.
    - **If we skip it:** A supported mixed-role guardian cannot use their child's receipts despite valid backend access. Current mixed-role tests cover attendance, contact and advance credit only.

11. **Result reports can rank pupils from a truncated set of marks.** ([unpaged mark read and ranking](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/teacher/teacher-views.tsx:792))
    - **What this is:** The result report reads marks for every loaded assessment, then builds pupil rows and ranks in the browser. The mark read has no pagination or exact-count check.
    - **Problem:** With an example 1,000-row API limit, 25 assessments of 50 pupils need 1,250 marks, so some report rows disappear and ranks can use an incomplete assessment. This is a source-level cap-dependent case; the current live provider limit and any production truncation were not verified.
    - **Fix:** Apply the selected report filters on the server and page all matching marks before calculating ranks. Fail visibly if the full set cannot be loaded.
    - **If we skip it:** The report can look complete while omitting pupils or producing incorrect ranks. Existing report mocks use tiny responses and do not model API limits.

12. **Academic history silently stops after 200 logs.** ([hard log limit](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/lib/academic.ts:135))
    - **What this is:** Academic screens load the latest logs and then apply date and activity-type filters in the browser. The shared reader stops at 200 logs and provides no next page.
    - **Problem:** At six logs per school day, a teacher passes this limit in roughly 34 school days. Older homework or projects can remain due but cannot be found through filters because those records were never loaded; this limit is explicit in source and does not depend on the provider's row cap.
    - **Fix:** Move relevant filters into the query and provide stable pagination or Load more. Keep older unfinished work reachable.
    - **If we skip it:** A normal term makes existing academic work disappear from the available history. Current loading mocks replace this reader and do not test the 200-log boundary.

## Should fix

13. **The repository cannot recreate its database from a clean start.** ([first migration](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/migrations/20261030_academic_teacher_self_management.sql:5), [snapshot limitation](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/supabase/schema-snapshots/2026-11-02/README.md:35))
    - **What this is:** Database migrations should recreate the application schema for a new environment or recovery. This repository's migrations are patches to an existing hosted database.
    - **Problem:** Clean isolated PGlite replay fails immediately because the first migration alters `public.class_logs`, which does not exist. There is no executable baseline, and the metadata JSON explicitly is not a restorable backup; tests reconstruct selected schema objects themselves.
    - **Fix:** Commit a reviewed baseline checkpoint and clearly identify patches already represented by it. Smoke-test the later migration chain on a fresh disposable database.
    - **If we skip it:** A new production environment or independent recovery depends on undocumented hosted state. This is a deployment and recovery gap, not evidence that the existing hosted database is failing.

14. **The administrator's next-seven-days query excludes its seventh day in India.** ([date calculation](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/dashboard/role-dashboard.tsx:1283))
    - **What this is:** The administrator dashboard computes an inclusive date boundary for upcoming exams. It starts from local midnight and converts the result to a UTC date string.
    - **Problem:** Running the actual source expressions under `TZ=Asia/Kolkata` with 5 November 2026 produces an end date of 11 November, excluding exams on 12 November. The UTC conversion moves local midnight into the previous calendar day.
    - **Fix:** Perform date-only arithmetic consistently in UTC using `T00:00:00Z` and UTC date methods. Add an India-time-zone end-boundary test.
    - **If we skip it:** Upcoming-exam lists and totals omit the final intended day. The current dashboard date test checks attendance's India date, not this boundary.

15. **Every module downloads unrelated office and academic interfaces.** ([static workspace imports](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/app/(dashboard)/modules/[module]/page.tsx:6))
    - **What this is:** One client route imports all module workspaces before deciding which role and page to render. This includes large office tools that a family visitor does not use.
    - **Problem:** Inspection of the existing production manifest shows a synchronous entry requiring five chunks: 1,583,655 raw bytes, or 398,900 gzip bytes. Its module-specific chunk alone is 442,208 raw bytes, or 100,948 gzip bytes, and includes notice publishing, admissions, substitute coverage, advance credit and guardian invitations together; these are existing-build measurements, not a fresh build or latency benchmark.
    - **Fix:** Lazy-load workspaces at their existing module branches, starting with the large office and academic interfaces. Verify the resulting production chunks when the next build is authorized.
    - **If we skip it:** Family devices download and parse code unrelated to their page. No claim is made about measured production latency or data exposure from downloading UI code.

## Nice to have

16. **Remove 307 obsolete source lines and one unused dependency.** ([obsolete people workspace](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/admin/admin-people-workspace.tsx:1), [dependency](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/package.json:38))
    - **What this is:** The routed roster and teacher directory have replaced an older people workspace, and unused sample dashboards remain beside the current dashboard. The current PostCSS configuration uses the Tailwind PostCSS plugin.
    - **Problem:** Whole-tree searches, including tests, hidden/ignored source, configuration and string references, found only tests for the obsolete people workspace and no active uses of the listed samples. `autoprefixer` has no source/configuration use, and the dependency explanation identifies only the project's direct dependency.
    - **Fix:** Delete the six files below, move useful directory regression cases onto the routed components, and remove the direct `autoprefixer` dependency. This is deletion work, not a new abstraction.
    - **If we skip it:** Tests and reviewers continue maintaining an obsolete directory and reading duplicate sample dashboards. The measured removable source total is 307 lines; deleting obsolete tests would be additional savings.

    | Removable file | Source lines | Remaining use |
    |---|---:|---|
    | [admin-people-workspace.tsx](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/admin/admin-people-workspace.tsx) | 237 | Tests only; routed replacements exist |
    | [dashboard.tsx](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/dashboard/dashboard.tsx) | 33 | None |
    | [stat-card.tsx](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/components/dashboard/stat-card.tsx) | 2 | None |
    | [dashboard-data.ts](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/lib/dashboard-data.ts) | 7 | Unused sample Dashboard only |
    | [admin-dashboard-demo.ts](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/lib/admin/admin-dashboard-demo.ts) | 27 | None |
    | [demo.ts](/Users/shoaib/kids-corner-erp-frontend/kids-corner-erp-frontend/lib/demo.ts) | 1 | None |

**Verdict:** Fix the remaining legacy permission holes and silent academic/notice overwrites first, then establish a reproducible database baseline before a fresh production rollout. No new confirmed security defect was found in the inspected ordinary office-fee or student-advance-credit core; that does not certify unrelated legacy tables.

**Lean: -307 lines, -1 dependency possible.**

**Not checked:** No real Auth login, fresh signup, email/SMS delivery, recovery email, provider account configuration, production load/latency test, production row-loss investigation or fresh deployment/build was performed for this audit. The current live API row limit, a complete clean migration replay after adding a baseline, disaster recovery from a real backup and every browser-local demonstration module were not validated end to end. Invitation/recovery routes, core attendance, academic, ordinary fee and advance-credit boundaries were inspected at different depths; the source-review concurrency schedules above still need isolated multi-connection regression tests. The separately requested login redesign needs its own UI checks. Sixteen actionable findings are listed; speculative concerns and unmeasured micro-optimizations were omitted.
