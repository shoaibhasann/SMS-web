# SMS interface direction

6 November 2026 · Dashboard refinement · Existing SMS brand retained

The dashboard uses a compact SaaS workspace: a 240 px desktop sidebar, restrained header, a clear page title and role-specific actions, focused KPI cards and a responsive bento layout. The supplied blue dashboard references guide hierarchy and density; their brands, financial claims, avatars and sample charts are not copied.

## Identity and tokens

- **Wordmark:** SMS, uppercase, bold, no graduation-cap emblem.
- **Accent:** existing cobalt `#3867ff` in light mode and `#6d8cff` in dark mode. Use it for primary actions, selected navigation and a focused data highlight. Avoid a large decorative purple gradient across the dashboard.
- **Surfaces:** white cards over the existing soft gray-blue background; dark navy surfaces for system dark mode. Keep subtle borders and quiet shadows instead of many nested tinted boxes.
- **Typography:** self-hosted **Sora** across headings, navigation, body text, charts and controls; the same family is mapped to Tailwind’s sans utility. Use 400 body, 500 labels and 600–700 emphasis; 800 is reserved for the SMS wordmark. The variable font and its OFL notice ship with the app. Clear 26–30 px page titles, 13–14 px body/navigation and 12 px secondary labels. Use tabular numerals for comparable measures and currency; keep long student/class names readable.
- **Spacing:** 16–24 px between dashboard regions, consistent 16–24 px card corners, content-sized empty states. Use a desktop primary/secondary column arrangement and stack at phone widths.
- **Meaning:** green indicates positive/completed status, amber pending/review and red an error/absence where appropriate. Labels and values carry meaning alongside color.

## Data and interactions

All cards and charts use actual authorized query results. A sample or limited recent-history chart says what it represents. No invented growth percentages, random chart shapes, hidden error-to-zero conversion, unread badges or paid-plan claims are added for appearance. Demo fixtures belong in the explicitly scoped QA school rather than a production UI fallback.

Admin emphasizes attendance, people, fees and next actions. Teacher emphasizes assigned classes, attendance and learning activity. Student emphasizes its own learning, attendance and fees. Parent keeps a visible linked-child selector, the chosen child's summary and notifications. Existing role, assignment, school and child access checks remain authoritative.

Preserve loading, unavailable, empty and error states; errors should explain recovery. Search, child selection, refresh, dialogs and navigation must perform a real action. Keep system theme preference and the existing login experience. Links retain role/guardian scope and keyboard focus; touch targets stay at least 44 px.

## Review

Check all four dashboards at 1440 px and 390 px in light and dark modes, plus tablet sizing. Verify current Supabase QA data and readback, visible keyboard focus, text contrast, no horizontal page overflow and no sign-in/child data mixing. New SQL-backed features remain unavailable on the old database until their matching migration rollout; a dashboard redesign does not certify those pending permissions.

Skill references used: UI UX Pro Max Brand color/typography guidance and the verified Bento Box Grid / Data-Dense Dashboard style results. Existing CSS variables are the token source; no generated token file overwrites them.

Font source: [Google Fonts Sora](https://github.com/google/fonts/tree/main/ofl/sora). Local font: `app/fonts/Sora-Variable.ttf`; license: `public/fonts/Sora-OFL.txt`. Browser rendering uses a locally served font asset; no Google font request is needed at runtime.
