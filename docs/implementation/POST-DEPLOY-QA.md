# Manual QA for Vercel Preview

Use this checklist on the deployed ERP before inviting a school to use it. Start with attendance, which has already been checked in the local frontend against hosted demo Supabase. Record a new result for the Vercel URL you actually test.

## Test run

| Field | Value |
| --- | --- |
| Preview deployment URL | [Open Preview](https://kids-corner-erp-frontend-3icyvjq85-shoaibhasanns-projects.vercel.app/login) |
| Commit SHA or deployment ID | `8564d8f3ee507c76293abbb9db8d0b37f398b60a` · `dpl_9Z6rC7sTCm4UfM4c7GAUEB8UAMQX` |
| Tester and date (IST) | Shoaib · 4 November 2026 |
| Browser, device and viewport | |
| Supabase test project | Kids Corner School ERP demo · `bjecfuixgqgyohttrdfr` |
| Result | Pass · attendance QA reported by Shoaib |

Shoaib confirmed the attendance QA pass on the Preview above. Individual case results and device details were not provided. Keep the run below as a regression checklist for future deployments.

For the person deploying, set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` for Preview to the demo project that contains the QA school. Deploy the revision you want to test after setting the variables. [Vercel environment variables](https://vercel.com/docs/environment-variables)

1. Open the Preview URL and fill in the run details above. Use the existing QA admin, teacher, student and parent logins from the private credential handoff. If Vercel asks you to sign in first, complete that prompt and then use the ERP's `/login` page.
2. As the admin, confirm the demo school with code `QA-261103-fccd05a4`, year **2026-27 QA**, class **QA Class 6**, and section **QA A**. Check the **3 and 4 November 2026 (IST)** baseline below before writing. If the account, school, or marks differ, record **Blocked** and check the Preview configuration or QA credentials with the person who set them up.
3. Pick two different selectable dates in that academic year for the teacher and admin save tests. Verify all three students are Unmarked on each date before editing. For a rerun, pick fresh dates and keep earlier QA marks with their run notes.

| QA student | Admission number | Status on both 3 and 4 Nov | Family access |
| --- | --- | --- | --- |
| One | `QA-fccd05a4-001` | Late | Student login and parent login |
| Two | `QA-fccd05a4-002` | Absent | Parent login |
| Three | `QA-fccd05a4-003` | Holiday | Teacher and admin roster |

Teacher test date: `____` · Admin test date: `____`

## Feature checks

Tick a case after you verify its expected result on the Preview URL. Use a private window or sign out between roles so each case uses the intended account.

- [ ] **AUTH-01 · Login and role routing.** Open `/dashboard` signed out. The ERP opens login. Sign in with each of the four QA accounts and check the role shown in the sidebar. Refresh while signed in and confirm the same account and dashboard load.
- [ ] **AUTH-02 · Sign out and direct URL.** Sign out, then open `/modules/attendance` directly. The page blocks access and the previous user's history is hidden. Sign in as the QA student and open `/modules/teacher-assignments` directly. The page denies access.
- [ ] **ATT-01 · Teacher roster and save.** Open **Attendance** as teacher. Confirm QA Class 6 / QA A and three students. On the unused teacher date, start with all three Unmarked. Set One to Present and Two to Absent, then **Save Attendance**. Expect a message for two saved students. Reload the register and then refresh the browser. Reselect the test date if needed. One is Present, Two is Absent and Three is Unmarked.
- [ ] **ATT-02 · Teacher draft and bulk action.** On that same date, click **Mark unmarked present**. Three becomes Present and Two stays Absent. Before saving, check that the date picker is disabled. Click **Discard changes and reload** and confirm Three returns to Unmarked. Return to 3 or 4 Nov and confirm the Late / Absent / Holiday baseline.
- [ ] **ATT-03 · Admin scope and edit.** Open **Attendance** as the QA admin. Confirm the QA school, current year, class and section. Search by a QA admission number and clear the search to restore all three rows. On the unused admin date, set One to Present, Two to Absent and Three to Holiday, then save. Reload, change only One to Late and save again. The second success message reports one student. Refresh and reselect that date. The three statuses are Late / Absent / Holiday.
- [ ] **ATT-04 · Student reads own marks.** Sign in as the QA student. Check the dashboard's **Attendance History**, then open **Attendance** and refresh. Student One's baseline dates both show Late, and 4 Nov appears above 3 Nov. The history may also include marks from this run's save tests. This account should show its own rows and a read-only view.
- [ ] **ATT-05 · Parent switches linked children.** Sign in as the QA parent and open **Attendance**. The child picker offers One and Two. Select One and refresh, then select Two and refresh. Each refresh retains that child in the same tab. One has Late on both baseline dates and Two has Absent. Return to the dashboard and confirm it carries over the selected child. Three is outside this account's linked roster.
- [ ] **ATT-06 · Cross-role readback.** Open the student or parent Attendance page after the admin save. On the admin test date, confirm One's Late mark appears. Switch the parent to Two and confirm Absent. Compare these results to the admin register for that date.

## UI and UX checks

- [ ] **UX-01 · Mobile and desktop.** Check the login, register and family history at about **390 px** and **1440 px** wide. Open the navigation, choose a child or date, scroll the roster and find the action buttons. Look for clipped names, buttons behind the fold with no way to reach them, and horizontal page scrolling.
- [ ] **UX-02 · Keyboard and theme.** Tab through login, navigation, date, status and child controls. Focus is visible and follows the screen order. In light and dark themes, status text, disabled states and error messages are readable.
- [ ] **UX-03 · Loading, empty and error.** On an open register, throttle the network and reload the register. Look for a loading message. Search for a name with no match in the admin register. The empty state explains what happened, and clearing search brings the roster back. With the page already open, go offline and click **Reload register**. An error appears and saving is disabled. Go online and reload the register to recover.
- [ ] **UX-04 · Save feedback.** During a save, the Save button shows progress and prevents a second submit. After success, the message gives the number of saved students. With no changes, Save is disabled. When a draft is pending, the screen explains how to save or discard it.
- [ ] **UX-05 · Dates and readable labels.** Compare the register's selected date to the family history for the same record. Check that Late, Absent and Holiday are readable as text. Verify that the default day matches the school day in IST when testing around midnight.

## Results and bugs

Record `Pass`, `Fail` or `Blocked` for the deployment above. Add one row per failed or blocked case with the test ID, role, route, device, steps, expected and actual behavior, and a screenshot if useful. Share access or fixture blockers privately with the person who set up the Preview.

| Test ID | Result | Role, route and device | Steps, expected, actual and evidence |
| --- | --- | --- | --- |
| | | | |

For the next Preview, record its URL and revision with the new results. Keep past runs and notes. When a feature or UI change lands, add its test ID, steps and expected result here and leave it pending until Shoaib checks the deployed version. Keep automated and local verification in the [implementation log](PHASES.md).

## Guardian invitation QA

Use a deployment that includes the guardian invitation changes. Record its URL, revision, device and test date separately from the attendance run above. Use the demo project and an account with the same verified email used in the invitation. The original fixture parent already has two children linked, so use a fresh guardian account to test first-time linking.

| Field | Value |
| --- | --- |
| Preview deployment URL | [Open guardian Preview](https://kids-corner-erp-frontend-iidtbxhn9-shoaibhasanns-projects.vercel.app/login) |
| Revision and deployment ID | [`16500f1d05526d90fd45b88c9d6694e782ddafc2`](https://github.com/shoaibhasann/kids-corner-erp-frontend/commit/16500f1d05526d90fd45b88c9d6694e782ddafc2) · `dpl_CABe7hFPY6dR27mZpQKsP1dAmGer` |
| Automated Preview run | 4 November 2026 IST · Chromium · 1440 px admin and 390 px guardian |
| Automated result | Pass with a fresh, pre-confirmed QA account. Real signup email delivery is pending founder QA. |
| Founder name, date (IST), device and browser | |
| Founder result | Pending |

The deployed browser run verified invite creation and copying, student access denial, wrong account rejection, replacement and revocation, one successful acceptance from two tabs, replay rejection and read-only history after refresh. Supabase returned records for the linked child and denied attendance writes. These results use the existing demo roster.

### Founder email test

1. Open the current release Preview below and sign in to Vercel. Use the QA school and synthetic pupil for this run. For the guardian, use an inbox you control that has never signed up in this ERP. Supabase's default mailer can send to existing project-team addresses. Use an inbox supported by the project's custom SMTP if configured. [Supabase email delivery](https://supabase.com/docs/guides/auth/auth-smtp)
2. In Supabase Auth **URL Configuration**, confirm the redirect allowlist covers `https://kids-corner-erp-frontend-bn2r07l11-shoaibhasanns-projects.vercel.app/auth/callback?next=%2Fguardian-invite`. [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
3. Complete **GUA-01**. In a separate browser profile that can open the Vercel Preview, open the copied link and choose **Create a guardian account** using that exact email address.
4. Check that the confirmation email arrives. Open the confirmation link in the same browser profile where you created the account. Reopen the original guardian invite, sign in if prompted and select **Accept invitation**.
5. Complete **GUA-02**. Mark **GUA-03** Pass only after the email reaches the inbox, confirmation works, attendance opens and refresh preserves the linked child. If blocked, record which step failed and what appeared. Keep passwords, invitation links and confirmation links out of the report.

- [ ] **GUA-01 · Invite one enrolled child.** As a QA school admin or principal, open **People → Guardian invitations**. Choose the QA school, QA Class 6, QA A and Student One. Enter the guardian's exact email and create the invite. Expect a copyable link and a Pending entry with a 72-hour expiry. Refresh and confirm the history is still Pending. Keep invite links out of screenshots and bug reports.
- [ ] **GUA-02 · Sign in and link.** In a separate browser session, open the invite. Sign in with the invited account and accept. Expect Student One's read-only attendance history, including Late on 3 and 4 November. Refresh and confirm the history persists. Two and Three should be absent from this account's child list. Reload the admin's invitation history and expect Accepted.
- [ ] **GUA-03 · New account email confirmation.** Use a fresh inbox you control. Create an account from the invite, confirm the email, then reopen the original invite and sign in if prompted. Accept and verify the same attendance flow. Use a Preview with Supabase email delivery and the deployment's `/auth/callback` redirect configured. Record Blocked if the confirmation email cannot be delivered.
- [ ] **GUA-04 · Wrong email and school.** Open a pending invite while signed in as a different QA account. Acceptance should fail and leave the invite Pending for the intended account. As a teacher or student, open `/modules/guardian-invitations` directly and check that access is denied. If another demo school is available, verify its administrator cannot create or revoke an invite for the first school.
- [ ] **GUA-05 · Reissue, revoke and expire.** Reissue a pending invite for the same student and email and try the older link. It should fail. Revoke a pending invite in the admin history and confirm its link fails. Use a fixture expired by QA setup to verify expiry. Keep the original accepted test link for the replay check.
- [ ] **GUA-06 · Replay and duplicate submit.** Open a valid invite in two tabs with the invited account. Submit acceptance from both and expect one success. Open the used link again and confirm it cannot create a second link. The already linked child remains visible in attendance after refresh.
- [ ] **GUA-07 · Mobile and keyboard.** At about 390 px, navigate school, class, section, student and email with a keyboard and copy the link. On the invite page, check signed-out, signing-in, signed-in and error states. Confirm that link creation, acceptance and revocation show feedback and disable their controls while pending.

Revoking a pending invitation stops that link from being used. Accepted guardian links are managed separately. See the [implementation phases](PHASES.md) for automated and browser verification.

## Phase QA fixture and school setup

The [school workflow Preview](https://kids-corner-erp-frontend-i38lmtc5r-shoaibhasanns-projects.vercel.app/login) covered app revision `0eae34fa5fdc8cfdfb1e75c8384461962c408bda`, deployment `dpl_DcDVES3A77DGWGmRa672SyV3Jsgq`.

Use school `ERP-QA-d767af40` in the demo Supabase project. It has a school-scoped QA admin, academic year **2026–27 Phase QA**, **QA Class 6 / QA A**, and synthetic students Pilot One and Pilot Two. A QA student login is linked to Pilot One. Use the private local handoff for the admin, student and guardian accounts.

- [ ] **SET-01 · Academic setup.** As the QA admin, open **Academics & Subjects**. Add a future year, a class, a section under that class and a subject. Reload and confirm all four records persist. The original current year should still be current.
- [ ] **SET-02 · Enroll a student.** Open **People → Students**. Pick QA Class 6 / QA A and enter a unique QA admission number and name. Admit the student, reload and find the student in the class roster. Reusing the same number should fail without adding another row.
- [ ] **SET-03 · Verify linked workflows.** Open Attendance and Guardian Invitations for the same class and section. Both should include the new student. Sign in as the QA student and check that the account can only read its own records.

## Office and family QA

- [ ] **FEE-01 · Issue a monthly demand.** As the QA admin, open **Finance → Fee**. Use QA Tuition and an unused month in the current year for Pilot One. The amount should come from the ₹1,000 structure. Repeating the same demand with the same due date should keep one record.
- [ ] **FEE-02 · Collect and reconcile.** Record a ₹300 cash payment, reload and check ₹700 outstanding. Record ₹700 with a synthetic UPI reference and check that the demand shows Paid and the balance is ₹0. Open both receipts in **Invoices & Receipts**. Compare receipts and the remaining school balance with **Finance Reports**. Existing QA payments can affect the school totals.
- [ ] **FEE-03 · Family receipt scope.** Sign in separately as the QA student and guardian. In **Invoices & Receipts**, check the two office receipts for Pilot One. Reload and confirm the same receipts appear. Pilot Two's receipt should remain hidden, and the page should have no payment controls.
- [ ] **NOT-01 · Publish and check audience.** As the QA admin, save a Parents-only draft and publish a separate Parents-only notice. In **Notices & Circulars**, the guardian should see the publication but not the draft. The student should see neither. Unpublish the first notice and reload the guardian inbox, then republish and verify it returns.

The school setup, attendance and guardian linking, fee and receipt, and notice cases above were exercised in local Chromium with hosted demo Supabase. A separate deployed Preview run verified admin academic records, the admitted pupil, finance report totals, and the guardian's scoped receipts and notices. All 346 automated tests, lint, typecheck and build passed. The email inbox test still belongs to the founder run.

## Teacher onboarding, CSV import, cashier close and workspace navigation

Use the [current release Preview](https://kids-corner-erp-frontend-bn2r07l11-shoaibhasanns-projects.vercel.app/login), app revision `fdbd24a896ebad7e560d33ec356037697378ca26`, deployment `dpl_HC9otgYvgsC1GTpUsp7R1fNoYqjh`. Sign in to Vercel first, then use the ERP QA account.

- [ ] **CSV-01 · Import and reload.** In **Students**, choose QA Class 6 / QA A and open **Import students from CSV**. Download the template, add two new admission numbers and preview both rows before importing. Reload and confirm both pupils appear. Try a file with one new admission and one existing number. Confirm the entire batch is rejected and the new row is absent.
- [ ] **CLOSE-01 · Check the saved close.** In **Finance Reports → Cashier day close**, choose 31 October 2026 IST. Expect a closed record with ₹200 recorded cash, ₹190 counted cash, one receipt and a −₹10 variance with its note. Refresh and confirm the values persist. For a new close, use a separate historical QA date with synthetic receipts.
- [ ] **NAV-01 · Page finder and mobile menu.** On desktop, open **Find a page** with Ctrl+K or Cmd+K. Search for a page and open it with Enter. On a 390 px viewport, open **More**, press Escape and verify focus returns to the trigger. Sign in as the guardian and check that page search offers Attendance and Receipts while excluding Finance Reports.
- [ ] **STAFF-01 · Invite and assign a teacher.** In **Teachers & Staff**, create a synthetic employee record with a new employee ID. Create an invitation for the exact verified teacher email and use it to link the account. Verify the directory shows Linked after reload. As admin, assign the teacher to QA Class 6 / QA A. The teacher should see their assigned attendance roster on reload and be denied direct access to Finance Reports.
- [ ] **STAFF-02 · Check invitation boundaries.** Reissue a pending teacher invitation and confirm the original link fails. Try the latest link with a different verified account and check that acceptance fails. Open the accepted link again and check it cannot be reused. Use an approved fresh inbox for the founder's actual email confirmation run.

For teacher email confirmation on this Preview, allow `https://kids-corner-erp-frontend-bn2r07l11-shoaibhasanns-projects.vercel.app/auth/callback?next=%2Fteacher-invite` in Supabase Auth URL Configuration. The teacher browser run used a pre-confirmed QA account. Fresh-account email delivery is pending founder QA. [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)

Deployed Preview checks passed for the imported roster, saved cashier close, assigned teacher attendance, teacher denial from Finance Reports, and the guardian's mobile receipts and role-filtered page finder. All 363 automated tests, lint, typecheck and build passed.

## Historical attendance, withdrawal and guardian access

Use the [protected Vercel Preview](https://kids-corner-erp-frontend-pso2yvuzv-shoaibhasanns-projects.vercel.app/login), app revision `0dd074aa9e3b1bffc143e90da5b92afef71a95e2`, deployment `dpl_2rSaYRNy9NvrcKcvJPoSGyr47m68`. Sign in to Vercel first and use demo QA accounts.

Use a disposable pupil and synthetic reasons in the demo school `ERP-QA-d767af40`. Keep Pilot One linked to the existing QA guardian so you can verify that removing a second child does not affect the first. Historical register tests above record earlier releases. In the new flow, save the current IST day directly and use an approval for any earlier date.

- [ ] **GDN-03 · Link a second child.** As school admin, admit the disposable pupil in QA Class 6 / QA A and issue an invitation to the existing QA guardian. Accept as that guardian. Both pupils should appear in the child picker after refresh. Create a second pending invite for the same disposable pupil and account before withdrawal.
- [ ] **ATT-07 · Request and approve.** As the assigned QA teacher, open a past date in the current academic year. Request a different status for the disposable pupil with a reason. If the row is unmarked, request the initial status. Refresh and confirm that the existing mark stays unchanged until an admin or principal approves the request. Review with a reason, reload, and verify the original and updated values and the review details. The guardian sees the approved status after refreshing the child's Attendance.
- [ ] **ATT-08 · Reject and check permissions.** Submit a second request for the same pupil and day after the first has closed. Reject it with a reason and refresh the register to confirm that the approved mark is still present. Try opening the review queue as a teacher, student and guardian. Review controls must remain restricted to authorized roles.
- [ ] **RST-03 · Withdraw with history.** As school admin, withdraw the disposable pupil from **Students** with a reason. Reload and confirm the pupil is absent from active roster and current-day Attendance. Check the saved withdrawal history. As the linked guardian, confirm previous attendance remains available while the relationship is still authorized. The pending invitation cannot be accepted after withdrawal.
- [ ] **GDN-04 · Remove a withdrawn child's link.** As school admin, find the disposable pupil by admission number in **Guardian invitations** and remove the guardian relationship with a reason. Reload the admin workspace and verify the audit entry. Refresh the guardian's Attendance. Pilot One stays visible, and the disposable pupil is absent from the child picker and history. Reopen the pending link and verify that it cannot restore access.
- [ ] **UX-06 · Use the new controls on phone and desktop.** At about 390 px and 1440 px, use the reason fields, Cancel and submit actions, status feedback and history. Check that dialog focus returns to its trigger on Cancel, review actions stay readable and the page does not scroll sideways.

Automated Chromium against demo Supabase verified same-day save and reload, historical approval and rejection, guardian readback after approval, withdrawal with retained history, and guardian removal with Pilot One still linked. Deployed Preview checks verified both review outcomes, the withdrawn roster, the access-removal audit, teacher review restriction and the guardian’s scoped history after refresh at 390 px. The cases above remain open for manual QA. Live account-confirmation email remains in the founder checklist.

## Same-school transfer and session promotion

Use the [protected Vercel Preview](https://kids-corner-erp-frontend-alhgfo11v-shoaibhasanns-projects.vercel.app/login), revision `7dc5375081986869539bfaa2e78657d12ca84adc`, deployment `dpl_DQ7Likct5SZLdC3DFVrMuQhF5Lc5`. Sign in to Vercel, then use the private QA handoff for school `ERP-MOVE-QA-15c7ba80`.

Use the separate synthetic placement QA school for this run. The existing placement fixture has a completed transfer and activation and can be used to check readback. For another full write run, use a disposable QA school with two active pupils, two sections in the current session and a later nonoverlapping session. Use a pupil with an older mark and a fee demand with a paid receipt. A transfer takes effect on the current IST day, before marking the pupil for that day.

- [ ] **MOVE-01 · Transfer and reload.** In **Students**, select the source class and section. Open **Change placement** for the pupil. Confirm that Cancel returns keyboard focus. Select the current academic year and a different class or section, review the destination, enter a reason and confirm. Reload both rosters. Expect the same admission number in the destination only, a cleared roll number, and the change under **Placement history** for the source section.
- [ ] **MOVE-02 · Check attendance boundaries.** In **Attendance**, open the source section and the historical date. The original mark remains there. The pupil appears in the destination register from the transfer date. As the original class teacher, verify that the pupil is absent from today's roster and the previous mark is still visible on its historical date. Repeat with an already-marked disposable pupil and check the transfer is blocked.
- [ ] **PROM-01 · Prepare and revise.** In **Students**, use **Change placement** to select a later academic year and stage a destination. Verify the current roster and dashboard still show the current placement. Repeat for the same later year with a different section and a new reason. Both events appear in placement history, and activation will use the revised destination. Submitting the same destination twice should show an existing-stage message.
- [ ] **PROM-02 · Review readiness.** In **Academics & Subjects → Academic years → Activate next academic year**, select the destination. Check the ready and missing counts. An incomplete roster, unresolved attendance correction or date outside the destination session blocks activation. Prepare the remaining pupils and resolve corrections before refreshing readiness.
- [ ] **PROM-03 · Switch sessions.** During the destination session in IST, enter the activation reason and confirm the switch. Reload. Exactly one academic year shows Current and the pupils are in their confirmed destinations. Verify a teacher can be assigned for the new session without removing their old assignment. Mark current-day attendance and refresh.
- [ ] **HIST-01 · Preserve attendance and fees.** As office admin, select the earlier year, source section and date in **Attendance**. Verify the original mark and read-only controls. Sign in separately as student and linked guardian. Refresh **Attendance** and **Invoices & Receipts** and compare the original date, status, receipt number and amount. Check the earlier demand and remaining balance in the office fee view.
- [ ] **UX-07 · Mobile and role boundaries.** At 390 px and desktop widths, check destination selects, readiness counts, focus and error feedback. Try placement or activation using a teacher, student, guardian or an admin from another school. The server should reject the action.


Automated browser QA against hosted demo Supabase moved **QA Placement Pupil** from Grade 6 QA A to QA B, prepared and revised the promotion, blocked activation while a second pupil was unplaced, and activated the Grade 7 roster. The synthetic school calendar was advanced between the transfer and activation tests to exercise both date boundaries. The original **2 November 2026 Late** mark stayed in Grade 6 QA A. The **₹1,000** demand, **₹325** receipt and **₹675** outstanding stayed visible after reload. The previous teacher could read the original mark and could save and reload **Present** in the new session once reassigned.

Protected Preview readback passed for the new roster, prior register, prior-session placement audit, teacher save history, and student and guardian attendance and receipts after refresh. The 390 px checks found no horizontal page overflow. All 388 automated tests, lint, TypeScript and the build passed. The checkboxes above are for your independent run.

## Staff and guardian CSV imports

Open the [protected Vercel Preview](https://kids-corner-erp-frontend-7zd4zksw4-shoaibhasanns-projects.vercel.app/login). Revision `f4952e83be2b12dd0b2e752df9e56b8ede30ae0b`, deployment `dpl_Dodo4JfqMBv5z6y1NMuPKhPb7eFD`. Sign in to Vercel, then open the ERP with your QA account.

Use the synthetic school `ERP-MOVE-QA-15c7ba80` and the private QA handoff. Sign in as the school admin. Both templates accept UTF-8 CSV files of up to 50 rows and 64 KB. Use fresh employee IDs and verified synthetic guardian accounts for a new write run. The completed fixture can be used to check existing duplicates and readback.

- [ ] **STAFF-CSV-01 · Preview and reject duplicates.** Open **Teachers & Staff → Import staff from CSV** and download the template. Use columns `employee_id,full_name,staff_type` with type `teacher` or `staff`. Add the same employee ID twice with different case and staff types. Both rows should be flagged. Try a new file using an ID already in the other directory and confirm that import stays disabled.
- [ ] **STAFF-CSV-02 · Save and reload.** Preview one new teacher and one new non-teaching staff member. Confirm names, types and employee IDs before importing. Reload and verify each record is in its directory and the audit shows one of each. The teacher starts awaiting a link. Use the teacher invitation workflow if they need a school login.
- [ ] **GDN-CSV-01 · Match admissions and reject invalid rows.** Open **Guardian invitations → Import guardian invitations from CSV** and use `admission_number,guardian_email`. Try an unknown admission number, an already linked email for that pupil, and a duplicate pair with different email case. Confirm the errors and that an invalid row blocks the whole import.
- [ ] **GDN-CSV-02 · Confirm and deliver.** Preview two pupils with separate verified synthetic recipient emails. Compare each matched name, admission number and email. Confirm the batch. Copy each link privately before leaving the page. Upload the same file again and verify the pending invitations are flagged as duplicates.
- [ ] **GDN-CSV-03 · Verify access boundaries.** Attempt acceptance with the other recipient's account. Then accept each link using its intended verified account. Refresh **Attendance** and confirm each guardian sees only the matched pupil's history. Reupload the same file and check that linked pairs are blocked. An admin from another school must be denied when attempting to preview the batch for this school.
- [ ] **CSV-UX-01 · Recover from a lost response.** In a disposable QA run, interrupt the response after confirm. Retry from the same preview. Verify the teacher and staff records are each saved once and the guardian links are recovered while still pending. At 390 px and desktop widths, check labels, focus and that the preview table scrolls within its region.


Hosted demo browser QA imported one teacher and one non-teaching staff record. Both appeared once after a simulated lost response and retry. The imported teacher accepted a separate invitation and opened the teacher dashboard. Guardian CSV preview matched two different admission numbers, blocked unknown and duplicate rows, and recovered both pending links after the same retry test. The wrong recipient and an admin from another school were denied. After acceptance and refresh, the first guardian saw only the first pupil's original Late mark and the second guardian saw only the second pupil's Absent mark.

Protected Preview readback passed for the staff directories and audit, duplicate checks in both import screens, and the second guardian's attendance at 390 px. All 405 automated tests, lint, TypeScript and the build passed. The browser used preverified synthetic accounts to exercise invitation acceptance. The checkboxes above are for your independent run.

## Classes, sections, subjects and teaching assignment CSV imports

Use the [protected Vercel Preview](https://kids-corner-erp-frontend-m877yra2m-shoaibhasanns-projects.vercel.app/login), revision `9a488c2121b4eebf63a644bad9866ae3b0a3181e`, deployment `dpl_FxGWGmpQJnnT4QrFRj285G3kDGFE`. Sign in to Vercel first.

Use synthetic school `ERP-MOVE-QA-15c7ba80` and the private QA handoff. Sign in as school admin. Download each template from its import panel. Each file accepts up to 50 data rows and 64 KB in UTF-8. For a fresh write run, use unused names and subject codes and a verified QA teacher who has no current class-teacher duty.

- [ ] **ACAD-CSV-01 · Classes.** In **Academics & Subjects → Classes**, open **Import classes from CSV** and upload `name,sort_order`. Add two names that differ only in case or use an existing class name. Verify the duplicate is flagged before confirmation. Import two unique classes and reload to check their names and order.
- [ ] **ACAD-CSV-02 · Sections.** In **Sections**, use `class_name,name` to give the two new classes the same section name. Verify that preview shows the right class for each row. Try an unknown class and repeat one class and section pair to verify rejection. Import the valid file and check that each class has its own section after reload.
- [ ] **ACAD-CSV-03 · Subjects.** In **Subjects**, use `name,code`. Confirm that a repeated name or nonblank code is flagged, including case variations. Import two unique subjects and check their codes after reload. A subject can also be imported with a blank code.
- [ ] **ASG-CSV-01 · Preview assignments.** In **Teaching Assignments → Import teaching assignments from CSV**, use `employee_id,class_name,section_name,subject_name,is_class_teacher`. Review the resolved teacher name and the exact class, section and subject in the current academic year. Use `true` or `false` for class-teacher duty. Try an unknown section, repeated assignment and an existing class-teacher duty. Verify each invalid batch stays blocked.
- [ ] **ASG-CSV-02 · Save and verify access.** Import one class-teacher and one subject-teacher row for the linked QA teacher. Use the shared section name under different classes and distinct subjects. Reload the assignment list and verify both rows. Admit a synthetic pupil to the class-teacher section, sign in as that teacher, and save and reload attendance. The unrelated pupil remains outside that register.
- [ ] **ACAD-CSV-UX · Retry and scope.** In a disposable QA run, interrupt a confirmed import response and retry from the same preview. Confirm each row is saved once. Preview the assignment batch with an admin from another school and verify denial. At 390 px, check that preview tables scroll within their containers.


Hosted demo browser QA created two classes, a distinct same-named section under each class, and two subjects with their assigned codes. It blocked case-variant duplicate class names and subject codes and rejected an unknown parent class. The class batch saved once after an interrupted response and retry.

The assignment batch correctly mapped one class-teacher and one subject-teacher row for the linked QA teacher. It rejected an unknown section, repeated tuple, existing class-teacher duty and cross-school preview. A lost-response retry produced one audit receipt and two assignments. The teacher saved Present for the pupil in the imported class-teacher section and verified it after refresh. The unrelated pupil remained outside their register and API reads.

Protected Preview readback passed for the class import history, mapped sections, subject code, existing duplicate checks and the teacher's saved attendance at 390 px. All 421 automated tests, lint, TypeScript and the build passed. The checkboxes above are for your independent run.

## Guardian recovery and verified contact changes

Open the [protected Vercel Preview](https://kids-corner-erp-frontend-dfyf0w4iz-shoaibhasanns-projects.vercel.app/login). Revision `1814c60aff82b5a7c3c18f49fc21af5fac736c82`, deployment `dpl_A3NbtTDWDPtZVWd9VgmEq9tkhfoS`. Sign in to Vercel first.

Use a synthetic guardian account linked to two pupils in QA school `ERP-MOVE-QA-15c7ba80`. The private QA handoff contains the completed test identity. For another write run, use a disposable account with access to the current and proposed email inboxes. Record the guardian account ID and both linked pupils before starting.

For actual email delivery, configure an authorized sender and use the Supabase confirmation URL in the recovery and email-change templates. Enable **Secure email change** and allow `https://kids-corner-erp-frontend-dfyf0w4iz-shoaibhasanns-projects.vercel.app/auth/callback**` for this Preview so the PKCE flow query can return. The app uses PKCE, so open email links in the browser that started the request. For actual SMS delivery, enable phone authentication with confirmation and a configured SMS provider in a test environment. The shared demo project currently displays SMS verification as unavailable. [Supabase Auth test flows](https://supabase.com/docs/guides/auth/testing-auth-flows) · [Redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls)

- [ ] **REC-01 · Recover the password.** Open **Forgot password** and submit the guardian's verified email. Try an unknown email separately and compare the generic response. Open the received reset link in the original browser, enter the new password and sign in again. Check the old password fails. A normal session or invalid callback cannot open the reset form.
- [ ] **REC-02 · Check the same guardian after refresh.** After signing in with the new password, open **Attendance**. Switch between the two pupils, reload and verify each history. Another pupil remains outside the account's scope.
- [ ] **CONTACT-01 · Verify both email inboxes.** In **Profile → Guardian contact settings**, request a new email. Check the current email stays verified and the change shows as pending. Confirm one inbox and verify the original sign-in email still works. Confirm the other inbox, refresh and sign in with the new email. Confirm the original address no longer signs in and both child links are intact.
- [ ] **CONTACT-02 · Check old invitations.** Before changing email, prepare one pending guardian invitation for the original address. After the email change completes, verify the invite shows revoked and cannot be accepted. Previously accepted child links still work.
- [ ] **CONTACT-03 · Verify the new mobile.** In the SMS-enabled test environment, request a new international-format number. Try an incorrect current password first. After entering the correct password, the old verified number must remain while the new number is pending. Try an incorrect code, then enter the correct six-digit code within five minutes of authorizing the number. Refresh Profile and verify the new number and both pupil links. On the shared demo Preview, verify the unavailable state when SMS is disabled.

Automated browser QA used synthetic challenges to exercise real Supabase Auth verification without sending messages to QA addresses or numbers. Recovery rejected normal sessions and invalid callbacks, accepted a provider recovery session and rejected the old password after reset. The first email confirmation kept the old address, the second changed it and revoked the old address's pending invitation. Mobile verification rejected the wrong password and code, then persisted the verified number to the guardian's school record. The Auth UUID, guardian profile ID and two child links were the same after each refresh, and the unrelated pupil remained inaccessible.

On the protected Preview at 390 px, the new email and password worked, Profile showed the verified email and mobile, both scoped attendance histories persisted after refresh, and the normal session could not open the recovery form. The demo Preview showed the expected SMS unavailable state.

All 449 automated tests, lint, TypeScript and the build passed. Actual inbox and carrier delivery remain manual checks. The shared demo phone provider is disabled.

## Revoke and re-invite a guardian for one child

Open the [protected Vercel Preview](https://kids-corner-erp-frontend-pguhjmwkr-shoaibhasanns-projects.vercel.app/login). Sign in to Vercel first. Revision `f3205666aac6166556875328dc3c7eaeed5793cf`, deployment `dpl_EjcX5qV3cqcs1HggvCGjFBumQwWX`. The private QA handoff has the demo accounts for `ERP-MOVE-QA-15c7ba80`.

Use a synthetic school administrator and an existing verified guardian linked to two pupils in the same QA school. Pick two pupils with saved attendance and note the dates and marks before the run. Keep the administrator and guardian signed in in separate browser sessions.

- [ ] **GDN-05 · Revoke one link.** In **Guardian invitations → Manage linked guardians**, find the target pupil by admission number. Select **Remove access** for the intended guardian, enter a QA reason and confirm. Search again after reload. The guardian should appear under removed access, and the history should show the reason. The guardian’s existing session should lose the target pupil on Attendance refresh and still show the sibling’s saved marks. If a second guardian is linked to the target, verify that guardian still sees the pupil’s marks.
- [ ] **GDN-06 · Issue and replace a link.** Choose **Re-invite guardian** on the removed row. Confirm the current verified address and create the link. Reload the admin page and find the same student. Check the pending status. Replace the link and verify the earlier link fails. Until the latest link is accepted, the removed pupil should stay out of the guardian’s child picker.
- [ ] **GDN-07 · Restore the original relationship.** Open the latest link in the guardian session and accept. Refresh Attendance and verify both pupils and the original dates and marks. Search again as admin and verify the original relationship is active. Try the accepted link again and verify it cannot be reused.
- [ ] **GDN-08 · Check boundaries.** Try the re-invitation with another verified account before the intended guardian accepts it. Verify the wrong account gains no access. Try the admin workflow as a non-admin or with an administrator from another school. Verify the action is denied. Try a regular invitation and a CSV row for the removed pair. Both should point to the school administrator’s re-invite flow. Check that a withdrawn pupil can be found for removal and needs an active current-year enrollment before a new link can be issued.

Share the generated link privately with the listed guardian. Re-invitation uses the guardian’s existing verified account.

Deployed Chromium QA passed with an admin at 1440 and 390 px and a guardian at 390 px. The already signed-in guardian lost only the target pupil in Attendance and in direct Supabase reads. The sibling and second guardian retained access. The administrator could still read every original attendance row. Replacing the re-invite invalidated the earlier link. The wrong account and replayed link were rejected. Accepting the latest link with the same account restored the original relationship and primary flag. After refresh, the target’s **Late on 2 Nov** and **Present on 4 Nov** and the sibling’s **Absent on 5 Nov** matched the original rows and IDs. The admin lookup showed the restored link and cleared the pending state. Guardian and other-school administrator re-invite calls were denied. The regular invite path could not restore the removed pair.

All 450 automated tests passed with `npm test -- --maxWorkers=4 --testTimeout=20000`. The first run hit seven default timeouts in existing database tests. Lint, TypeScript and the Vercel build passed.

## In-app absence alerts for guardians

Open the [protected Vercel Preview](https://kids-corner-erp-frontend-rmfywfgug-shoaibhasanns-projects.vercel.app/login). Sign in to Vercel first. Revision `4d06f4ce7f52595e9f9d55454a06144c47f9c329`, deployment `dpl_48h5tMF2wnr5pzEhma4JXCRdSZhN`. Use the private QA handoff for the demo school `ERP-MOVE-QA-15c7ba80`.

Use a synthetic school admin, two disposable pupils and two verified guardians. Link both guardians to the first pupil. Link the guardian you will revoke to the second pupil as well so their guardian account stays active. Start with an unused attendance date or marks you can safely change in the demo register. Keep the admin and guardians signed in in separate browser sessions.

- [ ] **ALERT-01 · Save an absence.** In **Attendance**, mark the first pupil Absent and the second Present and save. Open **Notifications** in each guardian session. Under **Attendance alerts**, check that the first pupil appears once with the correct date. Also check the recent alerts on the guardian dashboard and Attendance page. Confirm Present and unlinked pupils do not appear.
- [ ] **ALERT-02 · Check a repeat save.** Reload the register and save another change while the first pupil stays Absent. Refresh the guardian screens and confirm that the existing alert still appears once. Check the same absence in the read-only Attendance page.
- [ ] **ALERT-03 · Revoke one guardian.** In **Guardian invitations → Manage linked guardians**, remove one guardian from the first pupil. Refresh both guardian sessions. The removed account should lose that pupil’s existing alert. The other guardian should still see it. Save a fresh absence for the pupil and confirm only a current guardian gets an alert.
- [ ] **ALERT-04 · Correct a mark and re-invite.** While the first pupil is Absent, restore the guardian link through the normal re-invite flow. Verify that the returning guardian gains access to Attendance and sees no alert for the existing absence. Change the first pupil’s mark to Present and verify that the other guardian’s alert disappears. A subsequent save that changes the pupil to Absent should show one alert for each eligible guardian. Use the correction queue if you test a past date.

Protected Preview Chromium QA passed with the school admin at 1440 px and both guardians at 390 px. For the two disposable pupils `QA-ALERT-65295d85-001` and `QA-ALERT-65295d85-002` on 5 November 2026 IST, the first save showed one alert to each linked guardian for the Absent pupil. The unrelated guardian received zero. An authorized repeat update kept the same alert IDs. After revocation, the same signed-in account lost the target pupil’s alert and kept its sibling access. The other guardian retained the target alert. Present cleared it, and the next Absent save showed one alert per eligible guardian. The Notifications and Attendance screens agreed after refresh. Re-invite restored attendance access and the target’s original attendance row, with no old alert appearing for the returning guardian.

All 456 automated tests passed with `npm test -- --maxWorkers=4 --testTimeout=20000`. Lint, TypeScript and the Preview build passed.

## Guardian Notifications unread count and mark as read

Open the [protected Vercel Preview](https://kids-corner-erp-frontend-pjwvjjxjn-shoaibhasanns-projects.vercel.app/login). Sign in to Vercel first. Revision `6bf64148d1e5dff2a4c8a9a9793c97e27f44ed87`, deployment `dpl_Bzznw6rz55K4ehbd4Z9q3Yvh3vdP`. The private QA handoff for `ERP-MOVE-QA-15c7ba80` has the test identities.

Use a disposable pupil linked to two verified QA guardians. Sign in as the two guardians in separate browsers or profiles. Record the starting unread count for each guardian, then save an Absent attendance mark for the pupil from the school admin register.

- [ ] **READ-01 · Find the new alert.** Open **Notifications** in both guardian sessions. Check that the pupil’s new alert shows Unread and increases each account’s unread count by one. Refresh once before making changes.
- [ ] **READ-02 · Read it as the first guardian.** Select **Mark as read** on the target alert. Check that it displays Read and the unread count decreases by one. Refresh and sign out and back in. The same alert should still show Read and the reduced count should persist.
- [ ] **READ-03 · Check the second guardian.** Refresh the other account. Its own copy should still show Unread with the original count. Mark it as read there and refresh both accounts. Each account should now show its own Read state.
- [ ] **READ-04 · Check retries and access.** Retry the same alert through the API from the intended account and verify the original read time and count. Try another guardian’s alert ID and a revoked alert ID. Verify the server returns no read time for those IDs and leaves the count unchanged. Where a guardian has more than 30 unread alerts, check that the count includes the full unread total and older unread alerts move into view as newer ones are read.

Protected Preview Chromium QA passed for `QA-READ-7de49d98-001` on 5 November 2026 IST. The admin saved Absent at 1440 px and both guardian inboxes at 390 px showed one unread alert. Marking the first guardian’s alert changed that count to zero while the second guardian still showed one. Hard reload and fresh browser sign-in preserved both states. Repeating the first action returned the original read time and alert ID. The second guardian’s browser action and overlapping API request returned the same saved time. Both accounts then showed zero unread after refresh. Other guardians’ IDs returned no read time, direct table writes were denied, and the original attendance mark was preserved. The database regression also verified 32 unread alerts counted across the 30-row list and stale IDs denied after correction or revocation.

All 461 automated tests passed with `npm test -- --maxWorkers=4 --testTimeout=20000`. Lint, TypeScript and the Preview build passed.

## Guardian Notifications filters and mark all as read

Open the [protected Vercel Preview](https://kids-corner-erp-frontend-7gqm1n59u-shoaibhasanns-projects.vercel.app/login). Sign in to Vercel first. Revision `86ce43bd1ea4c2ea169e40e1f8c150cb2e1e562f`, deployment `dpl_88dd2kgvyafmmtMkrLNZUPCrjnby`. Use the private QA handoff for demo school `ERP-MOVE-QA-15c7ba80`.

Use two verified QA guardians linked to the same two disposable pupils. Save both pupils as Absent in the school administrator’s Attendance register. Sign in as the two guardians in separate browser sessions.

- [ ] **BULK-READ-01 · Check All and Unread.** In the first guardian’s **Notifications**, mark one alert as read individually. **All** shows both alerts with their saved states. Select **Unread** and check that it only shows the unread alert and that the count stays at one.
- [ ] **BULK-READ-02 · Mark the remaining alerts.** From **Unread**, select **Mark all as read**. Confirm the unread count becomes zero, the Unread view is empty and the bulk button is disabled. Switch to **All** and check that both rows show Read.
- [ ] **BULK-READ-03 · Verify account isolation and refresh.** Refresh the first guardian’s page and sign in again in a fresh browser. Check that both alerts still show Read. Refresh the second guardian’s page. Both of that guardian’s alerts should still be unread until they are marked on that account.
- [ ] **BULK-READ-04 · Check retries and list limits.** Retry the bulk action from the same account and verify zero updates and unchanged read times. For an inbox with more than 30 unread alerts, check that the bulk action clears the full unread count, including alerts beyond the visible list.

Protected Preview Chromium QA passed for `QA-BULKREAD-4d21c8aa-001` through `-003` on 5 November 2026 IST. The 1440 px admin register save created three unread alerts in each guardian inbox. At 390 px, one individual read gave the first guardian mixed states in All, and Unread hid that read row. The in-page refresh kept the selected filter. Mark all changed the two remaining unread alerts, emptied Unread and disabled the action at zero. All showed three read rows. Hard reload and fresh sign-in kept the first guardian at zero unread and the other at three. The original individual read time, the other guardian’s rows and the attendance rows stayed the same. A retry and an administrator without a guardian link each returned zero updates. The database test also cleared 31 unread alerts from a list displaying 30.

All 465 automated tests passed with `npm test -- --maxWorkers=4 --testTimeout=20000`. Lint, TypeScript and the Preview build passed.

## School attendance cutoff and daily register progress

Open the [protected Vercel Preview](https://kids-corner-erp-frontend-fgzbjo1zo-shoaibhasanns-projects.vercel.app/login). Revision `122a2bbca60d0ea4935de77a4ac1ea10e1477381`, deployment `dpl_ja1Q9BV3X2mBwYkg3QjZYnZfP7Q3`.

Use the isolated synthetic school `ERP-CUTOFF-QA-45fd9c33` with the separate school administrator, principal, assigned teacher and guardian accounts from the private QA handoff. The fixture has two active pupils in QA A and an empty section. Check the day shown in the monitor against the current IST day.

- [ ] **CUTOFF-01 · Review the unconfigured state.** Open the admin dashboard and Attendance. Check that the school has no cutoff configured and the populated section has two unmarked pupils. The empty section should be excluded.
- [ ] **CUTOFF-02 · Configure and reload.** In Attendance, set a cutoff later than the current IST time and save with a reason. Refresh and verify the saved time and counts. As the principal, view the monitor and verify the setting is read-only. Try a stale revision through the API and check it cannot overwrite a newer setting.
- [ ] **CUTOFF-03 · Save part of a register.** As the assigned teacher, save only one pupil’s mark for today. Refresh the admin monitor. The section should show one marked and one unmarked. The saved mark should remain the same.
- [ ] **CUTOFF-04 · Check Pending after cutoff.** As school admin, set a cutoff earlier than the current IST time with a reason. Refresh the dashboard. The incomplete section should show Pending with one unmarked pupil. Verify that the other pupil still has no attendance record and that the settings change generated no guardian absence alert.
- [ ] **CUTOFF-05 · Complete the register.** Save the remaining pupil’s mark from the assigned teacher register. Refresh the monitor. The section should be Complete with two marked and zero unmarked. Both marks should survive a full reload.
- [ ] **CUTOFF-06 · Check access and disabling.** Try monitor and settings calls as a guardian, teacher and another school’s administrator. Check they cannot read this school’s progress or change its cutoff. Disable the cutoff with an administrator reason and verify the change after refresh.

Protected Preview Chromium QA passed for the isolated school with admin at 1440 and 390 px and principal at 390 px. The server returned 5 November 2026 IST. With cutoff unset, QA A showed two unmarked pupils and QA Empty was excluded. The admin saved 23:59 with a reason, then the admin saved the first pupil Present and the monitor showed Partial, 1 of 2 marked. A stale initial settings revision was rejected. Setting cutoff to 00:00 showed Pending on both dashboards. That settings change preserved the saved attendance row and generated no guardian alert. The admin saved the second pupil Holiday after cutoff, producing Complete, 2 of 2 marked after refresh. Principal views agreed and offered no settings control. Teacher, guardian and another school’s administrator could not read or modify this school’s monitor/settings.

All 479 automated tests passed with `npm test -- --maxWorkers=4 --testTimeout=20000`. Lint, TypeScript and the final Preview build passed. The suite covers no-op and stale setting saves, invalid placements, inactive or missing sessions, scope restrictions, the IST date boundary and timed monitor refresh.

A scoped shareable link for this Preview was verified in fresh Chromium. The private QA handoff has the link and demo accounts. The monitor currently covers daily attendance in the active session. School calendar exclusions and period attendance require their remaining PRD flows.

The admin also disabled the cutoff on mobile and verified it after refresh. Re-saving the empty value was a no-op at revision 3. The audit contained exactly the three changes, and saved attendance rows retained their original IDs and statuses.
