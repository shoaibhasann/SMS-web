# Staff authenticator MFA — founder checklist

Use [SMS Production](https://sms-web-shoaibhasann.vercel.app/login). Record the date, deployed revision, role, device, expected result and actual result. These boxes are founder acceptance, not automated-test results.

Use dedicated MFA QA accounts supplied privately. Do not enroll a shared founder/demo login: adding its first verified authenticator signs out its other sessions. Never put passwords, QR images, setup keys or live codes in a screenshot, issue or WhatsApp group.

## Setup and sign-in

- [ ] MFA-01 — Avatar → Account settings → Authenticator. Add a named authenticator, scan its QR or enter the manual key, then verify the latest six-digit code. An unverified setup alone must not unlock the workspace.
- [ ] MFA-02 — Sign out and sign in again. The authenticator challenge must appear before school data. A wrong code keeps data hidden; a current code opens the correct account's workspace.
- [ ] MFA-03 — Hard reload after verification. Dashboard and authorized modules still load. A new independent password sign-in must challenge again.
- [ ] MFA-04 — Add and verify a second authenticator as a backup. Verify it works before removing an old device. Do not rely on a password reset to remove MFA.
- [ ] MFA-05 — Use a narrow phone viewport and keyboard-only desktop navigation. Labels, focus, errors and buttons must remain usable without horizontal scrolling.

## School rollout

- [ ] MFA-06 — Admin → Settings → Staff authenticator policy. Counts show distinct active staff, enrolled staff and enrollment gaps; multiple roles must not count one person twice.
- [ ] MFA-07 — Enabling is blocked until every active staff account has a verified authenticator. The acting Admin must also complete authenticator verification; a password-only session cannot change the policy.
- [ ] MFA-08 — On a fully prepared QA school, enable with a reason. Reload and verify saved revision/history. A Principal can read the policy but cannot change it; Teacher/Finance/Reception/family roles cannot manage it.
- [ ] MFA-09 — Open the policy in two Admin sessions. Save once, then attempt the stale save. It must request a reload instead of overwriting the newer choice. An identical uncertain retry must not create another event.
- [ ] MFA-10 — A required-school Teacher invitation must remain unclaimed until that same account has completed authenticator setup. Existing classes, attendance and family links must remain unchanged.

## Family and recovery boundaries

- [ ] MFA-11 — A plain Guardian/Student without an authenticator still sees only their own or linked child's records. A Teacher who is also a Guardian must complete the same account's MFA before either role opens.
- [ ] MFA-12 — A voluntarily enrolled family account also receives an authenticator challenge. School policy being OFF must not bypass its own verified authenticator.
- [ ] MFA-13 — In the updated native development app, an already-enrolled account can enter its authenticator code before attendance/inbox loads. Native enrollment opens the website for a separate sign-in; no account tokens are passed in the URL. After enrollment, sign out and sign in again on the phone.
- [ ] MFA-14 — Background the app or change accounts during verification. No old account's records or delayed verification result should enter the new workspace. Sign out before sharing a device.
- [ ] MFA-15 — Lost authenticator: stop and contact the authorized school/platform operator. The app must not auto-reset a factor, silently disable the school policy or grant access after only a password reset. Operator identity checks and recovery ownership must be agreed before a real-school rollout.

## Limits to acknowledge

This phase uses authenticator-app TOTP, not paid SMS OTP. It adds no automatic recovery codes or school-assisted factor-reset screen. A required school's last-authenticator removal is blocked in the UI; if a native Auth/operator action removes it, school data stays locked until valid setup/verification is restored. Global platform administrators always require MFA. Trusted backend/database operators remain privileged.

No real school policy is automatically enabled. Native device acceptance, provider delivery, lost-device recovery rehearsal and founder acceptance remain separate checks.
