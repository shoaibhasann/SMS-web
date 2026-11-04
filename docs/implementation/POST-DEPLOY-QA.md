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
