# Parents and admissions — founder checklist

Use [SMS Production](https://sms-web-shoaibhasann.vercel.app/login) after the release owner confirms this office revision is Ready. Record the revision/date, role, school, device, expected/actual result and a redacted issue reference. These boxes are founder acceptance and remain separate from engineering tests.

Use privately supplied dedicated QA accounts: School Admin, Principal, a second Admin session, Teacher, Guardian/Student, Finance/Reception and another school's administrator. Use synthetic admission numbers and pupils. Keep passwords, tokens, QR/setup secrets, live codes, mobile numbers and private pupil records out of screenshots/public issues. Do not modify a shared founder/demo account or real-school data to exercise a negative case.

## Parents and guardians

- [ ] OW-01 — As School Admin, open People → Parents. Verify the actual selected school, guardian names/codes, registered-mobile labels and expected linked children/admission numbers. Old browser-local demo records must not appear.
- [ ] OW-02 — Search by a linked child's name and admission number, then by a controlled QA guardian code/mobile. Clearing search restores the source. A missing term shows a clear empty result, not a fake zero for the entire school.
- [ ] OW-03 — With a fixture of more than 24 guardians, use Next/Previous and search for a record beyond the first page. The rendered page stays bounded while the search covers the complete loaded directory. Refresh retains the saved source, not unsaved browser records.
- [ ] OW-04 — Check active, inactive and unlinked school-profile fixtures. The badge must describe the school profile only. A school registered-mobile field must not be presented as proof of native phone, email or MFA verification. Retained withdrawn-child links remain identifiable without restoring a revoked link.
- [ ] OW-05 — Admin's Manage guardian access link opens the existing Guardian invitations workflow. The directory itself has no inline account creation, contact edit, revoke or re-invite action. Check those existing verified workflows using their own checklist.
- [ ] OW-06 — Sign in as Principal. The same authorized school directory is readable; no Admin-only Manage guardian access action appears. Another school's Parent records remain absent.

## Real admissions

- [ ] OW-07 — As Admin, open People → Admissions. Select the authorized current year/class/section. Enter a fresh synthetic admission number, first name and optional last name, then Admit student. The saved class register shows one pupil; hard refresh still shows that pupil in the same section.
- [ ] OW-08 — Repeat with a Principal and a different synthetic admission number/section. Admissions must reuse the actual roster; fake enquiry stages, available seats and application Approve/Reject controls are absent. Students still provides the existing placement/withdrawal/history workflow.
- [ ] OW-09 — Try the same admission number again in that school. Expect a duplicate failure and no extra pupil/enrollment. A separate authorized school may use its own same admission number without exposing the first school's pupil.
- [ ] OW-10 — In two authorized QA sessions, submit the same school/admission number concurrently. Exactly one official student/enrollment should remain. During a normal save, repeated clicking must not start another submission.
- [ ] OW-11 — Use a controlled QA network-interruption case. An unknown single-save result keeps its original draft and disables another admission/CSV action until Reload roster succeeds. Reconcile whether the pupil already exists before starting another admission; do not invent a new admission number to bypass uncertainty.
- [ ] OW-12 — Open student CSV import. Verify the template, preview, class/section and owner before importing valid synthetic rows. Reload the register and reconcile every imported pupil. Invalid/duplicate input must not be reported as a successful batch.
- [ ] OW-13 — For an uncertain CSV result, Retry same import retains the same reviewed rows/request identity; the school/context stays locked. A confirmed duplicate can be corrected. Changing accounts or navigating away during a file read/save must discard obsolete UI results rather than importing into the next owner/context.

## Access, history and UX

- [ ] OW-14 — Try direct Parents and Admissions URLs as Teacher, Student, Guardian, Finance and Reception. These office screens must deny unsupported roles. Existing family-own reads and intentional office raw-read capabilities are separate; do not infer a new role grant from a menu or mock test.
- [ ] OW-15 — Ask the engineer to run the current API boundary checks: raw client INSERT into students/enrollments is denied even for Admin, while governed Admin/Principal admit/import/placement and legitimate assigned-class Teacher registration still work. No Finance orphan should be created through the released boundary. Do not paste service credentials into the browser to test this.
- [ ] OW-16 — With disposable fixtures, remove an office role while that same account remains signed in, then refresh the directory. Private rows/actions disappear or access fails explicitly; an allowed own-family subset must not be mislabeled as the full school directory. Switching school/account during a pending read must not display the old school's late response.
- [ ] OW-17 — Recheck the existing QA siblings, attendance, fees/receipts, Guardian child links and notification read counts before/after this phase. An admission must not rewrite another pupil's history or reset another Guardian's read state. Record any differences privately for reconciliation.
- [ ] OW-18 — Test laptop and narrow-phone layouts in both themes, keyboard focus, long names, loading/error/empty states, bounded guardian lists and button progress. Account/context changes during a pending save must not show an old success in the new account. Founder signs off independently after recording actual results.

This release does not activate email/SMS/FCM delivery, add an enquiry CRM/seat-management system, complete all remaining web modules or integrate an attendance device. Physical notification/hardware acceptance remains a separate controlled pilot.
