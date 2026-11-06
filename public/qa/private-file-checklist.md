# SMS private attachment checklist

7 November 2026 · Founder cases pending

Use the stable [SMS website](https://kids-corner-erp-frontend.vercel.app/login). Runtime `0e3fc33e` is Production Ready with the updated private-download buttons. Use QA accounts and permitted demo attachments from the private handoff. Keep passwords, raw file URLs and private request details out of this document.

**Current status:** owner UI confirms the replacement key Active and the previous key Revoked. Post-rotation proxy/logout QA passes, but four previously warmed raw responses still replayed from the CDN; fresh origin requests were denied. This known cache limitation is not a passing global-revocation claim. Engineering has verified actual Student and assigned-Teacher Production browser downloads of the same original 608-byte PDF, preserved grade/feedback, and both UI logouts. The deployment and browser CORS path pass; all founder cases below remain pending. Negative permission cases are SDK/database evidence, not a completed browser sweep.

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
- [ ] **PF-08 · Legacy capability closure — release owner.** Review the recorded owner-verified key revocation and completed post-rotation check: the new proxy denies logged-out clients, but four warmed legacy raw responses still returned a CDN HIT. The captured signed test had already expired before revocation, so its denial does not prove the rotation’s effect. A passing new download is not proof that older capabilities have expired. Mark Blocked if the required acceptance criterion is immediate revocation of all previously cached raw links; that criterion is not established.
- [ ] **PF-09 · Scope and source parity.** Have engineering confirm source-ID checks for homework, academic activity attachments and standalone materials, plus exact original bytes. This does not imply new material-download or native original-download screens: those remain later UI work.

Files already downloaded or shared cannot be recalled after logout. Test access on a new request; do not treat a file already saved on the device as a failed revocation.

All cases stay unchecked until observed on the recorded release. Send `PF-ID · Pass/Fail/Blocked · role/device · steps · expected/actual`; include a screenshot only when it contains no private credentials or file capability.
