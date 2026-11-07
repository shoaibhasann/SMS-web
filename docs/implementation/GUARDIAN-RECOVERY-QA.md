# Guardian recovery and MFA-aware contact changes

7 November 2026 · Implementation and measured engineering evidence · Founder acceptance pending

Stable app: [SMS Production](https://kids-corner-erp-frontend.vercel.app/login). Deployed founder checklist: [GR-01–GR-24](https://kids-corner-erp-frontend.vercel.app/qa/guardian-recovery-checklist.md), with its [source checklist](../../public/qa/guardian-recovery-checklist.md) retained for review.

**Release status:** runtime `7f503316e63c06c7dc6eebccba4d604fbfc1d624` is pushed to `main` and Vercel Production Ready at the stable SMS alias. Hosted SDK recovery/preservation, the full local regression/lint/types/build, public page/checklist and actual Production read-only Guardian/Admin browser flows are verified below. Browser approval/claim/contact writes, real inbox/carrier delivery, native physical-device behavior and founder acceptance remain separate manual cases. SMS and FCM sending remain OFF.

## Two recovery paths

An owner who still controls the registered email can request the existing password reset. The reset callback uses separate HttpOnly recovery cookies, verifies the provider's recent recovery authentication method, and binds completion to that exact native session. An enrolled account must verify an owned authenticator in that recovery session before changing its password. Resetting the password does not remove a factor, change the Guardian row or recreate child links. The recovery session ends after success; an unrelated ordinary browser session is not adopted or signed out.

When the old email, number or authenticator is unavailable, **Guardian invitations → Account recovery** provides school-assisted replacement-login recovery. This transfers school access to a different verified, otherwise unassigned native account after independent review. It does not reset the old native Auth account, reveal its credentials, remove its factors or merge an already assigned Student/Teacher/Guardian account.

## School-assisted recovery contract

1. A current School Admin or Principal completes native TOTP/AAL2 verification, even if ordinary school MFA policy is optional. The workspace searches an exact student admission number within the selected school and lists eligible linked Guardians.
2. The requester chooses the existing Guardian, a normalized new email or Indian mobile number, and a 5–300 character school-verification reference. No Aadhaar/document numbers, passwords or OTPs belong in the reason. Only one unexpired open case is allowed per Guardian; new cases expire after one day.
3. A **different** current School Admin or Principal, also at native TOTP/AAL2, independently approves or rejects with a reason. A requester cannot approve/reject their own case. Only the requester or recorded reviewer may cancel an open case. Approval starts a one-day claim window and returns the private claim link to the reviewer; it sends no invitation itself.
4. The new account verifies the approved native email/phone, opens the original `/guardian-recover#token=…` link and explicitly accepts. Email confirmation returns to `/guardian-recover` without putting the claim token in a query/callback; the Guardian reopens the original private link. An old account with any verified native factor requires an independently verified replacement TOTP/AAL2 account before acceptance.
5. Acceptance rechecks the native claimant, exact contact, current independent officers and the reviewed old-account/child snapshot under database locks. Changed roles, contacts, factor state or child mapping require a new review. An existing destination UID remains pinned: recycling its contact onto a different UID does not transfer the case.

The old account must be a single active, verified, same-school Guardian-only identity with an unambiguous mapping. Replacement accounts must be active, verified at claim, unassigned and school-compatible. Anonymous, banned/deleted/inactive, mixed-role, cross-school and ambiguous mappings fail closed. No platform-wide account recovery or staff-factor reset is added.

## Preserved data and immediate access changes

The existing `parents.id`, pupil IDs and `student_parents` rows/permissions stay in place. Acceptance changes the Guardian's linked profile to the verified replacement account. Attendance, fees/payments, homework/results, leave history and their original actors are not rewritten. `registered_mobile` mirrors the replacement's confirmed native phone, or clears when it has no confirmed phone; an old number is not silently retained as the recovered identity's verified contact.

The old profile becomes inactive and loses its school parent role. Its pending invitations are revoked. Its native Auth identity, factors and sessions are retained; this is **school-access revocation**, not a native global logout/account deletion. The old login cannot use retained tokens to reopen school data through the protected application/database boundary.

Notification history uses a private **time-bounded previous-recipient alias** for the same stable Guardian. Existing eligible absence/result/leave IDs and read timestamps remain; current child/role/source rules still apply. Events addressed to a retired login after its recovery cutoff are excluded. Repeated recovery retains earlier cutoff boundaries without rewriting immutable event recipients or copying another Guardian's read state.

Old Guardian push devices are revoked with generation fencing, queued/leased jobs are cancelled and enabled push preferences are turned OFF. Device ownership/proofs are not transferred. The new login must separately opt in and register its own fresh installation when push is activated. Peer Guardians, Students and their delivery/read state stay independent. This does not recall an externally delivered notification; provider sending remains OFF in this release.

## MFA-aware email and mobile changes

Email change stays on the same Auth UID and stable Guardian/child relationships. `/auth/contact/email` verifies the current native owner, Guardian role and MFA status before initiating the provider's PKCE email update in an isolated client. Per-flow code-verifier/context cookies are separate from ordinary application cookies, short-lived and HttpOnly; token cookies are never persisted for this contact client. The callback checks the one-use native code, exact returned UID and confirmed target email. The first secure email confirmation does not become final verification. Both native inbox confirmations remain required when secure email change is enabled. The callback cannot install recovered A tokens into an ordinary B session, and closes only a distinct temporary native session that it actually owns.

Mobile change proves current credentials in a separate, memory-only native session: current password for email-backed accounts, current-number OTP for phone-only accounts. If that proof session requires MFA, the form selects its owned authenticator and verifies a current code **on that same session**, then requests new-number verification. It never copies the proof tokens into the shared browser client. Wrong code can retry; cancellation, account change and unmount close/discard the temporary proof. The final native number confirmation still determines the verified contact; failed or unavailable sending does not unlink children. SMS/CAPTCHA/provider funding gates remain in force and paid sending is OFF.

## Database and browser boundaries

Applied source migration: `supabase/migrations/20261107064340_governed_guardian_account_recovery.sql`, hosted ledger version `20261107064340`. Source SHA-256 is `337eea21336e945c6098cdad23f9cc9e0687bbe7398abc754ab523b7c62b4ea8`; hosted SQL MD5 is `178d870e3b60dcca82c461ef82e1c90a`. Four RLS-private tables hold cases, reasons/audit, actor-bound retry receipts and timestamp-fenced previous recipients. Raw API table access and internal snapshot helper execution are denied.

The public INVOKER contracts are `get_guardian_recovery_workspace`, `request_guardian_account_recovery`, `review_guardian_account_recovery`, `get_my_guardian_recovery_claim` and `accept_guardian_account_recovery`. Checked implementations own authorization and transactional changes. Native Auth session/factor foreign-key contracts are verified before migration; locks coordinate target identity, factor, role, parent/child and officer changes. A permanent stale/input conflict is PT409, not an automatically retried serialization business error.

The school list exposes at most 50 recent cases with a separate full count; admission lookup exposes at most 20 linked Guardians. The request budget is 1,000 school cases per day. Claim tokens contain 32 cryptographic random bytes and travel in URL fragments, never HTTP query parameters, public artifacts or persistent browser storage. Only their digest is stored in cases; retry/audit rows do not store token plaintext. An uncertain approval retains its original token and request ID in component memory until an exact retry confirms the outcome. Reloading/leaving can lose an unrecorded link; the UI instructs the reviewer to copy it before leaving and to cancel/reissue if lost.

Clients pin RPC Authorization to a captured, verified owner and reject malformed/wrong-school DTOs and mismatched mutation receipts. Unknown results keep the exact intent and lock workflow/school switching; known conflicts reload current records without auto-overwriting. Claim acceptance is explicit and idempotent, including a refreshed same-owner replay while the resulting access is still valid. Account changes abort UI continuations, clear private links and suppress late navigation; aborting a browser request is not a claim that an already committed server transaction was undone.

Approved phone-recovery cases enter the existing guarded SMS eligibility/budget path only while current and coherent. This adds no provider bypass, role grant before acceptance or automatic paid activation.

## Verified engineering evidence so far

- New recovery client/workspace/public-claim coverage: **77 tests across three files pass**. This includes owner-pinned JWT headers, cap/DTO validation, independent-review buttons, AAL2 setup, exact request/token retries, malformed receipts, explicit claim/signup/phone continuation, fragment-only secrets and account-switch cancellation.
- The contact-focused checkpoint passes **77 tests across six files**; it covers isolated email callback ownership/cookies, first/final confirmation, wrong-owner cleanup and staged mobile MFA/account-switch behavior. This is a focused checkpoint, not this release's whole-project total.
- A real native-provider no-send probe confirms fresh password proof stays AAL1, unauthorized phone-change authorization is denied, wrong TOTP remains gated, and correct TOTP on that proof permits only the authorized step. The original primary token bytes/session remain intact. Temporary sessions are closed and the owned authorization fixture is removed; no email/phone update or SMS send is performed.
- A real SSR contact-client probe passes **four checks**: fresh native `setSession` remains in per-request memory, subsequent session/user verification retains the right UID, and zero access/refresh-token cookies are written. Its owned temporary native session is closed.
- Scoped ESLint, TypeScript and whitespace checks pass at the focused test checkpoint. Database/full-suite, browser and deployed evidence are recorded separately below; no founder case is auto-ticked.
- Final local database suite passes **968 tests**, followed by **61 final guard regressions**; manifest alignment passes **31/31** checks. Replay now covers **92 ordered sources, 119 application tables and five views**. These are local database/replay checks, not managed Auth/Storage disaster-recovery proof.
- Hosted readback matches **34 routine definitions and execute ACLs**, local replay routine hash `29e9da7ffa610078ba251207bee7a036`, four private RLS-enabled tables with no anonymous/authenticated/service-role DML access, seven valid indexes and the preserved MFA pre-request hook.
- The final whole web run passes **2,470 tests across 165 files**, followed by successful whole-project lint, TypeScript and optimized build. Hosted synthetic recovery workflow/preservation and deployed browser evidence remain separate.

## Hosted synthetic recovery and preservation

The core real-SDK workflow passes **113 assertions** through original Guardian A → replacement B, simultaneous acceptance attempts and repeated B → C recovery. It exercises independent school review, native verified replacement contacts/TOTP, exact retries, same-parent/two-sibling preservation, former-login retained-token denial, current-child restrictions, peer recipient isolation, inbox IDs/read timestamps and device/job cancellation. The test fixture retains its original **eight attendance rows, two fee records and ₹250 recorded receipt**.

A later harness assertion incorrectly expected an absence alert deleted by an explicit child-link revoke to recreate automatically. The existing foreign-key cascade intentionally deletes that alert; this was a test assumption, not recovery losing history. The **one newly created QA alert** was restored from its exact private fixture snapshot, and the finishing stage passes **26/26 checks**. No shared original alert/history was recreated or overwritten to satisfy the test.

Separate native SQL truth checks pass **13 checks after B**, **12 final security values** and **nine exact fixture invariants**. Final SDK state has two Accepted recovery cases, two timestamp-bounded previous-recipient aliases, no open recovery cases/jobs, both synthetic devices revoked and enabled preferences OFF. Nine real verified TOTP factors belong to the owned QA identities. All **18 owned recovery/finishing native sessions** are closed, with **zero remaining** in the native session catalog at that SDK cleanup checkpoint. The later two Production browser sessions are independently observed logging out below.

The original prechange row comparison preserves the exact multiset of **2,625 original rows across 115 application tables, zero missing**; those original tables now contain 2,708 rows. New private-case/fixture additions are distinguished from preserved originals. This is a current preservation comparison, **not a backup restoration rehearsal** and not proof of managed Auth, Storage, attachment-byte or provider disaster recovery.

Earlier **50 preflight**, **12 contact no-send** and **four SSR-client** checks are separate checkpoints, not added to a fabricated single end-to-end total. Provider sending and actual inbox/carrier/device delivery remain unverified. The separate native repository's `main` is `b6bfed0`, with 217 tests and Android Expo export passing; that is source/build evidence, not observed native visual or physical-device acceptance.

## Verified Production release and read-only browser flow

Web runtime `7f503316e63c06c7dc6eebccba4d604fbfc1d624` is on Git `main`. GitHub's Vercel deployment status is Success, with Production deployment `dpl_62G5QpHTWqXm1onuN7aSi4Dujmpm` Ready, a 47-second build and 25-second post-build stage. The stable alias is `kids-corner-erp-frontend.vercel.app`. The 2,470-test regression/lint/types/build evidence is from local runs; **no separate GitHub CI test run is claimed**.

The public `/guardian-recover` returns 200 with its expected heading. The deployed public checklist returns 200 and exactly matches local bytes, SHA-256 `edb15255a1bdf8288da05f9868404e50642d535ebca8a1621cbf4e1370dbdb28`. Local actual-browser no-token entry was also observed. These public entry checks do not imply a new approval or claim was completed in the Production UI.

Actual Production Guardian C browser QA uses password plus a real current TOTP. It loads the same two linked children, ₹1,000 in fees with ₹250 paid/₹750 balance, and two inherited notifications with zero unread. Both children's attendance histories show 6 November Present and 7 November Absent. Selecting child two, waiting for Ready and then hard-refreshing preserves that selection and the correct history. Guardian contact settings shows the verified replacement email, no verified mobile and a clear SMS-OFF state. The session logs out through the UI.

Actual Production Admin browser QA also signs in with password plus real TOTP. The Account recovery tab loads five of five cases: two Accepted, one Rejected, one Expired and one Cancelled. Exact admission lookup shows the recovered Guardian with two linked children and the independent peer Guardian with its two links. The Admin session logs out through the UI.

These are **read-only school-data browser checks**. No browser approval, school-access mutation, password reset or actual email/mobile change was performed. Mutation/race/idempotency coverage remains the actual hosted SDK/SQL workflow and local UI tests above. The credentialed UI handoff, full founder checklist and real provider inbox/carrier delivery remain manual. Private screenshots and authentication proof stay outside Git/public QA artifacts. The mobile repository's `main` remains verified at `b6bfed0`; native visual acceptance was not observed.

Post-browser read-only SQL confirms **zero owned native Auth sessions**, all **2,625 original row fingerprints/115 tables preserved, zero missing/current 2,708**, and the entire post-SDK QA parent/child state unchanged: seven links, eight attendance rows, two fees, the ₹250 receipt, six alerts and their read timestamps. C remains the stable Guardian owner with two links, no open push jobs and revoked old devices. The deployment-scoped Vercel error query for the observed last 15-minute window returns zero rows successfully; this is a bounded release check, not a monitoring-drain or long-term health claim.

Production `POST /auth/recovery/mfa` and `POST /auth/contact/email` probes with valid-shaped dummy input and no Auth cookies both return **403 JSON with `Cache-Control: no-store`**. No Auth mutation or send occurs. This documentation-only follow-up records the tested `7f50331` runtime; no later application runtime or deployment ID is inferred.

## Release verification status

| Gate | Current evidence/status |
|---|---|
| Local migration/recovery replay and behavior tests | Verified: 968 database tests, 61 final guard regressions and 31/31 manifest checks; 92 sources, 119 application tables/five views. |
| Whole web regression, lint, types and optimized build | Verified: 2,470 tests/165 files plus whole lint, TypeScript and optimized build. |
| Original-row and controlled-fixture preservation | Verified exact multiset: all 2,625 original rows/115 tables preserved, zero missing; current count 2,708. Nine final exact fixture invariants pass. |
| Managed-service backup/restore boundary | Not performed in this phase; the preservation comparison does not prove Auth/Storage/provider disaster recovery. This remains an operational launch gate. |
| Hosted migration version, exact SQL/source/ACL comparison | Verified version `20261107064340`, exact source/SQL hashes above, 34 routines/ACLs, four private RLS tables and seven valid indexes; MFA hook preserved. |
| Hosted synthetic recovery, MFA/contact, preserved history and denial checks | Verified stages: 113 core SDK assertions, 26/26 finishing checks, separate 13/12/9 SQL truth/security/fixture checks; 18/18 owned sessions closed and zero remaining. One new-QA cascade alert was restored after correcting a harness assumption, as explained above. |
| Actual browser boundary | Local no-token recovery entry observed. Production recovered-Guardian/Admin password+real-TOTP → current data/settings/history → refresh → logout passes read-only; browser recovery/contact mutations remain manual. |
| Git main + Vercel Production runtime/deployment/alias | Verified runtime `7f50331`, GitHub Vercel Success, Ready deployment `dpl_62G5QpHTWqXm1onuN7aSi4Dujmpm` and stable SMS alias. |
| Deployed recovery page/checklist and authenticated refresh/readback | Public entry/checklist 200, exact checklist SHA-256 above, two-child Guardian history/selection/settings/read state and Admin recovery-list/admission readback verified. |
| Post-browser preservation, cleanup and API boundary | Zero owned native sessions, original and post-SDK fixture rows unchanged; both unauthenticated recovery-MFA/contact-email POSTs return403/no-store; bounded Vercel error scan has zero rows. |
| Founder/manual inbox, carrier and physical mobile acceptance | Pending; all public checklist boxes remain unchecked. |

## Operational acceptance still required

Current security advisors are **not clean**: 50 INFO private RLS/no-policy entries, seven legacy/generated-timetable search-path warnings, two legacy anonymous SECURITY DEFINER warnings, six legacy authenticated SECURITY DEFINER warnings and disabled leaked-password protection remain tracked. This phase's new public recovery RPCs are authenticated-only INVOKER wrappers and new private functions have fixed search paths. Existing warnings are not fixed or certified safe by passing this recovery flow; review them and the provider password-protection setting separately before real-school release.

The school must agree who may request/review recovery, how identity and new contact are verified offline, how to contact support and how links are privately shared. Rehearse with dedicated disposable accounts; do not enroll or recover a shared founder/demo identity. Native security emails may be emitted by managed Auth operations; no explicit mail send in engineering QA proves neither inbox delivery nor absence of provider security notices.

Actual old/new email inbox delivery, CAPTCHA/provider configuration, funded SMS/DLT/carrier delivery, physical mobile behavior and FCM delivery remain manual activation/acceptance work. No credentials, tokens, factor keys, live codes or pupil contact details belong in this document or the public checklist.
