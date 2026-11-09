# Access security and student activation · 6 November 2026

**Production is Ready:** [stable SMS login](https://sms-web-shoaibhasann.vercel.app/login), code `2dfb1e26`, deployment `dpl_Hn7b55aj4ThnjDC1tykBJAGxHP1J`. The requested nine migrations plus two hosted-QA fixes (**11 total**) are applied and their source/history hashes verified in [the rollout ledger](../../supabase/recovery/hosted-rollout-2026-11-06.json). Four-role Production read-only QA passed at 17:06 IST: 142 school reads, zero school writes/runtime errors and 4/4 local Auth-session cleanups. Individual manual founder cases remain unticked. Use [the current Production checklist](PRODUCTION-RELEASE-QA.md), not an earlier Preview record.

## Audit traceability

| Finding | Implementation | Hosted schema status |
|---|---|---|
| 1 · Legacy payroll/marks/audit mutations | Remove API writes, bypass privileges and column grants. Replace school-membership ALL policies with explicit read-only office permissions. Retain rows/trusted backend writes; revoke API execution of the unused broken audit writer. | Applied; source/history verified |
| 2 · Revoked teacher assessment access | Require active profile, exact school Teacher role, coherent placement and current assignment. Remove duplicate admin bypass policies, add restrictive authorization and lock/recheck write authority. | Applied; source/history verified |
| 3 · Inactive administrator grants | Lock actual actor/target profiles, require active actor and school/global authority. Harden shared staff and legacy admin-student helpers; prevent inactive admin/principal self-reactivation. | Applied; source/history verified |
| 8 · Successful activation without pupil link | Atomically bind student/profile/school/Student role after confirmed Auth identity and existing admission/DOB/mobile proof. Reject conflicting identity/ambiguous proof; guard direct office bind/unlink/relink and revoked-role retry. | Applied; source/history verified |

Raw assessment editing retains School Admin/global Super Admin authority; Principal gains no new raw-mark editing authority through these four patches. Independent reviewed publication is a separate later workflow. Historical teacher/assignment, enrollment, attendance, finance and guardian rows remain. Legacy marks become office-only history, not a new published-results family feature. Other module policies and legacy helpers still require review; this phase does not establish universal inactive-profile enforcement.

## Historical phase verification boundary — 6 November 2026

Tests execute SQL and RLS in isolated PGlite databases, reproducing original exploits before the patch and checking denial, authorized paths, rollback and retained history afterward. Auth payload/JWT lookup is synthetic. Recovered schema fixtures and the assessment catalog checked read-only against the demo project supply policy definitions. This is not a full clean database restore or proof of hosted Auth/concurrent sessions. Final counts are in [the implementation log](PHASES.md#access-security-and-student-activation--6-november-2026).

## Applied security patches within the 11-patch release

The four files below are applied within the verified 11-patch chain. Before rollout, 99 actual application tables / 2,401 rows and their catalog/sources were saved privately; an embedded restore verified the catalog and row bytes. This is application-row recovery evidence, not native Supabase Auth/Storage/provider recovery. Future changes still require preserved data and reviewed preflight failures; do not delete conflicting rows or restore unsafe policies.

1. `20261105184935_freeze_legacy_client_mutations.sql`
2. `20261105184937_revoke_assessment_access_on_role_removal.sql`
3. `20261105184939_require_active_role_assignment_actor.sql`
4. `20261105184942_atomic_student_account_activation.sql`

Prepare synthetic School A/B accounts: active/disabled Admin, Principal, Accountant, Reception, assigned/revoked Teacher, Guardian and fresh confirmed Student with no roles. Prepare an unlinked active pupil with DOB, registered mobile and coherent current enrollment, plus an unrelated pupil. Keep credentials/tokens outside Git and screenshots.

## Production manual checklist · founder acceptance pending

Record the stable Production URL, revision, applied migration versions, tester, date and device. Founder can do SEC-01/02/10 with engineering-prepared fixtures; role manipulation/direct API checks need engineering assistance. Applied schema does not automatically tick any manual SEC case.

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
- Real multi-connection schedules, actual signup/profile creation, verification/ban changes, provider callbacks and native Auth/Storage recovery still require their own acceptance evidence. The 11-patch hosted rollout and private application-row/embedded restore checks are complete. Missing target profiles deliberately block role grants.
- Stale mark/notice protection, complete academic/result reads, safe activity removal and executable database replay are implemented in the released integrity/recovery phases; see [their checklist](ACADEMIC-INTEGRITY-QA.md). Parent-row locking protects mark validation, while independent native concurrent acceptance remains separate.

| Run | Result |
|---|---|
| Historical local SQL/RLS regression checks | 935/935 whole-suite tests across 97 files; includes 76 new DB cases and the ordered four-migration chain. Lint/TypeScript pass. See implementation log. |
| Hosted migration rollout | All 11 patches applied; exact source/history hashes verified. These four security patches are included. |
| Real Auth activation and browser roles | Four-role Production read-only QA passed at 17:06 IST; individual activation/role-mutation cases still need their own recorded result. |
| Independent concurrent connections | Pending |
| Founder Production acceptance | Pending |
