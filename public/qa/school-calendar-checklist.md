# SMS — school calendar and attendance rules

7 November 2026 · Founder acceptance pending

Use [SMS Production](https://kids-corner-erp-frontend.vercel.app/login) only after the matching calendar release is confirmed. Use fresh isolated school accounts supplied privately. Changing an existing school's rules affects real operations; never use original founder data for destructive or boundary tests.

- [ ] **SC-01 — Unconfigured:** An untouched school is labelled unconfigured; no weekdays, holidays or correction window have silently been selected for it.
- [ ] **SC-02 — Office authority:** Admin and Principal can manage their own calendar after native MFA. Teacher, Student, Guardian, another school and signed-out sessions cannot configure it.
- [ ] **SC-03 — Save/reload:** Explicitly select weekdays, effective date and correction window, provide a reason and save. Hard refresh shows the same confirmed settings/revision.
- [ ] **SC-04 — Concurrent save:** Save from two sessions at the same revision. The stale action cannot overwrite the winner; refresh or exact retry reconciles the saved result.
- [ ] **SC-05 — Effective date/history:** Backdated configuration is rejected. Future configuration does not change earlier rules or existing attendance/fee/link/read history.
- [ ] **SC-06 — Holiday:** Save a future closed-day exception. The calendar identifies its date and label. On that date, ordinary register marks cannot be saved and no fake pupil Holiday/Absent rows are generated.
- [ ] **SC-07 — Extra working day:** A working exception overrides a normally closed weekday. Eligible daily attendance can be recorded; other dates keep their weekly rules.
- [ ] **SC-08 — Restore weekly rule:** Add an inherit exception revision. The date returns to its effective weekday rule; prior revisions remain auditable.
- [ ] **SC-09 — Day already started:** Once the isolated school's date has a saved mark or any gate evidence, changing that date's calendar is rejected. Existing records are preserved.
- [ ] **SC-10 — Gate integration:** A fresh synthetic IN on a closed day is retained as held and makes no official mark or arrival alert. A qualifying working-day IN still marks Present/Late; OUT preserves presence.
- [ ] **SC-11 — Submission monitor:** A configured closed day does not show a missing register as pending. A configured working day follows the existing submission cutoff.
- [ ] **SC-12 — Correction window:** Test the Teacher boundary inside/outside the configured calendar-day window and zero-day window. Existing pending requests/exact retries and independent school review follow their documented rules.
- [ ] **SC-13 — Legacy API bypass:** Direct raw writes to the old holidays table cannot manufacture a closure. Direct attendance calls cannot bypass the new day rules.
- [ ] **SC-14 — Account change/error:** Switch accounts during a load/save, revoke access and simulate uncertain saves. Another identity's school/settings cannot replace the current view; uncertain changes require reconciliation.
- [ ] **SC-15 — Family summary:** The family dashboard labels Present/Late saved-record counts and sample limits. It does not imply a complete official percentage or count missing scans as Absent.
- [ ] **SC-16 — Usability:** Check narrow phone/desktop, Light/Dark, keyboard focus, long labels, validation, loading/error and unsaved-change behavior.

All cases remain unchecked until founder testing. Date-bound future/day-rollover, real hardware and physical-device delivery need their own scheduled/manual acceptance. Follow engineering evidence for the precise synthetic-clock versus live-day test boundary.
