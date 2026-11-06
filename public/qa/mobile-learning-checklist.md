# SMS mobile Learning — founder checklist

6 November 2026 · Android development build · Acceptance pending

Use the supplied private Guardian/Student demo accounts in the separate native app. Teacher grading and Principal leave review happen at https://kids-corner-erp-frontend.vercel.app. Never paste passwords/tokens in this file. QA task marker: `SMS-MOBILE-PHASE2-QA-20261106-7a203afc`. The current QA homework is already graded8/10 and10November leave approved; use a NEW isolated task/date for a repeat write, preserving existing evidence.

Mobile206 automated tests and web1997 tests pass, with hosted SDK workflow evidence; those do not tick native touch/visual/founder cases. The debug app needs Metro; this URL is a checklist, not an installable release. Real FCM/paid sends remain OFF.

## Founder checks — do not tick from engineering tests

Use existing private QA credentials; never paste passwords, session tokens, FIDs, installation proofs or sender keys into this document.

- [ ] M-01: Sign in as Guardian. Only currently linked children appear. Student login exposes only its own profile; a Teacher-only account is denied.
- [ ] M-02: Switch siblings and attendance pages, refresh and reopen the app. Child names and saved records remain scoped correctly; unmarked days are not fabricated as absent.
- [ ] M-03: Check all six attendance labels, empty/error/loading states, older/previous pages and refresh after link revocation. No attendance edit control exists.
- [ ] M-04: Notifications All/Unread and unread count agree after refresh. Mark one and mark all persist for this user/role only. Confirm the same account's web inbox agrees.
- [ ] M-05: Open an absent update for another linked sibling: attendance selects that child. Revoked/unavailable children fail closed. Result/leave updates open the exact native result/decision for that child. An older result alert shows the latest published revision; unavailable/revoked targets fail closed.
- [ ] M-06: Sign out/switch account or role during a slow read, write or open confirmation. Previous rows disappear; an old dialog cannot write using the next account's token.
- [ ] M-07: Background/foreground, offline/reconnect and expired sessions do not display stale records as current. Sign-out failures show a retry message; device cleanup failures block another enrollment.
- [ ] M-08: Light/Dark follow system settings. Check small/large phone, landscape, keyboard, long names, largest font, TalkBack and reduced motion. Tap targets remain usable and bottom controls respect safe areas.
- [ ] M-09: Enable on this phone requests Android permission explicitly. Denial never reports a successful registration. Granted permission creates only this own account/role installation. Account master preference enable is separately confirmed; it never claims phone delivery.
- [ ] M-10: Revoke from the web while queued, disconnect, logout, account/role switch, fresh session and reinstall/reset. The previous identity cannot silently reactivate or transfer to another owner. Other phones/children/read states remain intact.
- [ ] M-11: After approved server configuration, create a fresh eligible event. Record job, provider acceptance, real phone display, tap→authenticated inbox and permitted source record separately. Duplicate/expired/revoked jobs must not leak private data.
- [ ] M-12: Test foreground/background/terminated app, disabled OS permission, FID rotation and notification tap before login. Arbitrary payload URLs must not navigate or execute. Previously accepted neutral OS alerts cannot be recalled retroactively.

## Founder Learning checks

Teacher grading and Principal leave review happen on the existing web workspace; staff accounts cannot use this family-only app.

- [ ] M-13: Learning → select the right child. Only current-session published homework for the exact active class/section appears. Drafts, another sibling’s class and another school stay hidden; page/refresh keeps the correct context.
- [ ] M-14: As Student, open a QA task, enter a response and attach an original PDF/JPG/PNG up to 10 MB. Invalid/empty/oversized or renamed executable content fails. Save, reload and reopen: text/file name persist without public file URLs.
- [ ] M-15: On the web, the assigned Teacher grades that response. Reload/reopen the Student app: marks/feedback agree and reviewed work is locked. Guardian sees only the selected linked child’s response/feedback with no edit/upload controls. Another teacher cannot grade it.
- [ ] M-16: Lose the save response, restart/reopen and retry the locked request. The same request ID/payload returns the original submission; it cannot silently become another child/account’s work. Unreadable pending storage blocks a new write.
- [ ] M-17: Published results show only school-reviewed latest revisions and the original class/session. Refresh, change child, paginate and open a result update. Draft/unpublished, foreign-child and revoked-link requests fail; no class rank, raw roster or private review metadata appears.
- [ ] M-18: Submit valid leave dates/reason. Reopen/refresh: one Pending row exists. Exact retry creates no second request. Invalid dates, reverse ranges and pending/approved overlaps fail. Use a school-approved valid session date for QA.
- [ ] M-19: A different authorized Principal/Admin reviews leave on the web. Refresh/open the decision update in the app: saved status/reason match. Approved leave never edits attendance automatically; other linked children and historical attendance/fees remain unchanged.
- [ ] M-20: During slow upload/save, switch account, background or sign out. Old callbacks cannot borrow the new token; reopening the original account recovers only its own unconfirmed intent. A write already accepted by the server may finish; do not assume sign-out cancels it.
- [ ] M-21: Check five-tab labels, form keyboard, file picker Cancel, loading/empty/error/offline states, long text, system Dark/Light, large font and TalkBack on real Android. No hidden staff controls or clipped submission button.
- [ ] M-22: Original attachment downloads/past-session homework remain on the authenticated web workspace for this slice. Unreferenced private uploads may need a retention sweep after persistent cleanup/network failure; they must never become publicly readable.




## Open release gates

Physical Android/TalkBack/large-font acceptance, real FCM display, signing/distribution and iOS remain pending. Original downloads and past-session homework remain on the web in this slice. Previously authorized raw private-file URLs may still hit the provider CDN with the old JWT until expiry; strict noncached file delivery and private orphan-upload retention must be addressed before real-school rollout. See the [provider behavior](https://supabase.com/kb/troubleshooting/storage-private-bucket-files-still-accessible-after-remove-access-or-logout). An already-accepted server write can finish after sign-out; it cannot transfer to another account.
