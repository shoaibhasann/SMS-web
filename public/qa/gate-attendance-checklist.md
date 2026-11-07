# SMS — student gate attendance pilot

7 November 2026 · Founder acceptance pending · Backend QA and physical-device acceptance are separate

Use the stable [SMS Production login](https://kids-corner-erp-frontend.vercel.app/login). Confirm that the gate backend release is deployed before running these cases. Ask the engineering operator to prepare the isolated synthetic test fixture and provide private school accounts. This checklist contains no device secrets or login credentials.

No physical attendance device has been selected or tested. An accepted synthetic event proves only the implemented backend outcome; it does not prove a real pupil arrived, biometric identity, a hardware adapter or notification delivery. There is no implied device-management screen. The existing Attendance pages remain the canonical register/history UI.

The first backend policy uses the current date in Asia/Kolkata, configured weekdays and a late cutoff. Older/offline dates, over-two-minute future clocks, approved leave, pending/reviewed corrections, same-day placement changes and conflicting manual marks are held for review. A held event is retained evidence; no event-resolution screen is included. An earlier same-day IN can improve only its unchanged device-owned mark. Full holiday-calendar/overnight rules remain separate.

Record the tested release, date, school, role, expected/actual outcome and a screenshot without credentials or private pupil data. All boxes remain unchecked until independently tested.

## Synthetic backend and existing web attendance

- [ ] **GA-01 — Eligible IN:** The operator sends one supported mapped QA IN. Open the correct daily class register; exactly one pupil receives Present/Late according to its configured rule.
- [ ] **GA-02 — Late boundary:** Exercise the configured boundary with separate synthetic pupils. The canonical dates/statuses agree with the documented school timezone and rule; no guessed device time is presented as verified.
- [ ] **GA-03 — Replay/retry:** Repeat the same QA event, including an unknown-response retry. Attendance and retained side effects appear once. Reusing its ID with changed content cannot silently change the result.
- [ ] **GA-04 — OUT:** Test IN then OUT, repeated OUT and OUT without IN. OUT never deletes presence, marks a pupil Absent or invents Half Day.
- [ ] **GA-05 — Family refresh:** Student and linked Guardian Attendance show the same saved daily mark after hard refresh. Another pupil/child/school is not exposed.
- [ ] **GA-06 — Existing marks:** Manual marks and a reviewed correction remain unchanged when a conflicting synthetic IN arrives. Separately test an earlier IN against an unchanged device-owned mark, then after a manual revision. The operator identifies the explicit outcome.
- [ ] **GA-07 — Leave/non-working day:** Approved leave, a configured non-working weekday and an existing Holiday/non-presence mark follow the documented hold policy. The scan cannot silently overwrite history or remove retained absence-alert read state. This does not certify a full school holiday calendar.
- [ ] **GA-08 — Identity/placement:** Unknown, ambiguous, replaced, foreign-school or inactive identities and withdrawn/stale pupil mappings create no official mark. Existing transfer/promotion history remains correct.
- [ ] **GA-09 — Clock/direction:** Unsupported direction, future/old/offline event and midnight/timezone cases follow the supported limits. An old event cannot be applied to today's class by guessing.
- [ ] **GA-10 — Machine access:** The operator demonstrates wrong/revoked credentials and changed-payload replay denial. Never paste a device secret, signature or server key into this checklist.
- [ ] **GA-11 — Register coverage:** One gate mark does not fill the rest of a class. Complete/Partial describes the current saved roster marks; it is not teacher submission or period-by-period presence proof.
- [ ] **GA-12 — History safety:** Refresh the QA pupil's older attendance, fees/payments and linked siblings. Original records, child links and existing inbox read state remain intact.

## Physical unit and delivery — not closed by synthetic QA

- [ ] **GA-13 — Official hardware contract:** Confirm the actual model/firmware, supported licensed protocol/SDK, device authentication, stable event IDs, time/direction semantics and identity method with official documentation and a test unit.
- [ ] **GA-14 — Offline and real queue:** Test real IN/OUT, loss/reconnection, replay, restart, replaced identity, clock drift and peak arrival queue/throughput on the actual gate device. Compare its evidence with the canonical register.
- [ ] **GA-15 — Phone delivery:** Only after separate activation, verify an eligible opted-in Guardian on a real Android phone, then revoke the link/device and repeat. Record queued/provider accepted/phone displayed/opened/read separately. No SMS/FCM delivery is claimed by this release.
- [ ] **GA-16 — School acceptance:** Approve cutoff/conflict/absence/leave/holiday rules, outage/manual fallback, exception reviewers, data retention and support/device replacement ownership before a real-school pilot.

Optional Guardian arrival/exit inbox alerts and per-child default-OFF choices are tracked separately in the [gate-alert checklist](gate-alerts-checklist.md); confirm that follow-up is deployed before testing its UI. Absence alerts remain independent and missing scans do not create absence. Separate late alerts, vendor adapters, physical-device acceptance and actual phone/provider delivery remain open. Paid messages and real push sending stay OFF until explicitly configured and accepted.
