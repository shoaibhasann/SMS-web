# Historical school calendar import — founder checklist

Use https://sms-web-shoaibhasann.vercel.app/login with privately supplied synthetic QA accounts. Open **Settings → School attendance calendar → Import historical days**. Only the school's actual Admin/Principal can import, after authenticator verification. School settings outside the calendar keep their existing permissions.

Founder acceptance is independent of engineering QA. Leave each box unchecked until you run it.

## Prepare a CSV

The exact header is `date,status,label`. Use real ISO dates, `working` or `holiday`, and a short required label. Choose a supported academic year from the same school. Every date must be inside that year, strictly before today in India, and currently unconfigured. Maximum 366 rows / 64 KB. The year bounds the file; imported decisions apply schoolwide on those dates.

```csv
date,status,label
2026-10-15,working,Approved historical working day
2026-10-16,holiday,Approved historical school holiday
```

These are format examples, not instructions to overwrite dates already imported. Use new, approved gap dates in your QA school.

## Run the flow

- [ ] HC-01: Admin opens the importer; Principal can also open/import in their own school. Teacher, Student and Guardian cannot import or fetch this school's preview through direct RPC calls. A foreign-school Admin/Principal is denied.
- [ ] HC-02: Without a verified authenticator session, import is unavailable and Account security is offered. After verification, choose the intended year and file.
- [ ] HC-03: CSV preview shows each original date, working/holiday choice, label and row error. Duplicate dates, invalid dates, wrong columns/status, blank/overlong labels and oversized files block preview/import. Spreadsheet output is accepted: DD-MM-YYYY dates are shown converted to YYYY-MM-DD, `Holiday`/`WORKING` are read case-insensitively, and fully blank `,,` rows are ignored.
- [ ] HC-04: Server preview rejects today/future, outside-year and already configured dates. One bad row blocks the entire batch. An already imported date also blocks, even if the requested decision matches it.
- [ ] HC-05: Per-date saved attendance counts and statuses are correct. On a holiday with retained marks, the warning explains that the marks remain but the date is excluded from the official percentage. A working day with legacy pupil Holiday needs review; it does not become Present automatically.
- [ ] HC-06: Confirm is disabled until you enter a 5–300 character reason and explicitly acknowledge the reporting impact. Check school/year/rows again before confirming.
- [ ] HC-07: Confirm succeeds once; hard refresh retains the import batch, row counts, actor name (another user's import shows their name, never a raw ID; "Imported by you" for your own; "Unknown user" if the profile is gone), reason and time. The month grid shows the imported date label. Existing weekday/date policies remain unchanged.
- [ ] HC-08: Re-uploading those dates is blocked. Retrying an uncertain save uses the same frozen request and returns the existing receipt; it does not create a second batch. If another calendar/attendance change invalidates the preview, refresh the preview before a new save.
- [ ] HC-09: Student and linked Guardian refresh Attendance and Dashboard. Complete calendar/marks can now produce the approved official rate. Missing marks or contradictory records still withhold the percentage. Other-child/foreign-school access remains denied.
- [ ] HC-10: Compare the raw attendance history before/after: dates, statuses, remarks, authors and timestamps remain unchanged. Child links, fees, inbox items and read states remain unchanged. Calendar import sends no new notification.
- [ ] HC-11: Check phone width, keyboard navigation, file selection, readable row errors, loading/error/retry and dark/light appearance. You can discard an unsaved draft; school and normal calendar editors stay locked while a draft or uncertain save is active.
- [ ] HC-12: Log out every QA account. Confirm that old sessions cannot keep previewing/importing. Verify live school policy with the founder before using real school history.

## Scope

This import fills explicit past calendar gaps. It cannot overwrite a prior calendar decision, edit old pupil marks, invent weekdays, or set a Teacher correction window. The current approved formula stays Present/Late = 1, Half Day = 0.5, Leave/Absent = 0; school closed days are excluded. Historical-year family reports, class/school aggregate reports and formula editing are separate work. SMS, email, FCM and physical devices are not activated by this feature.
