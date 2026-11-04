# Apply the staff school-scope patch

Status: locally tested and independently reviewed, ready for manual application; this document does not report remote execution. All 178 local tests pass, including 23 cases for this patch; its 20 catalog checks and the first patch's 15 checks pass in the local fixture. The user confirms that this Supabase project contains test/demo data and that the first role-assignment patch returned all 15 catalog checks true remotely.

## Before applying

Use the same test project's SQL Editor with its trusted database-owner context. Re-run `supabase/manual/verify-role-permissions.sql`; all 15 checks must still pass. Keep `20261102163032_harden_school_role_assignment.sql` in place. This second patch depends on its role-table restrictions and exposed RPC contract.

Review `supabase/migrations/20261102164657_staff_school_scope.sql` and `docs/implementation/STAFF-SCHOOL-SCOPE.md`. The migration replaces 21 global office/finance grants and one enrollment-policy back edge that causes PostgreSQL `42P17` recursion: 22 policies on 17 tables. It preserves the existing office-role set inside the matching school, accountant reference reads and trusted global-super-admin behavior. The touched teacher-notice branch requires ownership and a teacher role in that same school.

Five private SECURITY DEFINER helpers resolve the canonical school and check role/school together. Helper execution is restricted to authenticated/trusted service callers. The 17 table ACLs remove PUBLIC/anonymous access and authenticated TRUNCATE, REFERENCES, TRIGGER and MAINTAIN, while retaining authenticated DML and trusted service access. Schema, permissions and policy-name preflight checks reject unexpected input; the 79-name allowlist does not compare every unchanged policy's expression.

## Apply and verify

1. Run the **complete** `20261102164657_staff_school_scope.sql`, including its transaction and postconditions. Do not run isolated sections to work around an error.
2. If it fails, keep the exact error and stop. Run `ROLLBACK;` if the editor session remains in a failed transaction. A failed transaction does not establish that this patch was applied. Review schema/grant/policy drift before retrying.
3. After a successful commit, run the complete `supabase/manual/verify-staff-school-scope.sql`. It returns **20 rows**, each with a `check_name` and boolean `passes`. Every value must be `true`.
4. Share only the boolean results or error when recording the checkpoint. This SELECT-only query reads catalog metadata; it selects no pupil, role-membership or other application rows.

The verifier checks policy shapes and exact normalized predicates, helper source fingerprints/security/owners/ACLs, the 79-name allowlist, and effective inherited/column/table privileges. Helper source fingerprints ignore whitespace. A false result means the expected patch contract is not established; it does not identify a safe SQL workaround.

## What remains open

- These catalog checks do not impersonate live users or prove deployed Supabase/Auth behavior. Local runtime tests use PGlite PostgreSQL 18.6; the supplied server snapshot is PostgreSQL 17.11.
- Existing tenant ALL policies on academic years/classes/sections still grant school members broad access. Teacher self-assignment, other teacher-owned branches and family/audience wildcard reads remain separate repairs. The patch adds no blanket restrictive fence around them.
- Office permissions within a school remain broad, including accountant/reception writes inherited from the old office policy set. This patch narrows school reach; a least-privilege business-role redesign is pending.
- Enrollment, parent-link, attendance and fee references still need complete cross-record school/year/class coherence. Single-column foreign keys and a row's own school label do not establish that integrity.
- The teacher fee screen has no matching teacher fee/payment SELECT policy in the snapshot. Finance's student lookup lacks an active-school filter, and multi-school selection/stale dashboard requests need frontend work. This patch does not grant broader financial reads to hide those gaps.
- Profile/activation/storage permissions and transactional fee posting remain outside this slice. Review existing role grants for earlier unauthorized authority before admitting real school data.
