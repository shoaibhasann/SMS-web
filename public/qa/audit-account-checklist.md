# School audit history and account menu — founder QA

6 November 2026 · `main` → [SMS Production](https://kids-corner-erp-frontend.vercel.app/login) · Founder acceptance pending

Use the existing private Admin, Principal, Teacher, Student and Guardian QA logins. Test only synthetic records. Keep passwords, recovery links and tokens out of screenshots and reports. Complete these checks on the deployed revision; engineering evidence does not tick founder boxes.

## Account menu and settings

- [ ] **ACC-01 · One account entry.** At 1440 px and 390 px, the top-right avatar is visible. The sidebar and mobile navigation drawer have no profile footer, Logout or theme selector. Hover the avatar with a mouse, move into its panel, then move away: no flicker or inaccessible actions. Click/tap to keep it open; click outside to close it.
- [ ] **ACC-02 · Keyboard.** Tab to **Account options**, use Arrow Down, and reach **Account settings**, **Appearance** and **Logout**. Escape closes the panel and returns focus to the avatar. Tab out closes it. At a short viewport, every action remains reachable.
- [ ] **ACC-03 · Appearance.** Open Appearance, choose Light, Dark and System. Reload after each choice. System follows the device; the saved preference works across dashboards and modules. The login screen continues to follow the device theme.
- [ ] **ACC-04 · Own account.** Open Account settings from each supplied role. Own name, role, email and sign-in method are correct after reload. No role/other-user editor is present. Guardians use the existing verified-contact settings link; opening it preserves their child links.
- [ ] **ACC-05 · Password safety.** Use a separate disposable QA login, never a founder's shared login. Wrong current password, short new password, reused current password and mismatched confirmation must fail. A valid new passphrase needs at least 12 characters. After a confirmed change, fields clear and the success message remains honest. Automatic shared-browser logout must not clear a newer account signed in from another tab; use the avatar Logout action when ready. Old-password sign-in fails; the new password works. An uncertain response must ask for sign-in verification rather than claiming failure or repeating a write blindly. Skip/mark Blocked if a disposable credential was not supplied.
- [ ] **ACC-06 · Local logout.** Log out from the avatar. Login opens; a protected URL requires sign-in and old-user details disappear. Another separately signed-in QA browser must retain its session.

## Read-only school audit history

- [ ] **AUD-01 · Real recorded actions.** As Admin/Principal, open Audit Logs. The page says Read-only history; no Add, Edit, Delete or Export controls appear. Recorded leave requests/decisions, timetable saves and result-publication requests survive Refresh history and a hard reload.
- [ ] **AUD-02 · Filters and time.** Filter by Student leave and Results, and apply an IST From/To range. Only matching saved events appear, newest first. Editing filters alone does not change the displayed scope; Apply filters starts a fresh page. An empty valid range shows an empty state; reversed/over-366-day ranges show validation.
- [ ] **AUD-03 · Paging and failures.** On a prepared fixture with more than 50 matching events, Next/Previous have no duplicate or missing references. Refresh starts page 1. If that fixture is absent, mark the browser paging case Blocked rather than inventing records. Slow/offline reads show skeleton/error states, never fake records or success. Changing school/account must never display the old scope's late response.
- [ ] **AUD-04 · Privacy and access.** Events show time, action, module, safe record reference and an available same-school actor name. No raw record JSON, private leave/review reason, marks array, invite token, email/mobile change value, IP address or user agent appears. Student, Guardian, Teacher, Finance and another school's office account must be denied this school's history through direct page/API access.
- [ ] **AUD-05 · Honest coverage.** The coverage note lists guardian access/contact, attendance corrections/cutoff, roster placement/withdrawal/session activation, student leave, result publication and timetable changes. It does not claim universal capture, historical backfill, fee/payroll history or role-grant auditing. Reading/filtering history must not create, change or delete source records.

## Populated dashboards

- [ ] **UI-01 · Aligned cards.** On desktop light/dark, all Admin/Principal, Teacher, Student and Guardian summary rows have aligned card edges and consistent 16 px gaps. Grid preview heights stay within 300–340 px; long preview bodies scroll with keyboard focus while headers and View all remain visible. Forms and attendance editors are uncapped. Learning activity and Today's attendance have aligned bottom edges with no stranded blank strip below attendance. At 390 px, cards stack cleanly with no horizontal overflow. The avatar panel fits the screen and keyboard focus remains visible.
- [ ] **UI-02 · Real statuses.** Today's attendance lists Present, Absent, Late, Half Day, Leave and Holiday separately. A saved zero is valid; an unavailable count must show an error/unavailable state. Refresh agrees with the attendance register. Sample learning bars remain labelled as a recent record sample, without invented growth or full-school trend claims.
- [ ] **DATA-01 · Varied retained demo.** Check the saved weekly timetable, one Pending and one Rejected leave request, one Pending result-publication request and the existing own published result. The existing 30-day attendance fixture covers all six statuses; homework/classwork, notices, upcoming assessment, pending/partial fees and receipt history remain available. Protected original attendance and financial records must retain their values; do not alter them only to fill a chart.

| Case / role / browser-device | Expected → actual | Screenshot / page / IST time | Pass / Fail / Blocked |
|---|---|---|---|
| | | | |
