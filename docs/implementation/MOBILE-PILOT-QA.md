# Separate React Native family pilot

6 November 2026 · Local Android development build · Not an app-store release

The app is a separate `sms-mobile` repository/folder, outside the Next.js frontend. Native React Native screens cover verified Guardian/Student email sign-in, current linked-child selection, read-only attendance, family Notifications All/Unread and saved read actions, account context and explicit Android push enrollment/cleanup. Result/leave detail actions use fixed links to the existing authenticated school website; native homework, results/report-card and leave screens remain the next app slice.

The existing school APIs/RLS are reused. No new SQL, school source mutation, automatic signup/linking, staff access, browser WebView or offline pupil-record cache is introduced. Session-bound API clients prevent delayed actions from borrowing another account's token; encrypted native session storage and account/device cleanup are independently tested.

## Verified engineering scope

- 89 tests across four mobile test files, including nine actual AuthProvider lifecycle flows, serialized storage races, native SDK session-corruption regressions, strict family response boundaries and push lifecycle cases. Full TypeScript and ESLint pass.
- Actual hosted SDK read/reload for Guardian/Student: each has one authorized pupil and30retained attendance rows; foreign pupil access and Teacher-only family access are denied. Existing notification counts/read timestamps remain exact. A revoked old session cannot apply mark-all using a subsequent account. Three owned SDK sessions are signed out; zero school source writes/provider sends.
- Expo Doctor20/20, production Android JS export, Android Firebase prebuild and Gradle debug APK build pass. Google Services4.5.0, matching Android application `tech.iamshoaib.sms`, FID opt-in, default auto-init OFF and bundled notification icon/color resources are verified.
- The local development app launches in the owned Android36 emulator using Metro8087. The user observed the initial login and requested a redesign; the updated native form now has compact branding, an illustration, aligned inset-icon fields and an integrated password reveal. Automated native visual/interaction acceptance is not claimed because the available computer-use surface does not expose qemu. Physical-device, large-text/TalkBack and founder acceptance remain unchecked in the app checklist.

The supplied `google-services.json` is client configuration stored in the app's ignored private folder. It does not activate Firebase server sending. No sender private key, Supabase service-role key or dispatch secret is placed in the app. Real FCM sending, recurring scheduling and paid OTP remain OFF. No physical phone display/delivery pass is claimed.

## Remaining work

See [the current web backlog](WEB-REMAINING.md). The commercial web ERP remains incomplete despite implemented daily attendance, guardian/roster, selected academic and finance workflows. Mobile work does not close web demo modules, staff MFA, clean-school provisioning, bilingual UX, term report cards, period attendance, finance migration/refund gaps or commercial recovery/acceptance gates.

The mobile repository's `README.md`, `docs/MOBILE-QA.md` and `docs/brand-guidelines.md` contain local run instructions and unchecked founder cases. Native GitHub publishing, release signing/EAS/app-store setup, iOS/APNs and real FCM device delivery are separate steps. A debug APK requires Metro; it is not a signed commercial release.
