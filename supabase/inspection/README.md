# Manual metadata export

1. Open the SMS Supabase project (`bjecfuixgqgyohttrdfr`).
2. Open **SQL Editor → New query**.
3. Paste the entire `export-schema-metadata.sql` file and run it.
4. Export/download the complete result as JSON. One row and one `schema_export` column are expected. A JSON export wrapping the column in an array is also fine.
5. Save the downloaded file in this project or provide its local path for inspection. Avoid copying only the visible/truncated cell preview.

The query only reads PostgreSQL catalogs. It does not read student, parent, payment, auth-user or storage-object rows, or change schema, policies, functions, grants or data. No API token, service-role key or database password is required by the SQL itself.

The snapshot includes non-managed application schemas, columns, indexes, constraints, enums/domains, routine definitions, custom triggers, RLS policies, privileges, sequence configuration and extension inventory. It is inspection evidence, not a complete/restorable backup. Managed schemas, bucket/provider configuration, row data, custom standalone composite/range types and several ownership/dependency details are outside its reconstruction scope. Routine bodies/default expressions may contain any literals previously embedded by the application's authors; review sensitive literals locally before sharing an export.

If SQL Editor refuses execution, send the exact error. Changing roles, disabling RLS or granting public access is not needed to repair a metadata-query error.

Validation: the query executed successfully in an isolated PGlite PostgreSQL fixture inside a READ ONLY transaction. It exported enum/domain/sequence/index/view metadata, default sequence privileges, overloaded functions, a private function attached to an auth trigger, and storage RLS policies. Sample student/auth row values were absent; catalog and row counts were unchanged. This verifies the query against the fixture, not execution or access permissions on the remote Supabase project.
