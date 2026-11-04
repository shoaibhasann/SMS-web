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

1. Open the guardian Preview and sign in to Vercel. Use the QA school and synthetic pupil for this run. For the guardian, use an inbox you control that has never signed up in this ERP. Supabase's default mailer can send to existing project-team addresses. Use an inbox supported by the project's custom SMTP if configured. [Supabase email delivery](https://supabase.com/docs/guides/auth/auth-smtp)
2. In Supabase Auth **URL Configuration**, confirm the redirect allowlist covers `https://kids-corner-erp-frontend-iidtbxhn9-shoaibhasanns-projects.vercel.app/auth/callback?next=%2Fguardian-invite`. [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
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
