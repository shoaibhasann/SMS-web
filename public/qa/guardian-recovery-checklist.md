# Guardian recovery and contact changes — founder checklist

Use [SMS Production](https://kids-corner-erp-frontend.vercel.app/login) after the release owner confirms the new runtime is deployed. Record deployed revision/date, role, device, expected/actual result and a redacted issue reference. These unchecked boxes are founder acceptance, separate from engineering tests.

Ask for dedicated QA accounts privately: two different School Admin/Principal reviewers, a Guardian with two children and existing history, an unassigned replacement account, a peer Guardian and a wrong-school/Teacher account. Do not recover a shared founder/demo account. Never share passwords, claim/confirmation links, QR/setup keys, live codes or pupil contacts in screenshots or public issues. Use test inboxes/numbers you control; do not enter Aadhaar or documents in a reason.

## Recover a registered-email account

- [ ] GR-01 — Request Forgot password for a QA Guardian. The response must remain generic for known/unknown emails. Receive and open the real email in the requesting browser; inbox delivery is a manual provider check.
- [ ] GR-02 — For a Guardian with an authenticator, the reset page must request its code before allowing a new password. Wrong code stays locked; a current owned code unlocks. A reset email alone must not remove/bypass MFA.
- [ ] GR-03 — Set a new password, then sign in again and hard refresh Attendance/Fees. The same children and saved history remain. The old password fails; the authenticator remains enrolled. Expired/reused reset-session errors offer a fresh request.

## Independently reviewed school recovery

- [ ] GR-04 — Admin/Principal → Guardian invitations → Account recovery. A password-only session must require current authenticator setup/verification, even when general school MFA policy is optional. Teacher/family/wrong-school accounts cannot manage these cases.
- [ ] GR-05 — Search the exact QA student's admission number. Select its existing Guardian and confirm the expected linked-child count. Unknown/ambiguous or ineligible mixed-role mappings must not grant recovery access.
- [ ] GR-06 — Enter the new controlled email or Indian mobile and a school-verification reference, then Request independent review. Reload: one Pending case remains with its version/expiry; the case history shows a bounded latest count and a separate total. No child access changes yet.
- [ ] GR-07 — In the requesting account, approval/rejection of that same case must not be available or accepted. Sign in as the second Admin/Principal, verify its authenticator, independently check the identity/new contact, and approve with a reason.
- [ ] GR-08 — Copy the private approved recovery link before leaving. It must contain the secret after `#`, not a query parameter. Share it privately with the verified QA recipient only. Approval itself must not create a school role, send an OTP or automatically link the replacement account.
- [ ] GR-09 — Open that link with the wrong account or an already assigned Student/Teacher/Guardian account. Acceptance must fail without merging identities or changing existing links. Use a different account to continue with the approved recipient.
- [ ] GR-10 — For a new email account, complete native email confirmation, then reopen the original private recovery link. Signing in/confirming alone must not accept the school recovery. If the old Guardian had an authenticator, use Set up or verify account security on the replacement account and return to the same original link; no claim secret belongs in the MFA query.
- [ ] GR-11 — Review the intended school/linked-child count and explicitly Accept account recovery. Attendance opens. Hard refresh and switch both children: attendance, fees/receipts, homework/results and leave history still belong to the same pupils; peer children stay hidden.
- [ ] GR-12 — Sign in with the retired login/retained QA session. Native Auth may still recognize that login, but school data must be denied. Existing child permissions remain with the recovered Guardian; other Guardians and their sibling access are unaffected.
- [ ] GR-13 — Reopen/retry the accepted link as the same replacement account. It must recover the existing outcome without another Guardian, child link, acceptance event or access grant. A different account cannot reuse it.
- [ ] GR-14 — On separate disposable cases, reject, cancel and let an unclaimed approval expire. Those links cannot recover access. Only the requester or recorded reviewer may cancel an open case. A revoked officer or changed guardian/contact/child mapping must require a fresh review.
- [ ] GR-15 — Have two authorized reviewers open one version. Save once, then submit the stale review. It must show a conflict/reload instead of overwriting. If a result is unknown, retry that exact request; competing actions stay disabled and no extra approval/link is issued. Do not manufacture a new request just to retry.

## Notifications and devices after recovery

- [ ] GR-16 — Before recovery, record only redacted counts/read states for old absence/result/leave notifications. Afterwards, eligible old entries and saved read status remain on the recovered Guardian. All/Unread, mark-one, Mark all and refresh work; the peer Guardian's state stays separate.
- [ ] GR-17 — Revoke one child's permission in a disposable fixture: its restricted history disappears from the recovered account while the sibling remains. Events addressed to the retired login after recovery must not appear through historical-recipient access.
- [ ] GR-18 — Old Guardian push devices/preferences must not transfer to the replacement login; old registrations/queued sends are revoked or cancelled. New-device opt-in/registration is separate. Physical device/FCM delivery is a later manual activation check; sending remains OFF now.

## Change a contact on the same account

- [ ] GR-19 — Avatar → Account settings → Guardian contact. Request an email change on the QA account. With secure email change enabled, complete the old and new controlled inbox confirmations; the first confirmation alone must not mark the change complete. Reopen settings/refresh and verify the final confirmed email and the same child history.
- [ ] GR-20 — In a separate browser/tab, make another QA account current while an email confirmation is pending. Opening the callback must not replace that account's ordinary login with the first Guardian's tokens. Sign in as the original Guardian to verify its actual contact state. This is a dedicated two-account test, not a shared founder login.
- [ ] GR-21 — With funded phone delivery still OFF, attempting a mobile change/recovery must show a clear unavailable/setup state and preserve links/current verified contact. Do not tick actual OTP delivery from a mock or database success.
- [ ] GR-22 — After the provider is explicitly activated, an email-backed Guardian must prove current password; a phone-only Guardian proves the current number. An enrolled account then verifies its owned authenticator in that temporary proof flow. Wrong code retries safely. Only a confirmed OTP to the new number completes the change; refresh preserves both children. Actual carrier/billing/DLT acceptance is manual.
- [ ] GR-23 — Cancel, navigate away, sign out or switch accounts during temporary proof, review, claim or contact confirmation. No previous account's private link, delayed success/navigation or child records may enter the new workspace. An already committed server action must be reconciled by reload/exact retry rather than assumed undone.

## UX and handoff

- [ ] GR-24 — At laptop and narrow-phone widths, use keyboard/tab and touch through search, review, MFA, errors and reload. Labels/focus/disabled states remain clear, long contacts wrap, and there is no horizontal page overflow. School staff agree the offline identity-check process, independent requester/reviewer ownership, private link handoff and support route before real-school use.

Actual inbox/carrier delivery, physical native-device acceptance and school/founder sign-off remain separate. This feature does not delete native accounts, reset lost staff authenticators, add recovery codes, activate paid SMS/FCM or certify managed-service disaster recovery.
