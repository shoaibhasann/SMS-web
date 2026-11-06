# Dashboard — founder QA

6 November 2026 · Full local-workspace checklist · Preview acceptance tracked separately

Open [local SMS](http://127.0.0.1:3120) while the dev server is running to test the full working tree. For the separately built dashboard-only release, use [Dashboard Founder Preview QA](DASHBOARD-FOUNDER-PREVIEW-QA.md): its verified URL/revision and founder results belong there. This local checklist is not proof that a deployment is ready or accepted. Use the private founder handoff for credentials; do not put passwords here. Visual direction: [SMS brand](../product/SMS-BRAND.md).

## What changed

Admin/Principal dashboards have five focused metrics: Total Students, Total Teachers, Today's Attendance, Absent Students and This Month Collection. Teacher, Student and Guardian retain four role-specific metrics, real attendance/learning charts and useful module links. The refined UI uses a soft blue greeting, lighter cards with restrained shadows, a compact shared quick-action tray and three-column lower Admin panels on desktop; those layouts collapse on narrow screens. Identity cards show verified details without linking to placeholder profile pages, and the recent-learning preview labels its Homework shortcut explicitly.

Sora is self-hosted through `next/font/local` from `app/fonts/Sora-Variable.ttf`, with its [OFL license](../../public/fonts/Sora-OFL.txt) included. Headings, sidebar, controls, values and chart labels use the same font; typography does not rely on an external font service. The sidebar/header follow the SMS brand, and system light/dark preference remains in use. Loading, empty and unavailable states stay explicit; a chart is not permission to read additional school data.

The scoped hosted QA school currently has **42 students, 3 classes, 7 sections, 4 subjects, 1,260 attendance records, 6 academic logs, 14 activities, 3 assessments and 4 notices**. The Admin baseline includes 11 retained teacher records. Today’s seeded attendance is 25 present, 8 absent, 3 late and 6 on leave. These are test records, not school adoption or commercial claims. Existing finance data was not expanded to decorate charts; the original monthly collection remains ₹850. Date-sensitive cards can change after the seed date.

## Local workspace versus dashboard-only Preview

The full local working tree also contains timetable, student-leave, reviewed result publication and related changes backed by **nine pending SQL migrations**. Those features and migrations are not included in the dashboard-only Preview. That release is built from archived source revision `74771f7` plus nine dashboard/font source and asset files, rather than deploying the full uncommitted working tree.

The dashboard-only checklist covers the refined Sora UI, five Admin KPIs and the existing hosted QA data. Its shortcuts use existing release alternatives; local timetable/publication links are not evidence those workflows shipped. Do not mark a pending-feature checklist Pass from a dashboard Preview or treat a successful dashboard read as schema-rollout acceptance. No deployment URL or Ready/accepted status is asserted by this file; use the separate release record after verification.

| Record | Founder entry |
|---|---|
| URL / build / test date | |
| School and account role | |
| Browser and viewport | |

## Founder checklist

- [ ] **D-01 · First screen.** At 1440 px light mode, open each of the four roles. Check the soft blue greeting, clear role title, lighter compact cards and restrained shadows. Admin has five metric cards; its lower panels use three columns and quick actions stay in one compact shared tray. No clipped name, overlapping action, large decorative hero or unnecessary empty card height.
- [ ] **D-02 · Admin / Principal.** Confirm all five KPIs: the seeded Admin baseline is 42 students, 11 retained teacher records, 42 saved attendance records today, 8 absent and ₹850 net collection this month. Reconcile against the same date, school, Attendance and Finance records. “Other saved statuses” must not be labelled “Present.” In the full local workspace, open Students, Attendance, Timetable and Review results; a pending backend update must produce an honest message rather than fake success. For Preview shortcuts and acceptance, follow FP-02 in the dashboard-only checklist instead of expecting unpublished workflows.
- [ ] **D-03 · Teacher.** Confirm assigned classes, academic logs, homework and upcoming assessment counts. Check that the recent-log chart represents the displayed recent sample. Open attendance, make an unsaved edit and try Refresh: the draft must remain protected. Verify the primary action and class-work links reach their actual modules.
- [ ] **D-04 · Student.** Confirm own admission/class/section details, attendance, homework/lesson preview and fee balances. Open full attendance, fees, timetable and published results. Reload: the same authorized student remains selected, and other pupils’ details never appear.
- [ ] **D-05 · Guardian.** Confirm the linked child and its details, attendance, learning, fees and notification shortcut. Select the currently selected child again, then reload: the page must settle, with no permanent “Checking selected child” state. If a second child is linked for acceptance, switch both ways and reload; no prior child’s delayed data may replace the current child. The current hosted fixture has one child, so sibling isolation needs an additional approved fixture before founder acceptance.
- [ ] **D-06 · Actual data and failures.** Compare chart counts with their visible legends. Empty data must show an empty explanation; a denied/failed read must show an error or unavailable state, not zero attendance, zero fees or invented growth. After session expiry/sign-out, protected data must not remain usable.
- [ ] **D-07 · Phone and theme.** Repeat each role at 390 px in system dark mode and light mode. Check no horizontal page overflow, readable card/metric labels, usable child/school selectors and at least 44 px primary actions. Admin metrics and lower panels must collapse without crowding; the final collection metric stays readable. Increase text size, use long names and verify charts have readable labels/counts beyond color alone.
- [ ] **D-08 · Keyboard and refresh.** Tab through sidebar, selectors and actions; focus must stay visible. Check the mobile menu, dismiss it and use browser Back. Reload every role and verify actual data returns without changing school/child scope. Test reduced-motion preference and a narrow tablet layout.
- [ ] **D-09 · Sora typography.** Check headings, sidebar, button/input/select text, ₹ amounts and chart labels use the same Sora family at laptop and phone widths. Reload with an empty browser cache: the application must serve its own font asset rather than depending on a third-party font request. Check the included font-license asset is available in the release. A persistent fallback font after loading or a failed font request needs its own bug report.

## Evidence and remaining acceptance

Local tests cover dashboard presentation plus existing loading, access-scope, child-response and canonical finance behavior. The earlier four-role browser recheck passed against **real hosted Supabase test data read-only**: 1440 px light, 390 px system dark, reload, search, keyboard focus and no page overflow. All **174 school reads succeeded**, with zero school writes, request mocks, runtime errors or failed reads. Four test Auth sessions signed out locally only. Re-dispatching the Guardian's currently selected child preserves its loaded data, and the featured-card label contrast correction passed. That 174-read run is retained evidence for the earlier local dashboard revision; it must not be presented as acceptance of the later Sora/five-KPI refinement or its Preview. See [PHASES.md](PHASES.md) for subsequent local validation and [Dashboard Founder Preview QA](DASHBOARD-FOUNDER-PREVIEW-QA.md) for the actual release smoke/founder record.

Sibling switching and revocation races have unit/controlled coverage; the one-child hosted fixture does not establish a live multi-child result. Hosted reads verify these dashboard queries, not unapplied SQL-backed modules reached from a shortcut. Founder/device acceptance remains independent. The separately packaged dashboard release excludes the nine pending SQL-backed phases; only its own recorded smoke and founder checks can establish its acceptance. This file does not certify a Vercel deployment.

| Case | Pass / Fail / Blocked | Role/device, expected / actual, evidence |
|---|---|---|
| | | |

Final Sora dashboard-only Preview engineering QA passes: [release record and founder cases](DASHBOARD-FOUNDER-PREVIEW-QA.md). This newer run verifies52 focused release tests plus actual four-role deployed UI login/reload/scope,215 real school reads/zero writes,localSora/font consistency/contrast and desktop/mobile rendering. It does not certify the unreleased SQL-backed shortcuts in the full local workspace.
