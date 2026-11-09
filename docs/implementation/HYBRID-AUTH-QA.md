# Hybrid guardian authentication — 6 November 2026

## Implemented scope

- Existing email/password, Google and teacher/email invitations remain available.
- Guardian mobile sign-in uses Supabase OTP and sessions; MSG91 only delivers the Supabase-generated code. No separate OTP verification engine or automatic phone-to-child linking exists.
- Admin/Principal can issue a phone-bound guardian invitation. A new guardian needs no email/password. An authenticated, verified recipient must explicitly accept the bearer link; the token stays in the URL fragment.
- Existing email guardians enroll a verified mobile on the **same Auth user** through contact settings using current-password proof. Phone-only guardians verify the current number before requesting/confirming a new number. Old invitations are retired when a verified phone changes; sibling links and historical attendance/fees stay with the same user.
- Wrong-school, revoked/expired invitations, inactive recipients, ambiguous existing school records and mismatched recipients are rejected. An account holding any non-parent role cannot use this guardian OTP sending path. Native empty/null emails are handled without inventing an email or password.
- Mobile-only settings show mobile recovery guidance and do not offer email-password recovery as if a password existed.
- `/auth/phone/status` exposes only readiness and the public Turnstile site key. Missing configuration leaves SMS unavailable and preserves existing email access.

This phase does **not** deliver push notifications, result/leave SMS, email OTP login, staff MFA enforcement, lost-number administrative recovery, a messaging wallet, subscription billing or multi-school guardian accounts. Existing absence alerts remain database-backed in-app notifications.

## Sending boundary and spend protection

1. Browser completes a Turnstile challenge with action `guardian-otp`.
2. `POST /auth/phone/permit` verifies the token server-side, checks the exact configured Origin/hostname and derives a keyed hash of the trusted client IP. It issues a 90-second, single-use private database permit.
3. Supabase Auth requests the code. The signed Send SMS hook is checked against its raw body, timestamp and event identity. New native GoTrue payloads carry the actual destination in `sms.phone`; both `91…` and `+91…` normalize to canonical Indian mobile format.
4. A service-only RPC checks eligible school/recipient, consumes the CAPTCHA permit and atomically reserves global, school and phone allowance under transaction locks before MSG91 is called. Direct public Auth requests without a permit cannot dispatch a paid message.

Sixty-second per-number cooldowns apply. Permit issuance is additionally bounded to 20 requests/IP/hour and 1,000 globally/IST day for this pilot. Daily billed-attempt limits are explicit server configuration (maximum global10,000, school1,000, phone10). These are **attempts**, not delivered SMS or successful logins. Initial onboarding behind a shared school/carrier NAT must be tested before increasing funded limits.

Timeout/failed dispatch consumes reserved allowance. An identical webhook never sends again; an undelivered code requires a fresh user request after cooldown. Permits retain only hashed destination/keyed IP; reservations retain user/school IDs and hashes, never OTPs. Hashes remain pseudonymous personal data. Opportunistic cleanup removes at most500 expired permits older than7days and reservations older than30days per call; idle environments have no guaranteed timed deletion.

The documented MSG91 endpoint includes destination/code in its query string. Do not enable full outbound URL/body tracing on this endpoint; exclude authentication secrets and delivery payloads from logs and telemetry.

## Provider activation checklist — still required

- [ ] Obtain school/founder-approved budget, sender ownership and recipient authorization. Confirm provider pack pricing, charges on failure and applicable DLT entity/header/template setup.
- [ ] Create the MSG91 API key and approved **OTP template**. Do not paste secrets in chat, Git or founder-facing Markdown.
- [ ] Configure a production Turnstile site for the stable app hostname, action `guardian-otp`, and its public site key/server secret.
- [ ] Set the server variables documented in `.env.example`: MSG91 key/template, Supabase service-role key, Supabase Send SMS hook signing secret, exact production origin, Turnstile keys and all three daily limits. Leave `GUARDIAN_PHONE_AUTH_ENABLED=false` until the remaining checks are ready.
- [ ] Configure Supabase Phone authentication and its HTTPS Send SMS hook to `https://sms-web-shoaibhasann.vercel.app/auth/send-sms`; require verification, **phone auto-confirm off**, six-digit codes, short OTP expiry and Auth rate limits. Keep email provider and existing recovery configuration intact.
- [ ] Do not enable global Supabase CAPTCHA as part of this rollout: existing staff/email recovery clients are unchanged. This phone path verifies CAPTCHA through its own server permit, enforced by the SMS hook.
- [ ] Confirm the hosted Auth version supplies the actual phone-change destination in `sms.phone`. Older payloads lacking that field must be upgraded/tested before mobile-change activation; never silently send a change code to the old number.
- [ ] Switch the phone flag on only on the funded environment, redeploy, and confirm `/auth/phone/status` returns enabled. Fixed test OTPs belong only in an isolated local/test Auth project, never this shared production project.
- [ ] Verify real delivery to consented QA SIMs on different carriers, wrong/expired code denial, resend throttling, webhook retries, provider downtime, exhaustion and restoration of allowances.
- [ ] Keep custom SMTP for confirmation/recovery emails. Supabase's default mailer is not production delivery. Staff authenticator MFA remains a separate implementation milestone.

## Founder acceptance after activation

- [ ] Existing email Admin/Teacher/Student/Guardian logins and sign-out still work after refresh.
- [ ] From Guardian invitations, select a current pupil and **Mobile OTP**, enter the authorized Indian number, copy the private link and open it signed out.
- [ ] Verify OTP, accept explicitly, open linked attendance, refresh and confirm only authorized children appear. Reopening an accepted/revoked/expired link cannot create another relationship.
- [ ] Existing email guardian: record child selection/history, verify a new mobile from contact settings, sign out, use Guardian mobile and confirm the same account/children after refresh.
- [ ] Phone-only guardian: verify current-number code, authorize new number, verify its separate change code. New-number login works; old-number login and old pending invitations do not restore access. Child links/history remain intact.
- [ ] Revoke one child link, retain another, then re-invite from Manage linked guardians. Attendance and fee history remain unchanged; revoked-child alerts/records stay inaccessible until explicit authorized reacceptance.
- [ ] Unrelated numbers, wrong-school users and Admin/Principal/Teacher/Finance/Student accounts cannot gain guardian access or use OTP to bypass staff sign-in.
- [ ] Phone-only account settings offer contact guidance and school-assisted lost-number recovery. No email/password requirement appears as a prerequisite for routine mobile login.
- [ ] Test a small phone, keyboard-only navigation and actual target devices. Denied CAPTCHA, blocked scripts, poor connectivity and provider failure give usable retry/help feedback without clearing existing school data.

## Evidence boundaries

Automated UI/client, service route and recovered-database checks exercise the implemented lifecycle. They do not prove actual carrier delivery, billing, a live provider configuration or native managed-Auth transactions. Local embedded database checks are serial; quota functions use PostgreSQL transaction advisory locks, but a native simultaneous-connection budget race test remains required before paid activation.

The private pre-change snapshot covers seven affected application tables/301rows and eight replaced routines. Its embedded restore check excludes native Auth credentials, storage objects and provider configuration. The hosted migration is applied and the affected rows plus attendance/fee/payment fingerprints remain unchanged. Final checks pass1,816tests across139files, whole-project lint and optimized build/TypeScript. Seven existing QA email accounts pass native Auth/PostgREST access probes; all owned sessions are closed. These probes send no SMS and do not establish native phone-Auth or carrier delivery success.
