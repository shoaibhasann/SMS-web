# SMS — Production founder QA

**Latest milestone:** [Real audit history, avatar/account settings and refreshed demo UI](AUDIT-ACCOUNT-QA.md). Run that focused checklist as well as the base regression below.

6 November 2026 · `main` + stable Vercel Production · Engineering verification passed; founder acceptance pending

Ye **verified Production frontend + complete 12-migration chain (requested nine + two hosted fixes + school audit history)** ki checklist hai. Neeche wala stable URL use karo. Har checkbox apne actual test ke baad tick karna; engineering QA ka Pass founder acceptance mein copy mat karna.

| Release / tester | Record |
|---|---|
| Stable Production login URL | [SMS Production](https://kids-corner-erp-frontend.vercel.app/login) |
| Earlier verified runtime branch / code | `main` · `2dfb1e26eb1af64ef6d1bacbcc741a3e53e85b84` |
| Earlier verified runtime Production deployment | `dpl_Hn7b55aj4ThnjDC1tykBJAGxHP1J` · Ready; later documentation-only releases preserve the same runtime |
| Hosted migration rollout verification | 12 applied; [exact source/history hashes](../../supabase/recovery/hosted-rollout-2026-11-06.json) |
| Founder, date/time (IST), browser/device | |
| School / academic year / QA pupil | |
| Overall result | Pending — Pass / Fail / Blocked |

Existing private handoff wale Admin, Teacher, Student aur Guardian logins use karo; review ke liye requester/mark-enterer se **alag Admin/Principal** chahiye. Passwords, invite/confirmation links aur deployment share secrets Git, screenshots ya bug report mein mat daalna. Sirf synthetic QA records use karo. Pehle attendance aur fee baseline note karo; fixture missing ho toh case **Blocked** likho.

## Founder checks

- [ ] **PR-01 · Login and Sora.** Laptop aur 390 px phone par login kholo. Uppercase SMS, left illustration ki S-shaped boundary aur right form clean fit hon; short screen/zoom par controls reachable hon. Sora login, dashboards aur modules mein consistent dikhe. System light/dark aur dashboard theme preference check karo.
- [ ] **PR-02 · Loading.** Slow network par dashboard, academic, attendance, fees, roster, notices, invitations, leave, timetable aur result pages kholo. Unknown role ke time neutral skeleton aaye—privileged sidebar/actions ka flash nahi. Data loading mein shapes dikhein; fake `0`, empty-success, sample names ya invented charts nahi. Error/denial clear message par settle ho. Implementation covers 42 workspaces; apne tested pages record karo.
- [ ] **PR-03 · Role boundaries.** Chaaron logins reload karke sahi role/data verify karo. Student/Guardian se `/modules/guardian-invitations` direct kholo: office content/actions deny hon. Logout ke baad `/dashboard` sign-in par bheje aur previous-user data na rahe. Supplied inactive/role-revoked fixture bhi deny ho; apne sole Admin ka access mat hatao.
- [ ] **PR-04 · Timetable save and read.** Admin/Principal → Timetable → intended school/session/class/section → eligible teacher/subject ka period save karo. Weekday, number, time aur room reload ke baad same hon. Teacher ko apna aur Student/Guardian ko own/linked child ka section plus whole-class schedule dikhe.
- [ ] **PR-05 · Timing conflicts.** Teacher ko 08:00–09:00 assign karke same weekday/session mein other class par 08:30–09:30 try karo: reject. Same class/section aur whole-class overlap bhi reject hon. Adjacent 09:00–10:00 may save if otherwise free. Period remove karke office/teacher/family reload: removed row na dikhe. [Detailed timetable cases](TIMETABLE-QA.md).
- [ ] **PR-06 · Leave.** Guardian/Student current academic year ke unused dates par leave submit kare; reload par one Pending review record rahe. Overlap reject ho. Separate Admin/Principal reason ke saath approve/reject kare; family reload par same decision dikhe. **Attendance aur fees unchanged** rahein. Self-review/unrelated-child access deny hon. [Detailed leave cases](STUDENT-LEAVE-QA.md).
- [ ] **PR-07 · Result request.** Teacher own assigned completed assessment ka full current roster mark kare. Explicit `0` valid ho; missing “Unmarked” pupil publication block kare. Published results ka full preview read karke request bhejo. Reload par one private Pending review snapshot rahe; family ko abhi result na dikhe.
- [ ] **PR-08 · Independent publication.** Separate Admin/Principal reason ke saath publish kare; requester/mark-enterer self-review deny ho. Changed source ka stale snapshot publish deny kare aur draft safe rahe. Student/Guardian reload par sirf own pupil’s published score, remarks aur original class/session dekhein—peer marks/rank/private review notes nahi. Print mein bhi wahi pupil ho. [Detailed result cases](RESULT-PUBLICATION-QA.md).
- [ ] **PR-09 · Guardian regression.** Current child dobara select karke reload: data rahe, endless loading nahi. Notifications mein one alert read karke refresh: count/read state persist ho. Attendance history aur own receipts correct rahein. Sibling/revocation acceptance ke liye second valid disposable link chahiye; one-child fixture se Pass mat claim karo.
- [ ] **PR-10 · Everyday UX.** 1440 px light aur 390 px dark mein each role check karo: no sideways overflow, readable labels, 44 px actions, stable selectors aur visible keyboard focus. Search, mobile menu, Back aur reload work karein. Failed requests success/empty list na dikhayein; unconfirmed unchanged retry duplicate record na banaye.

Term report cards/ranks, stored result PDFs, publication withdrawal, automatic leave-to-attendance conversion aur external delivery is slice mein included nahi hain. Native concurrent/database-security acceptance engineering separately verify karegi; founder clicks uska replacement nahi. [SMS brand](../product/SMS-BRAND.md).

| Case / role / device | Steps | Expected → actual | Screenshot / page URL / IST time |
|---|---|---|---|
| | | | |

## Engineering verification — 6 November 2026

Requested nine migrations and two hosted-QA fixes are applied. The extra patches make deterministic stale marks return HTTP409/PT409 in83ms (previously125seconds/504, with no score overwrite), and bound Teacher publication candidates to the current profile (same payload, HTTP545ms; SQL4049→359ms). Every recorded hosted SQL hash matches its reviewed source. No original application rows were removed or edited apart from new governed columns; concurrent manual demo additions were preserved.

Actual hosted proof: parallel timetable requests admit one winner, reject teacher/class/period conflicts (including a different valid teacher); overlapping Guardian/Student leave requests admit one winner; repeated publication requests return one snapshot. Thirty-four valid cross-role mutation requests are denied, plus guarded read/stale/conflict cases. Browser QA passes save→review→hard reload for all three workflows, own/linked published result printing, reviewed revision2 latest-only and temporary-link revocation while the original child stays available. All original attendance1260/fee-demand3/payment1 row hashes remain unchanged for the QA school. All QA Auth sessions are signed out locally.

Loading/role UX checks pass ten login viewport/theme cases, five delayed-real-read loading cases and ten Student/Guardian direct-route cases: no privileged content before verified authority, no office API requests from denied routes, no fake loading values. Local Sora and the continuous S-wave fit desktop/phone light/dark layouts. Founder boxes above remain unchecked.

Final pre-push validation: **1,478/1,478 tests across124files**, whole-project ESLint and TypeScript pass. Optimized isolated Next.js build passes with194runtime/sourcefiles hash-matched; later SQL-only patches and their database/recovery tests pass separately. Real hosted role/privacy matrix57checks and native concurrency +UIflow proofs above pass. No external inbox/OTP delivery or physical-device acceptance is claimed.

## Stable Production readback — 6 November, 17:06 IST

The Git-triggered `main` runtime deployment above is Ready and serves the stable alias. Fresh browser email/password logins for Admin, Teacher, Student and Guardian pass timetable/leave/publication navigation and hard reload against real Supabase. Student and Guardian each see only their own latest published revision 2 at 76%; six direct requests for the revoked temporary child return `42501`. Saved approved/rejected leave decisions remain visible, and removed QA timetable rows stay absent. Original attendance/fee/payment history fingerprints remain exact (1,260/3/1 rows).

The deployed Admin dashboard reads actual current counts (43 pupils, 13 teachers, 42 attendance records today, eight absent, ₹850 month collections). Delayed real authority/profile reads show neutral or shaped skeletons before verified data, with no privileged sidebar/actions or fabricated KPIs. Self-hosted Sora loads in 22 successful same-origin font responses with zero Google font requests. A 390 px dark layout has no horizontal overflow. The founder Markdown download returns anonymous HTTP 200 as real Markdown without Vercel Authentication.

This deployed run made **142 school reads, zero school writes and zero browser runtime errors**. All four QA Auth sessions were closed locally; other sessions were not signed out. Eleven private screenshots and JSON evidence remain outside Git. Subsequent handoff edits only change documentation and ledger timestamp labels; they do not change the verified runtime or SQL source bytes. Full native Auth/Storage/provider recovery, real delivery and founder/commercial acceptance remain open.
