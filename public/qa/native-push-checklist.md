# Founder QA — native push backend

9 November 2026 · [SMS login](https://sms-web-shoaibhasann.vercel.app/login) · Android exam schedules, homework and announcements

**Current scope:** Android can register opted-in Student and Guardian devices. New or materially updated exam schedules and first publications of section homework or eligible announcements queue generic pushes under the account’s mobile push switch. Tapping opens authenticated **Updates**, where the family can open the exact record. Guardian absence, published result and leave settings remain independent; Students do not receive absence alerts.

**Production delivery is OFF.** The Android client and queue are verified separately from sending. The Firebase HTTP v1 sender and protected recurring dispatcher must be configured before testing actual delivery.

Use the existing privately supplied Student and Guardian QA accounts. Do not include credentials, installation IDs/proofs, FIDs or provider keys in screenshots or this document. Engineering results do not tick these boxes. Confirm the current main deployment before testing.

## Check now — web account settings

- [ ] **NP-01 · Correct account.** Avatar → Account settings → Mobile push notifications. Student/Guardian see their own settings. A mixed-role account can select only its actual family contexts. Teacher/Finance alone do not receive family push controls.
- [ ] **NP-02 · Safe defaults.** The master Allow mobile push notifications switch starts OFF for an unconfigured account. Selected event choices do not enable sending by themselves. The page explains that a registered native app device and phone permission are required.
- [ ] **NP-03 · Save and reload.** Change the master/event preferences, save and hard refresh. Exactly the confirmed selection returns for this account/role. Another recipient's preferences remain unchanged. Existing in-app read status and attendance/fee history remain available. Restore the recorded QA preference baseline after testing.
- [ ] **NP-04 · Concurrent/failed save.** Change preferences in two sessions. A differing stale save keeps its selection and requests refresh. A slow/failed save does not claim success. Repeated saving does not overwrite a newer differing selection. Refresh or changing role asks before discarding a draft.
- [ ] **NP-05 · Devices and privacy.** A fresh account without registrations shows No mobile devices linked. The prepared Guardian/Student QA accounts retain two/one revoked synthetic device rows respectively; these are not installed phones. There is no web Register device/Test push control. Prepared device rows show only label, Android/iOS, registration time and revocation status; no native identifiers or secrets are exposed. Mark the revoke part Blocked if no disposable fixture exists.
- [ ] **NP-06 · Revoke safely.** For an engineering-prepared disposable device, Revoke opens an explicit confirmation. Cancel returns keyboard focus and leaves the device unchanged. Confirm persists after reload. Native automatic registration must not reactivate it; re-enrollment needs a fresh Firebase installation/FID, installation UUID and proof. Other devices, child links and school records remain intact. Unsaved preference choices are retained. Do not revoke shared founder devices without recording the baseline.
- [ ] **NP-07 · Session and layout.** Sign out/switch account during a delayed read or save; old settings/devices must disappear and late responses must not restore them. Check phone/laptop width, keyboard focus, long device labels, Light/Dark, skeletons and retry messages.
- [ ] **NP-08 · Honest availability.** Open [push backend status](https://sms-web-shoaibhasann.vercel.app/api/push/status): expect `configured: false` and `nativeAppRequired: true` while delivery is OFF. Saving preferences does not claim that a phone received an alert. In-app notifications remain testable with the existing family notification checklist.

## Android device and delivery

- [ ] **NP-09 · Real registration.** Install the actual app, sign in, accept the phone's notification permission and register the current Firebase installation. Denied permission does not show a fake successful subscription. FID/session rotation updates the own registration safely. Record Android/iOS device and app build.
- [ ] **NP-10 · Actual event flow.** Create a fresh permitted absence, result, leave, exam, homework or announcement event after opt-in. Verify job creation, provider acceptance, actual phone display and authenticated inbox opening separately. The correct currently permitted record opens after access checks. Old history is not backfilled by registering/enabling the device.
- [ ] **NP-11 · Shared phone and revocation.** Logout, account/role switch, reinstall/reset and revoked child access cannot reuse another owner's device registration or reveal their records. Revoke a disposable installation while queued; it receives no subsequent permitted send. Already displayed generic alerts cannot be recalled.
- [ ] **NP-12 · Privacy and retry.** Lock-screen content contains no child name, marks, leave reason or private record reference. Offline phones, provider rate limits/errors, expiry, long Retry-After and lost acknowledgements follow the bounded retry rules. A duplicated scheduler request does not create duplicate source jobs. Occasional repeated generic display after an unknown send acknowledgement is not an exactly-once guarantee.
- [ ] **NP-13 · Delivery versus read.** Provider Accepted is recorded as provider acceptance only. Phone display/open and in-app Mark as read are separate observations. A push send never silently marks the inbox item read.
- [ ] **NP-14 · Running schedule.** The operator verifies the real protected recurring dispatcher and its cadence/history, including a new event while nobody has the website open. One manual dispatch pass is not proof of an active schedule.

## Exam schedule push

- [ ] **NP-15 · Schedule and tap.** On an updated Android build, use a disposable Student or linked Guardian account, allow notifications and register the phone. After the operator verifies sending, background the app. Save a synthetic exam in the linked class/section. Confirm one queued job, FCM acceptance, and the neutral notification in the Android tray separately. Tap it → **Updates** → **View exam schedule**. Verify date and instructions and confirm the update is still unread.
- [ ] **NP-16 · Save and reschedule.** Repeat the same schedule save: no new job. Change the date or instructions: one new eligible job per opted-in device; the superseded revision must not send. Refresh **Updates** and the exact schedule. Confirm only the new revision is shown and explicitly marking it read persists.
- [ ] **NP-17 · Suppression.** Keep a disposable Guardian’s job pending. Revoke the only qualifying child link, disconnect the device, or complete the exam before dispatch. No new push should send for that account/device. A different section must not receive the exam; a Guardian with two qualifying siblings must get only one job per device. No lock-screen alert may show a pupil, exam title, marks or private IDs.

## Homework push

- [ ] **NP-18 · Publish and open.** After delivery is enabled, opt in and register a disposable Student or Guardian Android installation. Save homework as a draft: no job. Publish it for the linked class and section: confirm one job for the device, FCM acceptance and the generic phone alert separately. Tap → **Updates** → **Homework** → **Open in SMS Web**. Sign in on the web if prompted and confirm the exact homework opens and the update is still unread.
- [ ] **NP-19 · Dedup and access.** A linked Guardian with two children in the section should receive one job per device. Editing or republishing the same homework must not create another job. Repeat with a different section and with push disabled. Before dispatch, unpublish the homework or revoke the Guardian’s last qualifying child link; verify the pending job cannot send. The lock screen must not show homework titles or student details.

## Announcement push

- [ ] **NP-20 · Target and open.** After delivery is enabled, register an opted-in Student or Guardian Android installation. Publish a new notice for that role and class or section. Confirm one queued job per eligible device, provider acceptance, and the generic alert in the Android tray. Tap → **Updates** → **Announcement** → **Open in SMS Web**. Sign in if prompted and check the exact notice and its unread status.
- [ ] **NP-21 · Audience and suppression.** Repeat with a different role or section, an opted-out device, and a Guardian with two qualifying children. Check for zero jobs outside the selected audience and one job for the Guardian device. Narrow the audience, unpublish or expire a notice while its job is pending and check that the worker suppresses the send. Editing, republishing the same notice, and opting in later leave the job count unchanged.
- [ ] **NP-22 · Schedule and reschedule.** Schedule a notice for a future date, then change its publish date before it goes live. Check that the same jobs are due at the updated time and the phone stays quiet before publication.

| Release / tester | Entry |
|---|---|
| Stable URL | https://sms-web-shoaibhasann.vercel.app/login |
| Engineering verification | Hosted homework and announcement queue checks passed. Phone receive and tap checks are pending. |
| Native app/build/device | Android development build available; install the updated app bundle |
| Delivery/provider/schedule activation | OFF / not verified |
| Tester, IST time, browser/device | |
| Overall result | Pending |

| Case / role | Expected → actual | Evidence / IST time | Pass / Fail / Blocked |
|---|---|---|---|
| | | | |
