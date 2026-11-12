# Founder checklist — hybrid guardian sign-in

App: https://sms-web-shoaibhasann.vercel.app/login

**Mobile OTP is implemented but not activated.** Existing email/password and Google access remain available. Real SMS requires approved MSG91 delivery, Turnstile, Supabase phone/hook configuration and a funded sending allowance. No real OTP-delivery pass is claimed yet.

## Check now

- [ ] Existing demo credentials still sign in; refresh retains the correct school and role.
- [ ] Login has Email & password / Guardian mobile choices. Without delivery configured, Guardian mobile explains availability and leaves email sign-in usable.
- [ ] Account settings, appearance and explicit sign-out continue working.
- [ ] Admin/Principal Guardian invitations supports Email and Mobile OTP, with current pupil/class selection. Copy links privately; do not put invite tokens or passwords in this checklist.
- [ ] Existing email invitations, teacher invitations and guardian CSV imports still work.

## Check after funded SMS activation

- [ ] School-issued mobile invitation → real SMS OTP → explicit acceptance → linked child's Attendance → hard refresh.
- [ ] Wrong number, wrong/expired code and expired/revoked/reused invitation fail safely.
- [ ] Existing email guardian enrolls the number on the same account first; mobile login shows the original children and preserved attendance/fee history.
- [ ] Phone-only guardian verifies the current number, then separately verifies the new number. Refresh and fresh sign-in preserve the account; old-number login does not regain access.
- [ ] Revoke one child while retaining a sibling, re-invite from Manage linked guardians and confirm only the authorized link is restored.
- [ ] Staff/Admin/Finance/Student accounts cannot use guardian OTP as an alternate path to their higher-level workspace.
- [ ] Resend cooldown, wrong-code limits, repeated webhook delivery, SMS failure and daily allowance exhaustion never cause duplicate sends or unexpected links.
- [ ] Phone-only settings explain mobile access and school-assisted recovery, without requiring an email/password for routine sign-in.
- [ ] Phone-only guardian sets an app password (at least 8 characters) in guardian contact settings with a fresh current-mobile code, stays signed in on the web, and signs in to the SMS Android app with the mobile number and that password.
- [ ] With SMS verification disabled for the school, a phone-only guardian sees no Set app password link in Account settings; Account settings and the App password card say the school office must enable mobile verification or add an email.
- [ ] When the verification settings read fails or hangs, Account settings still shows the account details and both pages show a neutral temporarily-unavailable message with a retry instead of the school-office message.
- [ ] Test real target phones, shared-school Wi-Fi, different mobile carriers, slow internet, blocked security scripts and keyboard navigation.

## Commercial boundaries

OTP usage and notification delivery are separate. Existing absence alerts are in-app. Push, result/leave SMS, automated WhatsApp delivery, staff MFA and lost-number administrative recovery are separate pending work. Agree the school's included OTP allowance and extra-message billing before enabling paid delivery.
