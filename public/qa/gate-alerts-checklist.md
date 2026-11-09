# SMS — optional arrival and exit alerts

7 November 2026 · Founder acceptance pending

[Open SMS](https://sms-web-shoaibhasann.vercel.app/login). Use the privately supplied isolated Guardian QA account. Open Notifications → Gate alerts. Keep credentials and device secrets out of this file. Record release/date/child, expected and actual result, and a screenshot without private information.

These are school-inbox choices. Both gate options start OFF for each Guardian/child. Absent alerts remain independent: saving an Absent register mark still alerts eligible linked Guardians. A missing scan does not itself create an Absent mark. Phone push and paid SMS are not enabled by these switches.

## Preferences and ordinary use

- [ ] **GNA-01 — Default OFF:** A new verified link starts with Arrival and Exit OFF. Existing absence/result/leave notifications still load.
- [ ] **GNA-02 — Save/reload:** Enable Arrival for one child, save and hard reload. That child's saved choice persists; siblings' choices stay independent.
- [ ] **GNA-03 — Separate choices:** Test Arrival only, Exit only and both. A confirmed change affects only this Guardian and child.
- [ ] **GNA-04 — Separate Guardians:** Another Guardian of the same child can leave both OFF. One Guardian's settings and read status do not change the other's.
- [ ] **GNA-05 — Arrival:** After opt-in, the operator sends a fresh eligible QA IN. Notifications shows one arrival for the correct child with actual IST event time. Open its attendance link and refresh.
- [ ] **GNA-06 — Exit:** After a qualifying IN, the operator sends OUT. One exit appears; the canonical daily attendance remains Present/Late. OUT without prior valid IN creates no exit alert.
- [ ] **GNA-07 — Retries/re-entry:** Replay exact events, concurrent duplicates and new IDs for repeated IN/OUT. Each Guardian gets at most one arrival and one exit alert per child/day.
- [ ] **GNA-08 — Absence while OFF:** Leave both gate options OFF for a fresh linked child and have the operator save Absent in the real register. Its absence alert still appears once; gate choices remain OFF.
- [ ] **GNA-09 — OFF/ON history:** Turning an option OFF hides that kind's retained gate alerts/count. ON may reveal the same retained alerts/read status. Scans already processed while OFF are not backfilled by enabling later.

## History, read state and security

- [ ] **GNA-10 — Read/filter/count:** Mark a new alert read; All/Unread and the bell count agree after hard refresh. Opening an attendance link alone does not mark the alert read.
- [ ] **GNA-11 — Mark all:** Use the disposable account with no old unread records. Mark all five-kind updates read; another Guardian's unread count remains unchanged, including beyond the first page.
- [ ] **GNA-12 — Revoke:** Revoke only the fresh test link, then send another eligible event. That Guardian cannot see old gate alerts or receive new child alerts. Other linked siblings remain available.
- [ ] **GNA-13 — Re-invite:** Re-link the test child through the existing verified flow. Choices start OFF with a fresh consent epoch; an old open form cannot restore opt-in or old gate alerts.
- [ ] **GNA-14 — Delayed/invalid events:** Buffered same-day events show actual time and Delayed when appropriate. Historical, future, held/manual-conflict and unsupported scans create no misleading arrival/exit alert.
- [ ] **GNA-15 — Conflicting saves/account switch:** Save from two sessions or switch accounts during a pending save. Unknown/conflicting outcomes require checking saved settings; another account's choices or children never replace the current view.
- [ ] **GNA-16 — Existing history:** Original attendance, fee/payment history, child links and old notification read timestamps remain intact outside the explicitly created QA records.
- [ ] **GNA-17 — Legacy app:** The older three-kind app still loads absence/result/leave updates. New gate items require the updated five-kind app; a new inbox kind must not break an installed older client.
- [ ] **GNA-18 — Native and hardware acceptance:** On a separately distributed updated native build, test the same choices and inbox. Physical terminal behavior and real phone-push display require their own acceptance; a browser or synthetic event cannot close those checks.

All cases remain unchecked until founder testing. Use fresh QA relationships for revoke/re-invite and Mark all; do not remove original links or mark old founder notifications read. Separate Late-only alerts, broader notification triggers and device purchase/activation remain separate scope.
