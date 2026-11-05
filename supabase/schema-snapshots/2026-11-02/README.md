# Recovered schema metadata

User-exported snapshot captured at **2026-11-02 21:35:15 IST**. This is the existing project export supplied in chat, not a successful MCP/live connection check.

- `schema-metadata.json`: validated and normalized export used for review.
- `raw-export.json`: exact bytes of the latest attachment, including its one-row `schema_export` wrapper.
- `provenance.json`: source hashes, counts, format and inspection limits.
- `SECURITY-REVIEW.md`: analysis of authorization definitions in this snapshot.

Both supplied attachments contain the same metadata after unwrapping. The latest input is preserved; no source values were edited in normalization.

## Inventory

| Object | Count |
|---|---:|
| Application schemas (`public`, `app_private`) | 2 |
| Tables | 69 |
| Views | 3 |
| Enum types | 10 |
| RLS policies | 178 |
| Functions | 34 |
| Custom triggers | 24 |
| Installed extensions | 5 |

All 69 tables have RLS enabled, and the three views declare `security_invoker=true`. These flags do not establish correct authorization: permissive policies, grants and helper functions must be reviewed together.

## Attendance contract check

The current repository's queried columns, six statuses, nullable remarks, `marked_by` relationship and unique `(student_id, attendance_date)` key match the export. The registration RPC takes `p_full_name text`. No attendance row-version column or attendance trigger exists in this snapshot.

This is structural compatibility only. Identity setup assumptions and authorization gaps remain; see the security review. Multiple current academic years or multiple teacher rows per profile are not prevented by the supplied constraints. Registration independently selects the current context, so callers must reconcile its returned class/section.

## Inspection limits

This file set is metadata, not a full/restorable backup. It does not contain school/pupil/payment rows, auth accounts, storage objects, provider secrets or a verified migration history. The expected project reference comes from the task context and is recorded in provenance; the export itself does not independently verify that reference. No database migration, remote query or data change was performed when adding these files.

Common secret-key/token/password-URL patterns were not found during ingestion. That automated scan is not a guarantee that every literal in a function/default is non-sensitive.
