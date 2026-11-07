# School Late attendance alerts — founder checklist

**Founder acceptance pending.** Every box below stays unchecked until you test it.

[Open SMS Production](https://kids-corner-erp-frontend.vercel.app/login). Use privately supplied disposable School Admin, Principal and Guardian QA accounts. Record the release, date, child, expected result and actual result. Keep credentials and authenticator codes out of this file.

Open **School settings → Late attendance alerts**. This is one school policy for Guardian **in-app** alerts. The checkbox is **“Send Guardian in-app Late attendance alerts”**; the reason field is **“Late policy change reason”**.

## School policy

- [ ] **LATE-01 — Authority and MFA:** An actual School Admin and an actual Principal can manage their own school's policy after authenticator verification. A Principal's read-only school-profile fields must not prevent this separate policy change.
- [ ] **LATE-02 — Default and explicit choice:** A fresh, unconfigured school shows **Saved policy: Off**, Version 0 and no saved history. Nothing enables itself. Do not reset an existing school's policy just to reproduce the fresh-school case.
- [ ] **LATE-03 — Save and reload:** Select the checkbox, enter a 5–300 character reason and choose **Save Late alert policy**. Reload: the saved choice, new version, reason, actor and IST timestamp persist. Blank/short reasons and unchanged choices cannot save. History clearly shows at most the latest 20 versions.
- [ ] **LATE-04 — Conflicts and uncertain saves:** Try two authorized sessions. A stale save requires reloading; it must not overwrite a newer decision automatically. An unknown save keeps its exact request under **Retry same Late policy save**. Retrying must not append a duplicate version. Check the current policy after confirmation.

## New events and Guardian inbox

- [ ] **LATE-05 — New Late mark:** After enabling, save a new **Late** attendance mark dated **today in IST** for a disposable linked child. Each currently eligible Guardian sees one **Late attendance** update for the correct child. Open it: the correct child's attendance page loads. Opening alone does not mark the alert read.
- [ ] **LATE-06 — No backfill or fabricated events:** Existing Late marks, marks saved while the policy was Off, historical dates and future dates do not gain alerts merely because the policy is enabled. Re-saving an unchanged Late mark produces no new alert. A missing gate scan does not create Late or Absent attendance.
- [ ] **LATE-07 — Disable and independence:** Turn the school policy Off with a reason and reload. New Late marks stop generating alerts; retained eligible Late alerts remain. Guardian Arrival/Exit choices and independently generated absence alerts continue unchanged, including when Arrival and Exit are both Off.
- [ ] **LATE-08 — Read, filter and refresh:** Mark one Late alert read. **All**, **Unread**, the unread total and the header bell agree after refresh and a new login. Use the server's full unread total, not the number of visible rows. Another Guardian of the same child retains their own read state.
- [ ] **LATE-09 — Mark all:** With a disposable inbox, use **Mark all as read**, including unread items beyond its first page. Refresh and check the current server count. Another Guardian's alerts remain unchanged. A failed save must not display an invented zero/read state.
- [ ] **LATE-10 — Correction:** Correct the disposable child's Late mark to Present through the permitted attendance workflow. After refresh, the Late alert disappears from eligible inbox/count results. The attendance correction remains visible in its normal register/history workflow.
- [ ] **LATE-11 — Revoke and re-invite:** Revoke only a disposable Guardian/child link. That Guardian loses the child's old alerts and receives no new ones; other linked children and other Guardians remain available. Re-invite/re-link the child: revoked-link Late alerts must not resurrect or be backfilled.

## Access and delivery boundaries

- [ ] **LATE-12 — Role and school isolation:** Student, Teacher, Finance, foreign-school, unverified MFA and logged-out sessions cannot read or change this school policy through direct APIs. Student and Teacher contexts cannot retrieve Guardian Late alerts or mark those alerts read. Normal authorized classroom attendance access remains separate.
- [ ] **LATE-13 — Account changes and errors:** Switch account/school or sign out during a pending read/save. Previous-account policy, child names and Late alerts clear; a delayed response cannot populate the next account. Refocus/reload and verify current saved authority before another change.
- [ ] **LATE-14 — Existing app compatibility:** The currently installed older mobile app continues loading its existing V2 notifications. Late alerts are a web V3 inbox feature in this phase; absence/results/leave and optional gate updates must keep working in older clients.
- [ ] **LATE-15 — UI and scope:** Check keyboard use, narrow phone width, Light/Dark, skeletons, long reasons and clear errors. Attendance/fee history and unrelated links remain intact. This policy must not enable phone push, SMS or email. No native V3 adoption or physical-device delivery is accepted by this checklist. Log out QA accounts.

Developer evidence is separate from founder acceptance: [docs/implementation/LATE-ATTENDANCE-ALERTS-QA.md](https://github.com/shoaibhasann/school-management-system/blob/main/docs/implementation/LATE-ATTENDANCE-ALERTS-QA.md).

Developer verification on 7 November: runtime `f023324` is main/Production Ready. Whole web 3,522 tests, native 124+6 checks, local three-role flow and deployed Admin/Principal/Guardian refresh checks pass. This does not tick founder acceptance or phone/hardware delivery boxes.
