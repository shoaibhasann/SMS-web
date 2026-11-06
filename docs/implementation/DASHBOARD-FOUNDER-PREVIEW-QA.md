# SMS dashboard — Founder Preview QA

6 November 2026 · Preview Ready · Deployed engineering smoke passed · Founder acceptance pending

Ye release **clean dashboard UI + self-hosted Sora font + existing QA data** ke liye hai. Naye timetable, reviewed result publication, student-leave aur baaki **9 pending SQL migrations wale flows is release mein nahi hain**. Unke local checklists ko is Preview par Pass mat mark karna.

| Release / tester | Details |
|---|---|
| Preview login URL | [Open dashboard Preview](https://kids-corner-erp-frontend-c8ex0atk2-shoaibhasanns-projects.vercel.app/login) |
| Deployment ID / source revision | `dpl_J3fREXZNV1oDz5VpFWAmzi1cxWAC` · base `74771f7` + isolated Sora dashboard files |
| Founder, test date/time (IST) | |
| Laptop / phone browser | |
| Overall result | Pending — Pass / Fail / Blocked |

Existing private handoff wale **Admin, Teacher, Student aur Guardian logins** use karo. Password ya Vercel share token Git, screenshots aur bug report mein mat daalna. Har role alag browser profile/private session mein test karo. Agar Vercel login aaye, supplied private access link pehle kholo.

## Data reference — 6 November 2026 IST

Ye seeded test data hai. **Today / This month / Next 7 days** actual school date se calculate hote hain; later dates par inki values badal sakti hain. Difference aaye toh pehle same date, school, account aur child check karo. Force-match karne ke liye records edit mat karna.

| Role / scope | Expected baseline |
|---|---|
| QA school | 42 students · 3 classes · 7 sections · 1,260 retained attendance records · 6 academic logs |
| Admin | 42 total students · 11 total teachers · 8 absent today · ₹850 net collection this month; today’s saved attendance: 42 |
| Teacher | My Classes: 6 assigned class/section entries · Academic Logs: 6 · Homework Given: 6 · Upcoming Tests: 1 |
| Student / Guardian’s linked child | 30 retained attendance records · 63% attendance · 3 class logs · 7 activities · 1 fee record |

Teacher ka **My Classes 6** school ke **3 distinct classes** se different measure hai. Student/Guardian totals sirf apne/linked child ke hain, school total nahi. Guardian fixture mein abhi **ek linked child** hai; multi-child switching ko is fixture se Pass claim nahi karna.

## Founder checklist

- [ ] **FP-01 · Login aur roles.** Preview par chaaron accounts se login karo. Sahi role, uppercase SMS name aur actual data aaye. Logout karke `/dashboard` dobara kholo: sign-in maange aur previous account ka content na dikhe.
- [ ] **FP-02 · Admin.** Baseline counts aur Finance values compare karo. Attendance ring ka absent/other-status breakdown usi saved total se match kare. Refresh aur browser reload ke baad data wapas aaye. Students, Attendance aur existing academic/finance shortcuts apni sahi pages kholen.
- [ ] **FP-03 · Teacher.** Upar ke chaar metrics compare karo. Recent logs aur attendance chart ke visible numbers/labels check karo. Open attendance, academic logs aur homework links kaam karein. Browser reload ke baad wahi saved numbers aur records aaye. Sirf apni allowed classes ka kaam dikhe.
- [ ] **FP-04 · Student.** Apna name, admission, class/section, attendance, learning aur fees check karo. Baseline se compare karke reload karo. Kisi doosre pupil ka name, fee ya attendance na aaye. Full attendance/history aur existing homework/receipt pages open hon.
- [ ] **FP-05 · Guardian.** Linked child ka name aur wahi child-specific values check karo. Dropdown mein already selected child ko dobara select karo, phir reload: data bana rahe, permanent “Checking selected child” na aaye. Notifications kholo; All/Unread, unread count aur ek alert ko Mark as read karke refresh check karo. Read state persist ho; unrelated guardian ke alerts na dikhein. Agar unread alert nahi hai toh write case **Blocked / no unread fixture** likho.
- [ ] **FP-06 · Laptop + phone.** Laptop 1440 px aur phone/narrow window 390 px par chaaron dashboards dekho. System Light/Dark preference aur dashboard theme control test karo. Headings, sidebar, buttons, fields aur chart labels par same Sora font ho. ₹ amounts aur long names readable hon; sideways page scroll, clipped text ya overlapping cards na hon.
- [ ] **FP-07 · Navigation + keyboard.** Mobile menu open/close karo. Find a page mein allowed page search karke Enter se kholo. Tab se selectors/actions use karo: visible focus aur usable touch targets hon. Browser Back aur reload ke baad sahi role/child scope rahe.
- [ ] **FP-08 · Honest charts / states.** Chart numbers visible legend se match hon. Recent-log chart ko complete school trend mat samjho: woh loaded sample hai. Empty card par fabricated bars/growth na ho; failed attendance/fee load ko zero ya success na dikhaye. Error aaye toh screenshot aur retry result record karo.

Har checkbox founder ke actual test ke baad hi tick karo. Ye UI Preview pending security/database phases ya real-school onboarding approval nahi hai.

## Bug report

| Case / role / device | Kya kiya | Expected → actual | Screenshot / page URL / time |
|---|---|---|---|
| | | | |

## Engineering release check — 6 November 2026

Exact dashboard-only release: **52/52 focused tests**, TypeScript, scoped ESLint and optimized Next.js build pass. The baseline is `74771f7` plus nine isolated UI/font source/assets; module routes, database helpers, packages and hosted schema remain the deployed baseline. This was a direct Preview deployment, not a Git push or production promotion.

Fresh browser verification passes all four real email/password logins, exact authorized demo counts, hard reload, same-child selection, safe shortcut navigation, 1440 px light / 390 px dark and 1366 × 768 / 390 × 844 login fit. **215 actual school reads, zero school writes, mocks, failed reads or runtime errors**; all four Auth sessions were signed out locally. Sora assets load from the deployment (16 observed font responses: all 200), with no Google font requests; visible text/controls use the same family. Metric contrast is at least 5.84:1 light / 6.76:1 dark. The downloadable checklist returns 200 with Markdown content.

The private share link expires **13 November 2026, 3:48 PM IST**; open it before the canonical URL. A current one-child fixture does not prove hosted sibling switching. These engineering checks do not tick founder cases or clear pending SQL/security/onboarding gates.
