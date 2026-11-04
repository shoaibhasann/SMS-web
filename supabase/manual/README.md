# Run the first role-permission fix manually

This patch closes two routes: ordinary users writing their own administrative roles, and a school admin granting roles in another school through `assign_school_role`. **It does not fix the other global staff, teacher-assignment, activation, finance or storage policies.** Existing role rows are not deleted, rewritten or automatically reviewed for earlier unauthorized grants.

1. Open the existing **Kids Corner School ERP** project (`bjecfuixgqgyohttrdfr`) in Supabase → **SQL Editor → New query**.
2. Open [the role-permission migration](../migrations/20261102163032_harden_school_role_assignment.sql), paste the **entire file**, including `BEGIN` and `COMMIT`, and run it once as the trusted database/table owner. No API key, service-role secret or database password needs to be sent to chat.
3. If any statement fails, do not run selected fragments or add grants to get past it. Run `ROLLBACK;` if the editor session remains in a failed transaction, then provide the exact error. The patch rejects unexpected table/policy/trigger shapes or unsafe definer ownership.
4. Run the entire [SELECT-only verification](verify-role-permissions.sql) in a new query. Every `passes` value should be `true`. Share those check names/results; they contain no role-membership or pupil rows.

The replacement preserves the public RPC signature. School admins can grant ordinary roles only within their school; only an existing super admin can grant super-admin authority. A NULL school is accepted only for a global super-admin grant by an existing super admin. Repeated identical grants do not add rows, including new NULL-school grants. Existing duplicate rows are retained.

Direct role-table writes from `anon` and `authenticated` are revoked; authenticated clients can read their own roles, school admins can read roles in their school, and super admins retain global visibility. Privileged owner/service table access remains intact. The trusted `service_role` also keeps schema/execute access through the replacement RPC; its authentication, school and promotion checks still apply when the RPC is used. Applications that directly write `user_roles` must use the authorized RPC instead. Run during a quiet period: a brief table lock is required, and the transaction times out rather than waiting indefinitely.

Verification checks the metadata configuration, not every runtime authorization scenario. Local regression tests use synthetic accounts and the recovered role definitions; they do not establish a live two-school security pass. The next steps remain a reviewed least-privilege policy migration for the other domains and an explicit audit of existing grants, without automatically trusting or removing any real member's role.

After this patch's 15 checks pass, the separate [staff school-scope instructions](staff-school-scope.md) cover the next bounded migration and its 20-check verification query. Apply the migrations in that order.
