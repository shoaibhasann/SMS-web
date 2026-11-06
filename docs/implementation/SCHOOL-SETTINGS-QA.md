# Governed school details and guided setup

7 November 2026 · Production and two-role browser verified · Founder acceptance pending

This SET-01 slice replaces the local School Settings demo with saved school details and a server-derived setup guide for an operator-provisioned school. It reuses the existing academic setup/import, staff invitation/claim, teaching assignment, roster, guardian invitation/acceptance and attendance flows. It does not introduce another copy of those records or a public school-provisioning/subscription service.

## Contract and authority

- School Admin and a correctly scoped global Super Admin can edit the supported profile fields. Principal can read school details and progress. Other roles, foreign schools and missing/inactive/revoked sessions are denied by the database, independently of navigation.
- `get_school_settings` returns the selected school's allowlisted details, revision, caller permission, structural counts and ten recent sanitized change events. It excludes arbitrary legacy configuration, raw audit snapshots/reasons, invitation tokens and recipient contact lists.
- `save_school_settings` accepts a school, expected revision, actor-bound request UUID, exact field allowlist and a reason. Revision conflicts fail closed. Exact retries return a saved receipt; changing an existing request's payload is denied. An unchanged normalized profile creates no new change revision/event.
- The supported fields are name, board, affiliation number, address, city, state, PIN, office phone, office email and HTTPS website. School code, timezone, activation, academic session, opaque configuration, logo/colors and authorization settings are not generic form writes.
- Direct school/configuration mutations are removed from anonymous and authenticated table/column privileges. Trusted operator access remains. Existing school dropdown reads and all unrelated academic/finance/history contracts retain their source.
- Private receipts and audit snapshots are not direct client APIs. The displayed history includes actor, time, revision and changed field names, with no raw contact snapshot or private reason.

## Setup guide boundary

Counts derive from the current school records, not local storage or manual completion switches. The guide distinguishes a directory Teacher from a linked, verified active Teacher account, and an outstanding Guardian invitation from a verified linked pupil. Missing sections, current-session assignments, valid placements and guardian links remain visible. Today's saved attendance is a record count, not an approved attendance-rate formula.

The guide links existing Academics, Teachers, Teaching Assignments, Students, Guardian invitations and Attendance screens. An existing configured year outside its date range is not evidence of an active running session. Structural progress does not establish that every subject is covered, that provider messages were delivered or that a founder/school approved the configuration.

## Source and hosted parity

| Item | Verified source |
| --- | --- |
| Aligned hosted migration | `20261106192829_govern_school_settings_and_setup.sql` |
| SQL SHA-256 | `8197d047e1ba1d7c5805ecaea06074a6c7abf31cd11683f1bf571354b582f656` |
| SQL MD5 | `82fc03c34c6a8ac0382e2a85eba78952` |
| Recovery plan | 89 sources /19 patches /112 application tables /5 views |

The hosted ledger matches the exact local SQL. Application schema replay is an embedded managed-platform contract, not a Supabase/Auth/Storage disaster-recovery rehearsal. Credentials, source row snapshots and invitation capabilities remain in the private QA handoff.

## Engineering evidence

- Focused settings, replay and existing audit-history regressions: **138 passing tests /3 files**. The hosted-filename alignment rerun passes **88 settings/replay tests /2 files**. These runs overlap; they are not additional unique test totals. Whole web verification passes **2,211 tests /153 files**, full TypeScript/ESLint and the optimized local build. A final singular/plural copy-only adjustment then passes **11 UI tests**, TypeScript and scoped lint; the helper and backend source are unchanged.
- Database regressions verify Admin/global Super Admin edits, Principal read-only, wrong-school and lower-role denial, anonymous/service execute denial, disabled/unverified/banned identities, removed/expired/malformed/other-user sessions, raw table and column mutation denial, stale revisions, actor-bound exact retries, changed-payload conflicts, no-op preservation, multiline postal addresses, safe HTTPS validation and revision overflow. The complete-roster regression counts **1,207 pupils** without a client row-cap shortcut.
- Actual hosted SDK workflow: the initial **88 checks /16 owned sessions** pass, followed by **7 checks /1 session** against the frozen final helper for GET, no-op and exact retry while retaining revision 3. That is **95 checks and 17/17 sessions closed** across those runs. Separate preflight evidence passes **14 checks**, closing **7/7 owned sessions**. No SMS, email or FCM message was sent. These remain SDK evidence; the separate local and Production browser records below establish only their observed role paths, not founder acceptance.
- Two independent Admin sessions race the same revision: **one commit, one conflict and one history event**. The winning exact retry returns its original receipt. Principal can read but cannot save. Existing-school profile changes use the caller's explicitly pinned JWT; an account change cannot substitute another account's token while a request is prepared. An already accepted server transaction is not undone by closing its page.
- A new isolated, operator-provisioned school progresses through actual APIs: academic/catalog CSV, imported staff directory with an initially unlinked Teacher, Teacher invitation claim, assignment CSV, pupil admission and roster CSV retry, pending Guardian invitation versus accepted child link, Student account activation, then Teacher saves **Absent /Present** for two pupils. Student and linked Guardian reload permitted attendance without a peer record. The checklist derives these stages from persisted data, rather than client completion flags.
- The final read-only post-Production integrity probe at **7 November 01:15:20 IST (6 November 19:45:20 UTC)** verifies all **2,517 original rows across 110 pre-existing application tables** preserved exactly. The new `settings_revision` column is excluded from old-column byte comparisons; all **18 prior schools** retain revision 0. The flow adds **38 isolated synthetic fixture rows** only to those original tables. The new private Settings tables contain **4 audit rows /6 retry receipts**, all for the isolated school, with **zero other-school entries**. The QA school is at revision 4. Existing attendance, fees, payments, guardian links, published work and notification read timestamps are not rewritten. A read-cap preflight found **zero incompatible legacy school profiles** among those 18 schools.
- Hosted privilege readback confirms direct school UPDATE and column UPDATE denied, unused legacy configuration read denied, trusted service school UPDATE retained, and both public RPCs `SECURITY INVOKER`. Their private implementations enforce current verified native-session, profile, role and active-school checks with ordered locks.
- Advisor warning groups remain the existing **7 mutable search path /2 anonymous access /6 authenticated access /1 leaked-password protection**. INFO increases from **41 to 43** because the two private receipt/audit tables intentionally have RLS with no client policy and all client privileges revoked. This is not a claim that the earlier warnings are resolved.

## Release verification

Actual **local browser** QA signs in as Admin, changes the QA affiliation with a reason, saves, reloads the page and sees the same value at **revision 3** with sanitized history. Principal reads that same saved value with no Edit button and a disabled name field. Teacher direct navigation to `/modules/settings` shows the role-denied page. All **3/3 owned browser sessions** log out through the UI. At **1440px and 390px**, the settings view has no horizontal overflow; the temporary viewport is restored. This proves the local UI against the hosted database, not the Production frontend.

### Verified Production runtime — 7 November 2026

| Item | Recorded evidence |
| --- | --- |
| Runtime pushed to `main` | `527c9ae24733b50bcbc954141d0256c6f3ec312b` |
| Stable Production | [SMS login](https://kids-corner-erp-frontend.vercel.app/login) |
| Deployment | `dpl_J9KLrZdyhQxKdHG5Bsms3wGx55Pw` · Production · Ready |
| GitHub/Vercel and build | Success · 19-second Vercel build · stable alias confirmed |

Actual stable-Production Admin QA edits the isolated school's affiliation with a reason, saves, reloads the page and confirms the Production value at **revision 4** with sanitized history. Principal signs in on Production and sees that same saved value, **zero Edit buttons** and a disabled school-name field. Both **2/2 owned Production browser sessions** log out through the UI. The 1440px Production view has no horizontal overflow, and the temporary viewport is reset. A deployment-scoped Vercel error query covering the new-release window returns no entries; this is not long-term monitoring evidence.

This adds two actual deployed-browser role paths to the earlier three-role local proof. Teacher direct-route denial remains observed locally and in SDK/database permission coverage; a separate Production Teacher browser test is not claimed. Final documentation publication and exact public Markdown readback follow this runtime verification. Founder cases remain entirely unticked.

## Manual acceptance and remaining gates

Use the [founder checklist](https://kids-corner-erp-frontend.vercel.app/qa/school-settings-checklist.md). Founder cases remain unchecked until observed on the recorded release. Private QA credentials and invitation capabilities stay outside Git/public files.

Staff MFA, school-assisted lost-number recovery, permission administration, platform provisioning/subscriptions, approved calendar/correction/rate/grading rules, provider/device delivery and managed-service recovery remain separate work. Existing private-file legacy-cache findings are tracked independently in [private file delivery](PRIVATE-FILE-DELIVERY-QA.md); this feature does not change Storage keys or claim instant global cached-link revocation.
