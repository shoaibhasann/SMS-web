# Access security and student activation · 6 November 2026

**Local only: these migrations are not applied to hosted Supabase, committed, pushed or deployed.** The founder's existing `b9d4e3f` Preview continues to use the earlier database policies. Localhost also points to that shared project, so it cannot demonstrate unapplied database changes.

## Audit traceability

| Finding | Local implementation | Hosted status |
|---|---|---|
| 1 · Legacy payroll/marks/audit mutations | Remove API writes, bypass privileges and column grants. Replace school-membership ALL policies with explicit read-only office permissions. Retain rows/trusted backend writes; revoke API execution of the unused broken audit writer. | Not applied |
| 2 · Revoked teacher assessment access | Require active profile, exact school Teacher role, coherent placement and current assignment. Remove duplicate admin bypass policies, add restrictive authorization and lock/recheck write authority. | Not applied |
| 3 · Inactive administrator grants | Lock actual actor/target profiles, require active actor and school/global authority. Harden shared staff and legacy admin-student helpers; prevent inactive admin/principal self-reactivation. | Not applied |
| 8 · Successful activation without pupil link | Atomically bind student/profile/school/Student role after confirmed Auth identity and existing admission/DOB/mobile proof. Reject conflicting identity/ambiguous proof; guard direct office bind/unlink/relink and revoked-role retry. | Not applied |

Assessment School Admin/global Super Admin authority is preserved; Principal gains no new assessment authority. Historical teacher/assignment, enrollment, attendance, finance and guardian rows remain. Legacy marks become office-only history, not a new published-results family feature. Other module policies and legacy helpers still require review; this phase does not establish universal inactive-profile enforcement.

## Verification boundary

Tests execute SQL and RLS in isolated PGlite databases, reproducing original exploits before the patch and checking denial, authorized paths, rollback and retained history afterward. Auth payload/JWT lookup is synthetic. Recovered schema fixtures and the assessment catalog checked read-only against the demo project supply policy definitions. This is not a full clean database restore or proof of hosted Auth/concurrent sessions. Final counts are in [the implementation log](PHASES.md#access-security-and-student-activation--6-november-2026).

## Next database rollout

Engineering must prepare an isolated demo environment and preserve its schema/data first. The metadata export alone is not a backup; the complete executable baseline and tested restore remain open. Review preflight failures instead of deleting conflicting rows or restoring unsafe policies. Apply in filename order only when rollout is scheduled:

1. `20261105184935_freeze_legacy_client_mutations.sql`
2. `20261105184937_revoke_assessment_access_on_role_removal.sql`
3. `20261105184939_require_active_role_assignment_actor.sql`
4. `20261105184942_atomic_student_account_activation.sql`

Prepare synthetic School A/B accounts: active/disabled Admin, Principal, Accountant, Reception, assigned/revoked Teacher, Guardian and fresh confirmed Student with no roles. Prepare an unlinked active pupil with DOB, registered mobile and coherent current enrollment, plus an unrelated pupil. Keep credentials/tokens outside Git and screenshots.

## Next-release checklist · pending hosted rollout

Record URL, revision, applied migration versions, tester, date and device. Founder can do SEC-01/02/10 with engineering-prepared fixtures; role manipulation/direct API checks need engineering assistance. Do not tick these against the existing unchanged Preview.

- [ ] **SEC-01 · First activation → history.** Fresh confirmed Student signs in and activates with supplied admission/DOB/mobile. Own attendance/receipts load after refresh and sign out/in; unrelated pupil is absent. Compare original attendance, fee and guardian links before/after.
- [ ] **SEC-02 · Wrong proof, conflicting account and retry.** Wrong DOB/mobile or another account's claimed pupil fails without a role/link being created. Original account's completed retry returns the same pupil without duplicates. A withdrawn pupil cannot be newly claimed. An already-bound account whose Student role was revoked must contact the school; activation must not recreate the role.
- [ ] **SEC-03 · Retained teacher session.** Remove the exact school's Teacher role while preserving teacher/assignment rows. Reload and issue fresh direct assessment/mark reads and writes: denied. Repeat with profile disabled and assignment removed. Restoring the approved role restores only assigned scope.
- [ ] **SEC-04 · Disabled admin.** Existing session cannot grant via public/private role RPCs, self-reactivate, or mutate students through the legacy admin policy. Basic own name/phone/avatar contract remains. An active authorized manager can reactivate the account; a fresh permitted grant then succeeds.
- [ ] **SEC-05 · Direct pupil-link bypass.** Admin/Reception attempts to bind, clear or replace `students.profile_id` fail and preserve original links. Ordinary unlinked admission and permitted demographic edits work; checked activation can bind.
- [ ] **SEC-06 · Legacy history.** Active same-school Admin/Principal read coherent marks/audit history; Accountant additionally reads coherent payroll. Reception/Teacher/family do not acquire these reads. API roles cannot INSERT/UPDATE/DELETE/TRUNCATE these tables or call the retired audit writer. Owner/service maintenance remains. Repeat with School B and inactive accounts.
- [ ] **SEC-07 · Assessment scope.** Assigned teacher/active school admin work in valid scope. Wrong school, unassigned class/section/subject, inactive identity and another school's Teacher role fail. Malformed cross-school rows are hidden/rejected. Saved-mark placement cannot be moved; history remains intact. Authorized ungraded placement edits still work.
- [ ] **SEC-08 · Role grants.** Active School Admin grants ordinary own-school roles idempotently. Principal/ordinary roles, wrong-school grants and school-scoped Super Admin fail. Only active global Super Admin grants global Super Admin. Missing actor/target profile creates no role.
- [ ] **SEC-09 · Independent concurrent connections.** In disposable real PostgreSQL, test revoke/disable versus assessment write, grant versus activation, duplicate claims, and maximum change versus mark save. Record commits/rollbacks. No unauthorized post-revocation request, duplicate pupil link or impossible score should commit. Reload before retrying a rolled-back operation. Single-client PGlite does not prove these schedules.
- [ ] **SEC-10 · Cross-role regression.** Recheck attendance save/reload, linked-child history, substitute expiry, homework submit/grade, fee collection/receipt/advance readback and guardian invitations. Use separate role sessions on laptop/phone and synthetic payments only.

## Remaining decisions and limits

- Confirmed Auth plus admission/DOB/mobile knowledge is the current compatibility contract. This sends **no OTP to the registered pupil contact**. School-issued student invitations or a verified registered channel, abuse/rate limiting and recovery policy need approval before real-school onboarding.
- Proof ambiguity uses the initial lookup snapshot; chosen proof/binding is rechecked under the pupil lock. Concurrent creation of another matching proof is not globally serialized. A unique profile index still prevents one login binding multiple pupils.
- Real multi-connection locks, actual signup/profile creation, verification/ban changes, provider callbacks, backup restore and complete-chain hosted rollout remain pending. Missing target profiles deliberately block role grants.
- Stale mark/notice overwrites, incomplete academic/result reads, generated-log cleanup races and database reproducibility are subsequent audit work. Parent-row locking now protects mark validation, but the maximum/mark concurrency finding stays open until independently demonstrated.

| Run | Result |
|---|---|
| Local SQL/RLS regression checks | 935/935 whole-suite tests across 97 files; includes 76 new DB cases and the ordered four-migration chain. Lint/TypeScript pass. See implementation log. |
| Hosted migration rollout | Pending |
| Real Auth activation and browser roles | Pending |
| Independent concurrent connections | Pending |
| Founder next-release acceptance | Pending |
