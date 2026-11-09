# Student and Guardian Notifications — founder QA

9 November 2026 · [SMS Production login](https://sms-web-shoaibhasann.vercel.app/login) · Founder acceptance pending

Use the existing privately supplied Student, Guardian and Admin/Principal QA accounts. Test synthetic records only. Do not include credentials, tokens, private review reasons or other children's details in screenshots. Engineering test results do not tick these founder boxes. Record the deployed revision before testing.

**Engineering fixture:** after the native-push backend QA, existing private QA Guardian has 7 items / 5 unread; Student has 4 items / 1 unread. The extra approved leave is 11 November. New result `SMS-NOTIFICATIONS-V2-QA-20261106 · published practice` shows 18/20 for the linked demo child. New leaves: 9 November approved, 10 November rejected. Counts change as you test. All three original Guardian absence items remain unread.

**What to expect:** new published results, approved/rejected child leave decisions, eligible school announcements and newly assigned homework appear in Notifications. Existing Guardian absence alerts retain their saved read state. Announcements and homework do not backfill old records or send SMS, email or push in this release.

## New events and exact records

- [ ] **FN-01 · Published result.** Ask the office QA reviewer to publish a fresh prepared result. Student and every eligible linked Guardian get one own notification. Refresh: it remains once. Pending or rejected publication requests produce no result alert. Open it: the correct child and assessment appear, without another child's marks.
- [ ] **FN-02 · Latest revision.** Publish a revised result for that assessment. Only the latest eligible result notification is shown, and opening it shows the latest published pupil revision. A valid zero mark displays as zero. Reject a later publication request: the prior published result remains available.
- [ ] **FN-03 · Approved and rejected leave.** Submit two distinct synthetic child leave requests and ask the office to approve one and reject the other. Both Student and linked Guardians receive the corresponding one-time decision. Pending requests do not alert. Open each item: the correct child, dates, request and final status appear. Attendance and fees remain unchanged.
- [ ] **FN-04 · Older exact links.** With the prepared history fixture, open a result/leave notification whose target is older than the first 50 module history rows. It opens that exact assessment/request for that child. An invalid/unavailable target shows unavailable/access-changed state; it must not silently open a different record. Mark Blocked if the older-target fixture was not supplied.
- [ ] **FN-05 · Existing absence history.** Guardian Notifications still includes the prepared absence alerts with the same child/date and existing Read/Unread status. Open one: that child's attendance history appears. This release does not add Student absence notifications or rewrite old result/leave decisions into alerts.

## Inbox, counts and read state

- [ ] **FN-06 · All/Unread and paging.** Open All, then Unread. Unread contains only unread items from the full eligible history, not just the currently loaded rows. Older notifications replaces the page; Latest notifications and Refresh return to the newest page. Switch filters after paging: start at that filter's newest page. No duplicate/missing references or another child's records appear.
- [ ] **FN-07 · One read and header bell.** Record the total unread count, mark one item as read, then refresh/reopen. Its Read state persists and the inbox/header bell show the saved new total. No badge appears for zero unread; high totals may display `99+` visually while the accessible label keeps the full count. Desktop and phone both have a working bell link.
- [ ] **FN-08 · Mark all beyond one page.** On the prepared disposable account with more unread rows than fit on a page, use Mark all as read once. The full own eligible unread total becomes zero, including older pages. Unread becomes empty and stays empty after reload. The operation must not loop over only the visible rows. Mark Blocked if this fixture was not supplied.
- [ ] **FN-09 · Independent recipients.** Mark one/all as Guardian A. Guardian B and the Student retain their own unread state after refresh. A different child's independently linked Guardian is unchanged. A mixed-role account's Guardian view keeps `view=guardian` through the bell and target links; its Student view has separate permitted state.
- [ ] **FN-10 · Failure and foreground refresh.** Slow/offline reads show a skeleton or clear retryable error, with no fake empty/success state. A failed mark does not claim an unsaved new count. Restore connectivity and Refresh to reconcile. Return from another tab/window: the visible inbox/bell refetch current saved state. Repeated clicks while saving do not send duplicate actions.

## Access, history and layout

- [ ] **FN-11 · Revoke one child.** Ask the office to revoke a disposable Guardian-child link. Refresh or return to the tab: that child's events disappear, and its direct target/mark requests are denied. An independently linked sibling and other Guardians still work. Old attendance, fees and school decisions remain retained. Re-inviting a Guardian must not fabricate past result/leave alerts.
- [ ] **FN-12 · Other-account denial.** Use unrelated Student/Guardian and another school's QA accounts to open a copied target URL. No foreign child, marks, leave reason or notification state is exposed. Teacher/Finance alone do not gain family access. Invalid child/assessment/request references do not fall back to somebody else's data.
- [ ] **FN-13 · Sign out/account switch.** Start a delayed read or mark, then sign out or switch to another account. Old rows, personal details and badge clear; a late response must not restore them. Role-removed, disabled, unverified or invalid-session accounts cannot continue reading/marking by using a stale page.
- [ ] **FN-14 · Phone and keyboard.** At 390 px and laptop widths, check Light/Dark, long titles/child names, summary → View all, All/Unread, buttons, target links and bell. No horizontal page overflow or overlapping controls. Tab focus remains visible. Older/Latest moves focus to the notification heading; marking retains useful focus without a page jump.
- [ ] **FN-15 · Shared QA baseline.** Use the prepared disposable read-state fixtures where requested. If engineering tests used shared QA accounts, confirm their original notification Read/Unread timestamps were restored and independently checked afterward. Do not clear all shared history or delete source records to reset this checklist. Record any deliberate founder changes separately.

## School announcements

- [ ] **FN-16 · Publish to a class or section.** With a QA Admin or Principal, save a dummy notice as Draft. The family inbox stays empty for that notice. Publish it to the assigned QA section. Its Student and linked Guardians see one **Announcement** each in Notifications. A Guardian with two matching children sees it once. Check a different section, role, and school for isolation.
- [ ] **FN-17 · Open and mark.** Open the announcement link and check it shows the exact notice. Mark it read in Notifications, switch to Unread, and refresh. Confirm the same account's badge updates and a different Guardian's read state is independent. Repeat with **Mark all as read** while older announcements are available.
- [ ] **FN-18 · Change availability.** Schedule a future notice and confirm it appears only at publication. Unpublish a QA notice or revoke its only qualifying Guardian link. After refresh, its inbox entry and exact notice link become unavailable.

## Homework assigned

- [ ] **FN-19 · Draft, publish and retry.** As an assigned QA Teacher, save homework as Draft. Confirm it does not appear in either family inbox. Publish it, then edit its instructions and due date. Student and linked Guardians see one **Homework** item per assignment; the edit does not create a duplicate or reset its read state. A Guardian with two eligible siblings receives the item once.
- [ ] **FN-20 · Open and read.** Open that exact item from Student and Guardian Notifications. Check the title, instructions and due date. Student can use the existing submission panel when eligible; Guardian cannot submit or see submission files. Mark the Guardian item read, refresh, and check that the Student and another Guardian keep their own unread status. Verify the bell count and All/Unread filter.
- [ ] **FN-21 · Scope and stale links.** Copy the exact homework link to a QA account from a different section or school. The target is unavailable. After unpublishing the assignment or revoking a Guardian's only qualifying link, refresh the inbox and the copied link; both must stop showing it. Restore the link only if the fixture was created for that purpose.

| Release / tester | Entry |
|---|---|
| Stable URL | https://sms-web-shoaibhasann.vercel.app/login |
| Earlier result/leave release | `dbf12d6` |
| Announcement release revision | |
| Homework release revision | |
| Tester, IST date/time, browser/device | |
| Overall result | Pending |

| Case / role | Expected → actual | Screenshot / page / IST time | Pass / Fail / Blocked |
|---|---|---|---|
| | | | |
