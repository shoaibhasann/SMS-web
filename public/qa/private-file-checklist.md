# SMS private attachment checklist

7 November 2026 · Founder cases pending

Use the stable [SMS website](https://kids-corner-erp-frontend.vercel.app/login). Runtime `0e3fc33e` is Production Ready with the updated private-download buttons. Use QA accounts and permitted demo attachments from the private handoff. Keep passwords, raw file URLs and private request details out of this document.

**Current status:** owner UI confirms the replacement key Active and the previous key Revoked. The four held raw contexts that initially replayed cached bytes all deny 400/DYNAMIC in the 01:08:07 IST follow-up after 01:06:14 IST old-JWT expiry; fresh-nonce requests also deny. This closes those four measured raw windows only. Unknown historical signed-cache responses remain unverified; no global purge is claimed. Engineering has verified actual Student and assigned-Teacher Production downloads of the same original 608-byte PDF, retained grade/feedback and both UI logouts. All founder cases below remain pending; negative permission coverage is SDK/database evidence rather than a completed browser sweep.

| Run | Record |
| --- | --- |
| Deployed revision and date | `0e3fc33e` · 7 November 2026 |
| Tester and device/browser | |
| Student and Teacher QA roles confirmed | |
| Result: Pass / Fail / Blocked | |

- [ ] **PF-01 · Student’s saved attachment.** Sign in as the QA Student, open Homework → My submission and download its saved PDF/photo. Expect the original readable file and a sensible filename. Refresh and repeat. The button uses the saved submission; it should not open a Storage website or an expiring link page.
- [ ] **PF-02 · Assigned Teacher.** Sign out, then use the permitted Teacher account and open that homework’s submissions. Download the Student’s attachment and compare it with the approved original. Other student work should stay within the teacher’s permitted class/subject.
- [ ] **PF-03 · Loading and retry.** Slow the connection and start a download. Check the downloading label, disabled duplicate action and readable recovery after going offline. Restore the connection and retry; no fake success or wrong file should appear.
- [ ] **PF-04 · Account change during download.** With a slow download pending, sign out/change account. The previous account’s late response must not start a download in the new workspace. Closing the submission panel should cancel its pending action as well.
- [ ] **PF-05 · UI and accessibility.** On a narrow phone and desktop, in Light and Dark, verify long filenames wrap, keyboard focus is visible, and the download button/error remains reachable. Check each action’s accessible name.
- [ ] **PF-06 · Existing submission remains safe.** Reload the Student and Teacher views after downloading. Text, original attachment, grade, feedback and revision should remain unchanged. A download must not edit attendance, fees, guardian links or notification read status.
- [ ] **PF-07 · Permission negatives — engineering-assisted.** Have engineering verify the held QA source references after logout, for another child/school, and for a Teacher without the required assignment. The service should deny new unauthorized requests without exposing private filenames or paths. Live assignment-revocation mutation is not part of the recorded hosted run.
- [ ] **PF-08 · Legacy capability closure — release owner.** Review the owner-verified key revocation and the chronological cache checks. The proxy denies logged-out clients. Four held raw contexts initially returned CDN HITs, then all denied 400/DYNAMIC at 01:08:07 IST after the old JWT expired at 01:06:14 IST. This closes those four observed raw windows. The signed test expired before revocation, so its denial cannot prove rotation’s effect. Unknown historical signed-cache responses remain unverified; mark Blocked if acceptance requires their broader closure or immediate global recall.
- [ ] **PF-09 · Scope and source parity.** Have engineering confirm source-ID checks for homework, academic activity attachments and standalone materials, plus exact original bytes. This does not imply new material-download or native original-download screens: those remain later UI work.

Files already downloaded or shared cannot be recalled after logout. Test access on a new request; do not treat a file already saved on the device as a failed revocation.

All cases stay unchecked until observed on the recorded release. Send `PF-ID · Pass/Fail/Blocked · role/device · steps · expected/actual`; include a screenshot only when it contains no private credentials or file capability.
