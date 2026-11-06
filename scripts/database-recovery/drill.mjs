import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { captureCatalog, catalogFingerprint } from "./catalog.mjs";
import { recoveryExtensions } from "./replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "./synthetic-seed.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const schemas = ["public", "app_private", "auth", "storage"];
const snapshotFormat = "sms-synthetic-pglite-snapshot-v1";
const maximumSnapshotBytes = 128 * 1024 * 1024;
const installedVersion = async () => JSON.parse(await readFile(new URL("../../node_modules/@electric-sql/pglite/package.json", import.meta.url), "utf8")).version;

export function validateDrillArguments(args) {
  if (!Array.isArray(args) || args.length) {
    throw new Error("The recovery drill accepts no arguments or database targets; it only creates fresh embedded databases.");
  }
}

function requireEmbeddedDatabase(db) {
  if (!(db instanceof PGlite)) throw new Error("Recovery checks require a local PGlite instance; external database clients are not accepted.");
}

export async function fingerprintRecoveryDatabase(db) {
  requireEmbeddedDatabase(db);
  const tables = (await db.query(`select n.nspname as schema,c.relname as name
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname=any($1) and c.relkind in ('r','p') order by n.nspname,c.relname`, [schemas])).rows;
  const rows = {};
  for (const table of tables) {
    const values = (await db.query(`select pg_catalog.to_jsonb(item)::text as value
      from ${ident(table.schema)}.${ident(table.name)} item order by pg_catalog.to_jsonb(item)::text`)).rows;
    rows[`${table.schema}.${table.name}`] = { count: values.length, sha256: sha256(JSON.stringify(values.map((row) => row.value))) };
  }
  const catalog = catalogFingerprint(await captureCatalog(db));
  const apiRoles = (await db.query(`select rolname,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolconfig
    from pg_catalog.pg_roles where rolname in ('anon','authenticated','service_role','authenticator') order by rolname`)).rows;
  return { schemaSha256: catalog.sha256, apiRolesSha256: sha256(JSON.stringify(apiRoles)),
    dataSha256: sha256(JSON.stringify(rows)), tables: rows };
}

export async function createSyntheticSnapshot(db) {
  requireEmbeddedDatabase(db);
  const engineVersion = (await db.query("show server_version")).rows[0].server_version;
  const blob = await db.dumpDataDir("gzip");
  return { format: snapshotFormat, pgliteVersion: await installedVersion(), engineVersion,
    sha256: sha256(Buffer.from(await blob.arrayBuffer())), blob };
}

export async function restoreSyntheticSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== snapshotFormat || !(snapshot.blob instanceof Blob)
    || !snapshot.blob.size || snapshot.blob.size > maximumSnapshotBytes
    || typeof snapshot.engineVersion !== "string" || typeof snapshot.pgliteVersion !== "string"
    || !/^[0-9a-f]{64}$/.test(snapshot.sha256)) {
    throw new Error("Invalid synthetic recovery snapshot; no database was opened.");
  }
  const digest = sha256(Buffer.from(await snapshot.blob.arrayBuffer()));
  if (digest !== snapshot.sha256) throw new Error("Recovery snapshot checksum mismatch; no database was opened.");
  if (snapshot.pgliteVersion !== await installedVersion()) throw new Error("Synthetic snapshots require the exact PGlite package version.");
  const db = await PGlite.create({ extensions: recoveryExtensions, loadDataDir: snapshot.blob });
  try {
    const version = (await db.query("show server_version")).rows[0].server_version;
    if (version !== snapshot.engineVersion) throw new Error("Synthetic snapshots require the exact embedded PostgreSQL version.");
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

async function asActor(db, userId, callback, beforeRole) {
  await db.exec("begin");
  try {
    // Sessions are disposable local verification fixtures and roll back with every probe.
    await db.exec("insert into auth.sessions(id,user_id) select id,id from auth.users on conflict(id) do nothing");
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub:userId,session_id:userId })]);
    if (beforeRole) await beforeRole(db);
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    return await callback(db);
  } finally {
    // Verification writes must never alter the snapshot's business records.
    await db.exec("rollback");
  }
}

async function rejectsCode(operation, codes) {
  let caught;
  try { await operation(); } catch (error) { caught = error; }
  assert.ok(caught && codes.includes(caught.code), `Expected SQL denial ${codes.join("/")}; got ${caught?.code ?? "success"}.`);
}

export async function verifyRecoveredState(db) {
  requireEmbeddedDatabase(db);
  const before = await fingerprintRecoveryDatabase(db);
  const checks = [];
  for (const [actor, visible, hidden] of [[id.adminA, id.pupilA, id.pupilB], [id.adminB, id.pupilB, id.pupilA]]) {
    await asActor(db, actor, async (tx) => {
      assert.equal((await tx.query("select id from public.students where id=$1", [visible])).rows.length, 1);
      assert.equal((await tx.query("select id from public.students where id=$1", [hidden])).rows.length, 0);
    });
  }
  checks.push("two_school_admin_isolation");

  const auditSession = "74000000-0000-0000-0000-000000000190";
  await asActor(db, id.adminA, async (tx) => {
    const page = (await tx.query("select public.list_school_audit_events($1,'2026-11-05','2026-11-05','guardians') as value", [id.schoolA])).rows[0].value;
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].action, "Guardian email changed");
    assert.equal(page.events[0].actor_name, "Synthetic admin-a");
    assert.equal(page.next_cursor, null);
    assert.equal(JSON.stringify(page).includes("PRIVATE_RESTORE_AUDIT_REASON"), false);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.guardianA, JSON.stringify({ sub:id.guardianA,session_id:id.guardianA })]);
    await assert.rejects(() => tx.query("select public.list_school_audit_events($1,'2026-11-05','2026-11-05')", [id.schoolA]),
      (error) => error.code === "42501");
  }, async (tx) => {
    await tx.query("insert into auth.sessions(id,user_id) values($1,$2)", [auditSession,id.adminA]);
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub:id.adminA,session_id:auditSession })]);
    await tx.query(`insert into app_private.guardian_contact_audit(id,school_id,parent_id,actor_id,action,occurred_at)
      values('74000000-0000-0000-0000-000000000191',$1,$2,$3,'email_changed','2026-11-05T10:00:00Z'),
        ('74000000-0000-0000-0000-000000000192',$4,$2,$3,'mobile_verified','2026-11-05T10:00:00Z')`,
      [id.schoolA,id.parentA,id.adminA,id.schoolB]);
    await tx.query("insert into public.audit_logs(school_id,action,old_data) values($1,'PRIVATE_RESTORE_AUDIT_REASON','{}')", [id.schoolA]);
  });
  checks.push("curated_school_audit_scope_privacy_and_live_session");

  for (const actor of [id.studentUserA, id.guardianA]) {
    await asActor(db, actor, async (tx) => {
      assert.deepEqual((await tx.query("select student_id,status from public.attendance order by student_id")).rows,
        [{ student_id: id.pupilA, status: "absent" }]);
      assert.deepEqual((await tx.query("select student_id,receipt_no,amount from public.fee_payments order by student_id")).rows,
        [{ student_id: id.pupilA, receipt_no: "RECOVERY-RECEIPT-A", amount: "250.00" }]);
      const ledger = (await tx.query("select public.get_family_fee_ledger($1) as value", [id.pupilA])).rows[0].value;
      assert.equal(ledger.rows.length, 1);
      assert.equal(ledger.rows[0].invalid, false);
      assert.equal(Number(ledger.rows[0].paid_amount), 250);
      assert.equal(Number(ledger.rows[0].balance), 750);
    });
    await rejectsCode(() => asActor(db, actor, (tx) => tx.query("select public.get_family_fee_ledger($1)", [id.unlinkedPupilA])), ["42501"]);
    await rejectsCode(() => asActor(db, actor, (tx) => tx.query("update public.fee_payments set amount=1 where id=$1", [id.paymentA])), ["42501"]);
  }
  checks.push("student_and_linked_guardian_history", "family_ledger_and_receipt_integrity", "denied_unlinked_child_and_finance_writes");

  await asActor(db, id.guardianA, async (tx) => {
    const inbox = (await tx.query("select public.get_guardian_absence_inbox() as value")).rows[0].value;
    assert.equal(Number(inbox.unread_count), 1);
    assert.equal(inbox.alerts.length, 1);
    assert.equal(inbox.alerts[0].student_id, id.pupilA);
  });
  checks.push("linked_absence_alert_eligibility");

  await asActor(db, id.guardianA, async (tx) => {
    const args = [id.pupilA, "2026-11-10", "2026-11-11", "Synthetic recovery leave", "74000000-0000-0000-0000-000000000150"];
    const request = (await tx.query("select public.submit_student_leave($1,$2,$3,$4,$5) as id", args)).rows[0].id;
    assert.equal((await tx.query("select public.submit_student_leave($1,$2,$3,$4,$5) as id", args)).rows[0].id, request);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.adminA, JSON.stringify({ sub:id.adminA,session_id:id.adminA })]);
    await tx.query("select public.review_student_leave($1,'approved','Synthetic recovery review')", [request]);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.studentUserA, JSON.stringify({ sub:id.studentUserA,session_id:id.studentUserA })]);
    const history = (await tx.query("select id,status,review_note from public.list_family_student_leave($1)", [id.pupilA])).rows;
    assert.deepEqual(history, [{ id: request, status: "approved", review_note: "Synthetic recovery review" }]);
  });
  await rejectsCode(() => asActor(db, id.guardianA,
    (tx) => tx.query("select * from public.list_family_student_leave($1)", [id.pupilA]),
    (tx) => tx.query("delete from public.student_parents where parent_id=$1", [id.parentA])), ["42501"]);
  checks.push("student_leave_request_review_and_retry", "revoked_guardian_leave_denial");

  await asActor(db, id.adminA, async (tx) => {
    const args = [id.schoolA, id.assignmentA, id.sectionA, "74000000-0000-0000-0000-000000000160"];
    const createSql = "select public.save_timetable_period($1,null,null,$2,$3,1,1,'08:00','09:00','Recovery room',$4) as id";
    const period = (await tx.query(createSql, args)).rows[0].id;
    assert.equal((await tx.query(createSql, args)).rows[0].id, period);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.teacherA, JSON.stringify({ sub:id.teacherA,session_id:id.teacherA })]);
    const teacher = (await tx.query("select public.get_teacher_timetable() as value")).rows[0].value;
    assert.equal(teacher.rows[0].id, period);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.guardianA, JSON.stringify({ sub:id.guardianA,session_id:id.guardianA })]);
    const family = (await tx.query("select public.get_family_timetable($1) as value", [id.pupilA])).rows[0].value;
    assert.equal(family.rows[0].id, period);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.adminA, JSON.stringify({ sub:id.adminA,session_id:id.adminA })]);
    await tx.query("select public.remove_timetable_period($1,$2,$3,$4)", [id.schoolA, period, family.rows[0].version, "74000000-0000-0000-0000-000000000161"]);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.studentUserA, JSON.stringify({ sub:id.studentUserA,session_id:id.studentUserA })]);
    assert.equal((await tx.query("select public.get_family_timetable($1) as value", [id.pupilA])).rows[0].value.rows.length, 0);
  });
  checks.push("timetable_retry_teacher_family_and_removal");

  await asActor(db, id.teacherA, async (tx) => {
    await tx.query("update public.teacher_assessments set status='completed' where id=$1", [id.assessmentA]);
    await tx.query("insert into public.teacher_assessment_marks(assessment_id,student_id,marks_obtained) values($1,$2,81)", [id.assessmentA, id.unlinkedPupilA]);
    const preview = (await tx.query("select public.preview_assessment_publication($1) as value", [id.assessmentA])).rows[0].value;
    assert.equal(preview.can_submit, true);
    const request = (await tx.query("select public.request_assessment_publication($1,$2,$3) as id", [
      id.assessmentA, preview.source_token, "74000000-0000-0000-0000-000000000170",
    ])).rows[0].id;
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.guardianA, JSON.stringify({ sub:id.guardianA,session_id:id.guardianA })]);
    assert.equal((await tx.query("select public.get_family_assessment_results($1) as value", [id.pupilA])).rows[0].value.rows.length, 0);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.adminA, JSON.stringify({ sub:id.adminA,session_id:id.adminA })]);
    await tx.query("select public.review_assessment_publication($1,'published','Reviewed synthetic restore results')", [request]);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.studentUserA, JSON.stringify({ sub:id.studentUserA,session_id:id.studentUserA })]);
    const results = (await tx.query("select public.get_family_assessment_results($1) as value", [id.pupilA])).rows[0].value;
    assert.equal(results.rows.length, 1);
    assert.equal(results.rows[0].marks_obtained, 74);
    assert.equal(results.rows[0].student_id, id.pupilA);
    assert.equal(JSON.stringify(results).includes(id.unlinkedPupilA), false);
  });
  checks.push("independent_result_publication_and_private_family_snapshot");

  const assessment = (await db.query("select id,updated_at::text from public.teacher_assessments where id=$1", [id.assessmentA])).rows[0];
  const mark = (await db.query("select id,updated_at::text,marks_obtained::text,remarks from public.teacher_assessment_marks where id=$1", [id.markA])).rows[0];
  const markSql = "select public.save_assessment_mark($1,$2,$3,$4,$5,$6,$7,$8,$9) as value";
  const args = [id.assessmentA, assessment.updated_at, id.pupilA, mark.id, mark.updated_at, mark.marks_obtained, mark.remarks, 75, "Synthetic restore check"];
  await asActor(db, id.teacherA, async (tx) => {
    const saved = (await tx.query(markSql, args)).rows[0].value;
    assert.equal(saved.student_id, id.pupilA);
    assert.equal(Number(saved.marks_obtained), 75);
    assert.notEqual(saved.updated_at, mark.updated_at);
  });
  await rejectsCode(() => asActor(db, id.teacherA, async (tx) => {
    await tx.query(markSql, args);
    await tx.query(markSql, args);
  }), ["PT409"]);
  await rejectsCode(() => asActor(db, id.teacherA, (tx) => tx.query(markSql, args),
    (tx) => tx.query("delete from public.user_roles where user_id=$1 and role='teacher'", [id.teacherA])), ["PT409", "42501"]);
  checks.push("mark_rpc_and_stale_version_rejection", "revoked_teacher_denial");

  await asActor(db, id.adminA, async (tx) => {
    const original = (await tx.query("select version from public.notices where id=$1", [id.noticeA])).rows[0].version;
    const fresh = (await tx.query("update public.notices set audience=$1,published_at=null where id=$2 and version=$3 returning version", [JSON.stringify({ roles: ["teacher"] }), id.noticeA, original])).rows;
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0].version, original);
    assert.equal((await tx.query("update public.notices set title='Stale restore edit' where id=$1 and version=$2 returning id", [id.noticeA, original])).rows.length, 0);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)", [id.guardianA, JSON.stringify({ sub:id.guardianA,session_id:id.guardianA })]);
    assert.equal((await tx.query("select id from public.notices where id=$1", [id.noticeA])).rows.length, 0);
  });
  checks.push("notice_cas_and_withdrawn_audience_privacy");

  await asActor(db, id.claimantA, async (tx) => {
    const activated = (await tx.query("select public.activate_student('REC-A-002','2014-06-15','0000000000') as id")).rows[0].id;
    assert.equal(activated, id.unlinkedPupilA);
    assert.deepEqual((await tx.query("select student_id,status from public.attendance")).rows,
      [{ student_id: id.unlinkedPupilA, status: "late" }]);
  });
  checks.push("first_student_activation_preserves_existing_history");
  assert.deepEqual(await fingerprintRecoveryDatabase(db), before);
  return checks;
}

export async function runRecoveryDrill(args = []) {
  validateDrillArguments(args);
  const started = performance.now();
  const { createRecoveryDatabase } = await import("./replay.mjs");
  const source = await createRecoveryDatabase({ applyPending: true });
  let restored;
  try {
    requireEmbeddedDatabase(source);
    await seedRecoveryData(source);
    const checksBefore = await verifyRecoveredState(source);
    const before = await fingerprintRecoveryDatabase(source);
    const snapshot = await createSyntheticSnapshot(source);
    restored = await restoreSyntheticSnapshot(snapshot);
    const after = await fingerprintRecoveryDatabase(restored);
    assert.deepEqual(after, before);
    const checksAfter = await verifyRecoveredState(restored);
    assert.deepEqual(checksAfter, checksBefore);
    return {
      passed: true, kind: "application-schema-and-synthetic-embedded-restore", pgliteVersion: snapshot.pgliteVersion, engineVersion: snapshot.engineVersion,
      format: snapshot.format, snapshotSha256: snapshot.sha256, snapshotBytes: snapshot.blob.size,
      schemaSha256: before.schemaSha256, dataSha256: before.dataSha256,
      apiRolesSha256: before.apiRolesSha256,
      tables: before.tables, restoredChecks: checksAfter,
      elapsedMs: Math.round(performance.now() - started),
      limits: { syntheticAuthAndStorageContracts: true, hostedDatabaseAccess: false,
        realAuthLoginTested: false, storageObjectBytesRestored: false, portablePgDumpRestoreTested: false, concurrentConnectionsTested: false },
    };
  } finally {
    await restored?.close();
    await source.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRecoveryDrill(process.argv.slice(2)).then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error) => {
    // Never print arbitrary SQL diagnostics, source rows, or connection strings.
    process.stderr.write(`Offline recovery drill failed${error?.code ? ` (${error.code})` : ""}. ${error instanceof assert.AssertionError ? "A recovery assertion did not pass." : "Check the local checkpoint and drill tests."}\n`);
    process.exitCode = 1;
  });
}
