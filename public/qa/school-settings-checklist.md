# SMS school settings and setup checklist

7 November 2026 · Founder acceptance pending

Use the stable [SMS website](https://kids-corner-erp-frontend.vercel.app/login) and the isolated onboarding school accounts in the private QA handoff. Keep passwords and invitation tokens out of screenshots and this document. Record the deployed revision and actual result before checking a case.

Engineering has verified hosted role/session, save/retry/conflict and isolated-school setup-to-attendance SDK paths. Runtime `527c9ae` is Production Ready: actual Admin save/page reload preserves the QA value at revision 4, Principal reads the same value with no edit controls, and both Production browser sessions log out. Teacher denial was observed locally and in SDK/database coverage. These checks do not tick the founder cases below or certify complete school onboarding.

| Run | Record |
| --- | --- |
| Revision and date | `527c9ae` · 7 November 2026 |
| Tester / browser / device | |
| School and permitted QA role | |
| Result: Pass / Fail / Blocked | |

- [ ] **SS-01 · Real school details.** As School Admin, open Settings. Confirm the selected school's saved name, board, address and office contact details appear. School code and timezone are read-only. Account password/contact settings remain under the top-right account menu.
- [ ] **SS-02 · Save and refresh.** Edit an allowed demo field, provide a meaningful reason and save. Refresh the page and sign in again; the same value and revision must appear. Existing pupils, marks, attendance, fees and guardian relationships must remain unchanged.
- [ ] **SS-03 · Concurrent edits.** Open the same school in two Admin sessions. Save one change, then attempt to save the stale second form. Expect a conflict; the older form must not replace the newer saved data. Preserve the draft while loading the latest saved settings, and require an explicit choice before trying that draft again.
- [ ] **SS-04 · Unknown result and retry.** Interrupt a save response after submission. Do not accept a success message without a confirmed receipt. Use Retry same save to confirm the exact operation; after confirmation, reload the saved state. One change should produce one revision and one history event. Editing another field must not silently reuse an uncertain request.
- [ ] **SS-05 · Validation.** Check blank/overlong names, invalid PIN, email, office phone and website. A valid multiline postal address should save and reload. Website input accepts HTTPS only and rejects embedded credentials. Optional empty contacts can remain empty. No phone/email message is sent by saving office contact details.
- [ ] **SS-06 · Principal access.** Sign in as Principal. Confirm school details and setup progress are readable, with no edit controls. Direct save requests must also be denied.
- [ ] **SS-07 · Role and school isolation — engineering-assisted.** Teacher, Guardian, Student, Finance and Reception must not access school settings or save through its RPC. Another school's Admin must not read or change this school's details, counts or history. Direct mutation of the underlying school/configuration tables must fail for school clients.
- [ ] **SS-08 · Real setup progress.** On a newly provisioned QA school, follow the links for academic session/catalog, staff, assignments, roster and guardian invitations. Refresh progress after each step. A staff directory row must not count as a verified Teacher login; a pending guardian invitation must not count as an accepted child link. Missing sections/placements/links must remain visible.
- [ ] **SS-09 · Daily operation.** Finish the sample class, claim the Teacher invitation, assign the class/subject, admit a pupil, accept the Guardian invitation, save attendance as the assigned Teacher and reload it as the linked Guardian. Counts must come from those saved records rather than editable completion flags.
- [ ] **SS-10 · History.** A real change adds the actor, time, revision and changed field names. Repeating an identical save or retrying its request must not create another change event. Raw snapshots, private reasons, invitation tokens and contact values must not leak through the history projection.
- [ ] **SS-11 · Stale account or school.** Start loading/saving, then sign out or attempt to switch school. School switching stays disabled while an edit or uncertain save is active; cancel a known edit before switching. Late results must not appear in a different account or school's editor. Duplicate saves are disabled while pending. An already committed save is not undone by closing the page.
- [ ] **SS-12 · Premium and accessible UI.** Check narrow phone and desktop widths, Light/Dark, keyboard focus, field labels, error association, long names, skeleton loading and retry. Setup cards should have consistent spacing and readable empty states.

This is school-profile editing and guided setup of an operator-provisioned school. Platform self-provisioning, subscriptions, staff MFA, school attendance/grading policy and provider activation remain separate work. Progress counts are not school/founder acceptance or a commercial-readiness certificate.

Send `SS-ID · Pass/Fail/Blocked · role/device · steps · expected/actual`, with a redacted screenshot when useful. All cases remain unchecked until the founder observes them.
