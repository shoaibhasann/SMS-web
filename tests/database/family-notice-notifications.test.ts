// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRecoveryDatabase, readRecoveryManifest, readRecoverySources } from "../../scripts/database-recovery/replay.mjs";
import { recoveryIds as id, seedRecoveryData } from "../../scripts/database-recovery/synthetic-seed.mjs";

let db: PGlite;
const migrationPath = "supabase/migrations/20261109142815_family_notice_notifications.sql";
const otherSection = randomUUID();
const otherClass = randomUUID();
type Role = "parent" | "student";
type Cursor = { id: string; kind: string; created_at: string };
type Notification = Cursor & { read_at: string | null };
type Inbox = { notifications: Notification[]; unread_count: number; next_cursor: Cursor | null };

beforeAll(async () => {
  db = await createRecoveryDatabase({ applyPending: false });
  const sources = await readRecoverySources(await readRecoveryManifest());
  for (const source of sources) {
    if (source.path === migrationPath) break;
    if (source.kind === "pending") await db.exec(source.sql);
  }
  await seedRecoveryData(db);
  const migration = new URL(`../../${migrationPath}`, import.meta.url);
  await db.exec(await readFile(migration, "utf8"));
  await db.exec("insert into auth.sessions(id,user_id,aal) select id,id,'aal1' from auth.users");
  await db.query("insert into public.classes(id,school_id,name) values($1,$2,'Other QA class')", [otherClass, id.schoolA]);
  await db.query("insert into public.sections(id,school_id,class_id,name) values($1,$2,$3,'Other QA section')",
    [otherSection, id.schoolA, id.classA]);
}, 60_000);
beforeEach(async () => { await db.exec("begin"); });
afterEach(async () => { await db.exec("rollback"); });
afterAll(async () => { await db?.close(); });

async function asActor<T>(user: string, sql: string, params: unknown[] = [], session = user): Promise<T> {
  await db.exec("savepoint notice_actor");
  try {
    await db.exec("set local role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
      [user, JSON.stringify({ sub: user, session_id: session, aal: "aal1", role: "authenticated" })]);
    const result = await db.query<{ value: T }>(sql, params);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)");
    await db.exec("release savepoint notice_actor");
    return result.rows[0].value;
  } catch (error) {
    await db.exec("rollback to savepoint notice_actor; release savepoint notice_actor");
    throw error;
  }
}

function inbox(user: string, role: Role, options: {
  limit?: number; cursor?: Cursor | null; unreadOnly?: boolean; version?: 3 | 4; session?: string;
} = {}) {
  const { limit = 30, cursor, unreadOnly = false, version = 4, session } = options;
  return asActor<Inbox>(user, `select public.get_family_notification_inbox_v${version}($1,$2,$3,$4,$5,$6) as value`,
    [role, unreadOnly, limit, cursor?.created_at ?? null, cursor?.kind ?? null, cursor?.id ?? null], session);
}

const announcements = (result: Inbox) => result.notifications.filter(({ kind }) => kind === "announcement");
const mark = (user: string, role: Role, notice: string) => asActor<string | null>(user,
  "select public.mark_family_notification_read_v4($1,'announcement',$2)::text as value", [role, notice]);
const detail = (user: string, role: Role, notice: string) => asActor<Record<string, unknown> | null>(user,
  "select public.get_family_announcement($1,$2) as value", [role, notice]);

async function notice(title: string, audience: unknown = { roles: ["student", "parent"] }, options: {
  publishedAt?: string | null; expiresAt?: string; school?: string; publisher?: string;
} = {}) {
  const {
    publishedAt = "2025-01-01T20:15:00Z", expiresAt = null, school = id.schoolA,
    publisher = school === id.schoolA ? id.adminA : id.adminB,
  } = options;
  return asActor<string>(publisher, `insert into public.notices(school_id,title,content,audience,published_at,expires_at,created_by)
    values($1,$2,'Notice content stays in the notice reader',$3::jsonb,$4,$5,$6) returning id as value`,
  [school, title, JSON.stringify(audience), publishedAt, expiresAt, publisher]);
}

async function linkGuardian(user: string, student: string) {
  const parent = randomUUID();
  await db.query("insert into public.user_roles(user_id,school_id,role) values($1,$2,'parent')", [user, id.schoolA]);
  await db.query("insert into public.parents(id,school_id,profile_id) values($1,$2,$3)", [parent, id.schoolA, user]);
  await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [student, parent]);
}

describe("family announcement notifications", () => {
  it("shows newly published notices only during their active window and leaves old notices and v3 unchanged", async () => {
    const earlier = await inbox(id.guardianA, "parent", { version: 3 });
    const published = await notice("Bring notebooks");
    const draft = await notice("Draft", undefined, { publishedAt: null });
    const scheduled = await notice("Scheduled", undefined, { publishedAt: "2099-02-01T03:30:00Z" });
    await notice("Expired", undefined, { expiresAt: "2025-01-03T00:00:00Z" });
    await notice("Foreign school", undefined, { school: id.schoolB });
    await db.query("update public.notices set title='Retained legacy notice edited' where id=$1", [id.noticeA]);

    const family = await inbox(id.guardianA, "parent");
    const [announcement] = announcements(family);
    expect(announcements(family)).toHaveLength(1);
    expect(announcement).toMatchObject({
      id: published, source_id: published, kind: "announcement", title: "Bring notebooks",
      status: "published", student_id: null, student_name: null, read_at: null, event_date: "2025-01-02",
    });
    expect(Date.parse(announcement.created_at)).toBe(Date.parse("2025-01-01T20:15:00Z"));
    expect(announcement).not.toHaveProperty("content");
    expect(await detail(id.guardianA, "parent", published)).toMatchObject({
      id: published, title: "Bring notebooks", content: "Notice content stays in the notice reader",
    });
    expect(family.unread_count).toBe(earlier.unread_count + 1);
    expect(await inbox(id.guardianA, "parent", { version: 3 })).toEqual(earlier);

    await db.query("update public.notices set published_at=statement_timestamp() where id=$1", [draft]);
    expect(announcements(await inbox(id.guardianA, "parent")).map(({ id }) => id)).toEqual([draft, published]);
    await db.query("update public.notices set published_at=null where id=$1", [draft]);
    expect(announcements(await inbox(id.guardianA, "parent")).map(({ id }) => id)).toEqual([published]);
    expect(await mark(id.guardianA, "parent", draft)).toBeNull();
    await db.query("update public.notices set published_at=statement_timestamp()-interval '1 minute' where id=$1", [scheduled]);
    expect(announcements(await inbox(id.guardianA, "parent")).map(({ id }) => id)).toEqual([scheduled, published]);
  });

  it("uses the exact selected family role and current class, section, teacher, school and linked-child scope", async () => {
    await linkGuardian(id.studentUserA, id.unlinkedPupilA);
    await db.query("update public.enrollments set section_id=$1 where student_id=$2", [otherSection, id.unlinkedPupilA]);
    const onlyParent = await notice("Parents", { roles: ["parent"] });
    const onlyStudent = await notice("Students", { roles: ["student"] });
    const classNotice = await notice("Class", { roles: ["parent", "student"], class_id: id.classA });
    const sectionNotice = await notice("Section", { roles: ["parent", "student"], class_id: id.classA, section_id: id.sectionA });
    const otherSectionNotice = await notice("Other section", { roles: ["parent", "student"], class_id: id.classA, section_id: otherSection });
    const teacherNotice = await notice("Teacher's section", { roles: ["parent", "student"], teacher_id: id.teacherRecordA }, { publisher: id.teacherA });
    await notice("Other class", { roles: ["parent", "student"], class_id: otherClass });
    const idsFor = async (user: string, role: Role) => announcements(await inbox(user, role)).map(({ id }) => id).sort();
    expect(await idsFor(id.guardianA, "parent")).toEqual([onlyParent, classNotice, sectionNotice, teacherNotice].sort());
    expect(await idsFor(id.studentUserA, "student")).toEqual([onlyStudent, classNotice, sectionNotice, teacherNotice].sort());
    expect(await idsFor(id.studentUserA, "parent")).toEqual([onlyParent, classNotice, otherSectionNotice].sort());
    expect(await idsFor(id.studentUserB, "student")).toEqual([]);
    expect(await detail(id.studentUserB, "student", sectionNotice)).toBeNull();
    expect(await mark(id.guardianA, "parent", onlyStudent)).toBeNull();
    await expect(inbox(id.teacherA, "parent")).rejects.toMatchObject({ code: "42501" });
    await expect(inbox(id.guardianA, "parent", { session: randomUUID() })).rejects.toMatchObject({ code: "42501" });
    await expect(asActor(id.guardianA, "select count(*) as value from app_private.family_notice_reads"))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asActor(id.guardianA, "select count(*) as value from app_private.eligible_family_notice_sources('parent',null)"))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("deduplicates siblings and keeps read status independent through link revocation", async () => {
    await linkGuardian(id.studentUserA, id.pupilA);
    await db.query("insert into public.student_parents(student_id,parent_id,relationship) values($1,$2,'guardian')", [id.unlinkedPupilA, id.parentA]);
    const sectionNotice = await notice("Section notice", { roles: ["parent", "student"], section_id: id.sectionA });
    expect(announcements(await inbox(id.guardianA, "parent"))).toHaveLength(1);
    const firstRead = await mark(id.guardianA, "parent", sectionNotice);
    expect(firstRead).toEqual(expect.any(String));
    expect(await mark(id.guardianA, "parent", sectionNotice)).toBe(firstRead);
    expect(announcements(await inbox(id.guardianA, "parent", { unreadOnly: true }))).toEqual([]);
    expect(announcements(await inbox(id.studentUserA, "parent", { unreadOnly: true }))).toMatchObject([{ id: sectionNotice, read_at: null }]);
    expect(announcements(await inbox(id.studentUserA, "student", { unreadOnly: true }))).toMatchObject([{ id: sectionNotice, read_at: null }]);

    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.pupilA]);
    expect(announcements(await inbox(id.guardianA, "parent"))).toMatchObject([{ id: sectionNotice, read_at: expect.any(String) }]);
    await db.query("delete from public.student_parents where parent_id=$1 and student_id=$2", [id.parentA, id.unlinkedPupilA]);
    expect(announcements(await inbox(id.guardianA, "parent"))).toEqual([]);
    expect(await detail(id.guardianA, "parent", sectionNotice)).toBeNull();
    expect(await mark(id.guardianA, "parent", sectionNotice)).toBeNull();
    expect(announcements(await inbox(id.studentUserA, "parent"))).toMatchObject([{ id: sectionNotice, read_at: null }]);
    expect(announcements(await inbox(id.studentUserA, "student"))).toMatchObject([{ id: sectionNotice, read_at: null }]);
  });

  it("paginates announcement timestamp ties and marks every eligible page for just the current recipient", async () => {
    const ids = [await notice("Page one"), await notice("Page two"), await notice("Page three")];
    const first = await inbox(id.studentUserA, "student", { limit: 2, unreadOnly: true });
    const second = await inbox(id.studentUserA, "student", { limit: 2, cursor: first.next_cursor, unreadOnly: true });
    expect(first.next_cursor?.kind).toBe("announcement");
    expect(second.next_cursor).toBeNull();
    expect([...first.notifications, ...second.notifications].map(({ id }) => id).sort()).toEqual(ids.sort());
    expect(first.unread_count).toBe(3);
    expect(await asActor(id.studentUserA, "select public.get_family_notification_unread_count_v4('student')::int as value")).toBe(3);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v4('student')::int as value")).toBe(3);
    expect(await asActor(id.studentUserA, "select public.mark_all_family_notifications_read_v4('student')::int as value")).toBe(0);
    expect((await inbox(id.studentUserA, "student", { unreadOnly: true })).notifications).toEqual([]);
    expect(announcements(await inbox(id.guardianA, "parent", { unreadOnly: true }))).toHaveLength(3);
  });
});
