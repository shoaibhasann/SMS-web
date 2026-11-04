# Kids Corner ERP

Next.js / React / TypeScript frontend backed by Supabase Auth and PostgreSQL. Workflows are implemented and verified in slices against the founder-approved product scope.

See the [implementation phases](docs/implementation/PHASES.md) and the [manual Vercel QA checklist](docs/implementation/POST-DEPLOY-QA.md).

The [product requirements](docs/product/PRD.md) capture the current product scope and release gates. See the [founder answers](docs/product/FOUNDER-ANSWERS.md) and the original [founder worksheet](docs/product/FOUNDER-PRD-INPUT.html).

## Local setup

Use Node 22.13+ in the 22.x line, Node 24, or Node 26+. The tested environment is Node 22.22.2. Run commands from this inner application folder.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` to the intended test project. These are browser-visible configuration; never put a Supabase secret/service-role key in a `NEXT_PUBLIC_*` variable. Keep `.env.local` untracked.

The repository contains incremental SQL migrations and a metadata snapshot under `supabase/schema-snapshots/2026-11-02/`. Use the [implementation phases](docs/implementation/PHASES.md) for the demo project's migration and QA status, and the [manual SQL instructions](supabase/manual/README.md) for the patch procedures.

## Checks

```sh
npm test
npm run test:db
npm run typecheck
npm run lint
npm run build
```

`npm run test:watch` runs Vitest in watch mode. `npm test` includes local database tests, and `test:db` runs only those. The latest local checkpoint has 405 passing tests, plus passing lint, TypeScript and production build checks. The automated tests use local fixtures and mocked provider boundaries.

Browser QA used the local frontend with hosted demo Supabase and four seeded accounts. Teacher and admin save/reload and student and parent attendance readback passed. The attendance Preview is deployed and ready for manual testing. Its URL and revision are in the [post-deploy QA checklist](docs/implementation/POST-DEPLOY-QA.md).

## Attendance flow

Teacher dashboard and teacher attendance route use one `AttendanceEditor` and repository. It loads the selected school/year/class/section/day, preserves saved statuses including holidays, and represents missing rows as Unmarked. Bulk Present applies only to unmarked students. Date/class changes and registration are locked while edits or writes are pending.

Only changed students are written. Existing rows use conditional updates against the loaded record ID, revision, status and remarks; conflicts are reported instead of overwritten. New rows use INSERT, relying on the existing unique `(student_id, attendance_date)` constraint. At most four pupil writes run at once, with explicit partial success and retained failed edits. Reload after a conflict or interrupted connection.

The current IST day saves per pupil. PostgreSQL checks active enrollment and prevents direct historical writes. Teachers request changes for past dates in the current register, and an authorized admin or principal reviews with a reason. Approved changes retain the previous and applied values.

Admin attendance uses the same editor for its selected school and section. Student and parent Attendance pages show scoped history with read-only access, and the parent can switch linked children. First-time account activation is a separate workflow from the seeded QA logins.

## Implementation layout

- `components/academic/attendance-editor.tsx`: shared attendance state and UI.
- `components/academic/teacher-attendance-register.tsx`: teacher/current-year context and existing registration integration.
- `lib/attendance/`: typed statuses, school dates and Supabase adapter.
- `lib/auth/redirect.ts` and `app/(auth)/auth/callback/route.ts`: safe internal callback routing.
- `tests/`: auth, adapter, editor behavior and register-parent wiring tests.

Remaining localStorage admin modules are demonstrations, not an authoritative school database. Do not import real pupil/fee data into them.
