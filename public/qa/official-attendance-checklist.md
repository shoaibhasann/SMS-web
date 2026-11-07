# SMS — official attendance percentage

7 November 2026 · Founder acceptance pending

Use the released [SMS Production](https://kids-corner-erp-frontend.vercel.app/login). Sign in with the privately supplied Student or Guardian QA account and open Dashboard. Use isolated school fixtures for boundary tests; do not modify original founder records.

Approved formula: `(Present + Late + 0.5 × Half Day) / enrolled working days × 100`. Leave and Absent earn zero. School holidays and weekly closed days are excluded. Missing marks are not Absent and block a complete percentage.

- [ ] **AR-01 — Dashboard:** Student sees their own Official attendance panel; Guardian sees only the selected linked child. Monthly and session-to-date labels identify the school year and period.
- [ ] **AR-02 — Weights:** Reconcile Present/Late as one, Half Day as half and Leave/Absent as zero. Check a fractional result rounded to two decimal places.
- [ ] **AR-03 — Calendar:** Closed weekdays and school holiday exceptions do not increase the denominator. An extra working-day exception does. Retained closed-day marks are not rewritten.
- [ ] **AR-04 — Missing marks:** An enrolled working day with no canonical mark shows an incomplete/pending explanation, not a fabricated Absent, zero or official percentage.
- [ ] **AR-05 — Missing calendar:** A period containing enrolled dates without a configured calendar shows its setup gap. The app does not apply today's policy backwards.
- [ ] **AR-06 — Joining date:** Dates before a verified admission/promotion are excluded. An unknown admission date is explained; import time is not treated as historical joining proof. A withdrawn pupil with a still-active placement and no verified end date must not receive an official rate.
- [ ] **AR-07 — Placement:** A section move preserves earlier marks, counts the pupil once per day and does not count records belonging to another dated placement.
- [ ] **AR-08 — Withdrawal/promotion:** Governed withdrawal stops the reporting span after its effective day; staged/cancelled placements do not create attendance days in the current year.
- [ ] **AR-09 — Date limits:** Future days and dates outside the school year are excluded. Missing, ambiguous or unsupported school-year configuration is explained.
- [ ] **AR-10 — Empty and zero:** No working days is not 0%. A complete all-Absent/Leave period can be 0%; a complete all-Present/Late period can be 100%. No NaN/Infinity appears.
- [ ] **AR-11 — Month change:** Choose another available month and use the panel Refresh. The selected period, counts and percentage stay consistent; session totals retain their separate date range. A full page reload starts at the server current month (clamped to the current school year).
- [ ] **AR-12 — Child/account switch:** Switch siblings quickly and change accounts during a load. No previous child's or account's summary flashes or replaces the current result.
- [ ] **AR-13 — Permissions:** Foreign pupil, revoked link, Teacher/Office-only identity, signed-out/retired session and forged user metadata cannot read a family summary through direct API calls.
- [ ] **AR-14 — Approved correction:** A pending correction does not change the canonical rate. After independent approval, refresh Student and Guardian views and reconcile the new rate without duplicate days.
- [ ] **AR-15 — UI:** Check phone/desktop, Light/Dark, keyboard controls, skeletons, unavailable states and explicit reload after an error. Counts and formula remain readable.
- [ ] **AR-16 — Preservation:** Original attendance, child links, fees and notification read state remain unchanged by reading/reporting. Existing attendance history remains available separately.

All founder cases stay unchecked until founder testing. Product calculation approval does not replace actual school/board policy acceptance. Physical hardware, real carrier/push delivery and native mobile percentage UI are separate work.
