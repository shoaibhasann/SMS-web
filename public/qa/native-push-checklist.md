# Founder QA — native push backend

6 November 2026 · [SMS login](https://sms-web-shoaibhasann.vercel.app/login) · Backend now, native app next phase

**Current scope:** prepare mobile notification preferences and manage registered app devices. Guardian app alerts cover absence/results/leave; Student app alerts cover results/leave. Student settings must not advertise absence delivery. The native app and real phone delivery are not included in this backend slice. Sending and the recurring dispatcher remain OFF until setup is verified. No SMS/email/push success should be inferred from a preference save.

Engineering verified runtime `a710c3e` on the stable main/Production URL. Guardian save/reload/restore and Student own-device isolation pass; founder acceptance below remains pending. Delivery is OFF.

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

## Check later — blocked until the native app and delivery setup exist

- [ ] **NP-09 · Real registration.** Install the actual app, sign in, accept the phone's notification permission and register the current Firebase installation. Denied permission does not show a fake successful subscription. FID/session rotation updates the own registration safely. Record Android/iOS device and app build.
- [ ] **NP-10 · Actual event flow.** Create a fresh permitted absence/result/leave event after opt-in. Verify job creation, provider acceptance, actual phone display and authenticated inbox opening separately. The correct currently permitted child's record opens after app access checks. Old history is not backfilled by registering/enabling the device.
- [ ] **NP-11 · Shared phone and revocation.** Logout, account/role switch, reinstall/reset and revoked child access cannot reuse another owner's device registration or reveal their records. Revoke a disposable installation while queued; it receives no subsequent permitted send. Already displayed generic alerts cannot be recalled.
- [ ] **NP-12 · Privacy and retry.** Lock-screen content contains no child name, marks, leave reason or private record reference. Offline phones, provider rate limits/errors, expiry, long Retry-After and lost acknowledgements follow the bounded retry rules. A duplicated scheduler request does not create duplicate source jobs. Occasional repeated generic display after an unknown send acknowledgement is not an exactly-once guarantee.
- [ ] **NP-13 · Delivery versus read.** Provider Accepted is recorded as provider acceptance only. Phone display/open and in-app Mark as read are separate observations. A push send never silently marks the inbox item read.
- [ ] **NP-14 · Running schedule.** The operator verifies the real protected recurring dispatcher and its cadence/history, including a new event while nobody has the website open. One manual dispatch pass is not proof of an active schedule.

| Release / tester | Entry |
|---|---|
| Stable URL | https://sms-web-shoaibhasann.vercel.app/login |
| Verified feature source / deployment | Pending release verification |
| Native app/build/device | Not available in this backend slice |
| Delivery/provider/schedule activation | OFF / not verified |
| Tester, IST time, browser/device | |
| Overall result | Pending |

| Case / role | Expected → actual | Evidence / IST time | Pass / Fail / Blocked |
|---|---|---|---|
| | | | |
