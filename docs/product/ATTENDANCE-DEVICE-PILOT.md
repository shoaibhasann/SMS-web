# Attendance device and notification pilot

7 November 2026 · Confirmed pilot: student gate IN/OUT · No device selected or available yet

The user confirmed that an attendance device does not exist yet and its first use will be student gate entry/exit. Classroom and staff device capture are outside this pilot. No vendor/model, purchase, adapter, real punch, biometric verification or hardware acceptance is claimed. This brief records decisions for the next phase; it does not replace the current school attendance register or an approved school policy.

## Decide before purchasing or implementing an adapter

| Decision | Required input/evidence | Current status |
|---|---|---|
| Operational goal | Student gate entry/exit; identify authorized gate operators and exception reviewers. | Student gate IN/OUT confirmed by the user. School operating rules and reviewer ownership remain open. A gate punch must not silently become official classroom attendance. |
| Identification method | Card/RFID, another school identifier, or a biometric device; enrollment/replacement process and a non-device fallback. | No choice made. Do not assume every pupil can or must use biometrics. |
| Vendor/model and access | Exact model/firmware, official API/SDK documentation, license/access rights, a test unit and sample event export. | Required before a compatibility claim or purchase recommendation. |
| Transport and authentication | Supported webhook/pull/SDK/export method, network requirements, credentials, event IDs and offline backlog behavior. | Unconfirmed; do not assume a dashboard or USB export provides a usable cloud API. |
| School identity mapping | Stable school/student identifier, card/device identity, enrollment dates, replacement-card history and ambiguous-ID handling. | The existing pupil ID/admission history remains canonical; no matching by name alone. Withdrawn pupils and replaced/shared identities require explicit review. |
| Time and event meaning | Device timezone/clock sync, UTC offset, IN/OUT semantics, overnight sessions, restart sequence and clock correction behavior. | Confirm with real sample events; do not manufacture an IN/OUT direction from a timestamp. |
| Attendance policy | Working days, holidays, leave, half-days, late cutoff, missing punches and the review/correction authority. | School approval required; absent/unmarked/rate rules cannot come from demo values. |
| Privacy and operations | Which data is needed, retention, authorized staff, device loss/replacement and the school's notice/support process. | Define before collecting production data. No raw biometric template/image storage is proposed in SMS. |
| Delivery and support | Existing native app distribution, real test phones, notification opt-in, provider credentials/schedule, connectivity and support ownership. | Firebase client configuration/backend code alone does not prove delivery. |

Obtain documentation and a controlled test unit before committing to hardware. There are no vendor, pricing, accuracy or compatibility claims in this brief.

## Proposed software boundary

1. A dedicated school/device connector receives supported vendor events. Device credentials are separate, scoped and revocable; the hardware never receives a Supabase service role or a staff login.
2. Preserve the original event, receipt time, device time/offset and vendor identifier in a bounded private event/audit path. Normalize only documented fields. Reject unauthenticated sources and flag unknown pupils, ambiguous mappings or unreasonable clocks for review.
3. Deduplicate using the documented immutable device event/sequence contract, including offline/restart behavior. Replays, out-of-order arrival and temporary outages must not duplicate an official mark or alert. A fallback key requires a proved collision/restart policy.
4. Treat a punch as a gate observation, separate from the official classroom register. No punch remains an exception/unmarked case until the school-approved rule determines otherwise. A later-arriving event must not silently overwrite an already reviewed Teacher mark, leave decision, holiday or correction. Preserve documented direction/gate identifiers; never infer direction by alternating scans. Repeated IN, missing OUT, multi-gate conflicts and out-of-order events need review. An identifier scan alone does not prove the pupil's identity or current campus presence.
5. Apply approved outcomes through a narrow governed attendance capability and the existing canonical register/history. Require the established review/reason path when a historical correction is needed. Do not create a competing attendance ledger or a general-purpose Admin API on the device.
6. School-approved gate arrival/exit alerts may use accepted gate observations without changing classroom attendance. Classroom absence/late alerts continue to require their own authoritative attendance outcome. Reuse the existing native push queue; recheck current child links, roles, device generation and recipient preferences before dispatch. Define an approved freshness rule: offline/backlogged punches must be labelled with their actual event time and delayed status, or suppressed, never presented as "just arrived/left." Gate notification recipients, thresholds and trigger settings remain school decisions.

This is a proposed contract. Schema, adapter code, device management, event import and punch-to-register conversion are not built by this office phase.

## Notification activation sequence

The application already has family absence/result/leave inbox events, independent read state, opt-in devices/preferences and a protected bounded native push dispatcher. The next delivery work should use that backend, not add another messaging gateway or simulate success.

Confirm server-side Firebase access and protected scheduling without putting credentials in Git/client code. Register a real Android installation, obtain OS notification permission, explicitly opt in and exercise one controlled current event. Record separately: queued, provider accepted, displayed on the phone, opened, and marked read. Provider acceptance is not proof of display; opening or delivery must not silently mark unrelated inbox entries read.

Verify foreground/background, app update/restart, denied permission, revoked installation, shared-phone account switch, expired session, revoked child link, retries and offline reconnection on the actual supported device/OS. Keep paid SMS/WhatsApp/email fallback OFF until its provider, budget and school policy are separately approved. Additional late/homework/fee/exam/announcement triggers and staff notifications remain the explicit web backlog in [WEB-REMAINING](../implementation/WEB-REMAINING.md).

## Real-hardware acceptance before a school pilot

- [ ] Confirm model/firmware, protocol/SDK license, event identifier, clock/IN-OUT semantics and connector authentication from official documentation and a test unit.
- [ ] Map two synthetic pupils, an unknown ID, a replaced card/identity and an independently scoped second school. Unknown/ambiguous/foreign identities cannot create attendance.
- [ ] Reconnect after an offline backlog; replay and reorder the same events; restart the device/connector. Each intended outcome is applied once or held for review, with the original evidence retained.
- [ ] Exercise late events, duplicate IN/OUT, missing OUT, wrong timezone/clock, midnight, holidays, approved leave and an existing reviewed attendance correction.
- [ ] Confirm gate history/alerts do not automatically mark classroom presence or cancel absence alerts. Repeated IN, multi-gate conflicts, replaced/shared cards and withdrawn-pupil mappings remain reviewable. Unknown direction never toggles automatically, and an old offline event is labelled delayed or suppressed under the approved freshness rule.
- [ ] Compare device observations, approved register records, parent/student refresh and audit history for the same day. Another pupil/school and preserved historical fee/attendance data remain unchanged.
- [ ] Verify one opted-in linked Guardian on a real phone, then revoke that link/installation before another dispatch. No stale or wrong-child alert is delivered by the application's eligible-send path.
- [ ] Rehearse device/key replacement, connectivity loss and manual fallback; assign school/operator ownership and record actual founder/school acceptance.

These boxes remain unchecked. A synthetic API event, successful build or provider receipt cannot close real hardware/phone acceptance.
