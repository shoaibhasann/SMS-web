import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadGuardianDirectory } from "../lib/guardian-invitations/directory";

const owner = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/staff-mfa", () => ({ boundMfaSession: owner }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1), schoolId = id(2), foreignSchool = id(3);
const parent = (n: number) => ({ id: id(10 + n), school_id: schoolId, profile_id: id(20 + n), guardian_code: `G-${n}`, registered_mobile: n ? null : "+919876543210" });
const profile = (n: number) => ({ id: id(20 + n), school_id: schoolId, full_name: `Guardian ${n}`, is_active: n !== 1 });
const pupil = (n: number) => ({ id: id(30 + n), school_id: schoolId, first_name: `Child ${n}`, middle_name: null, last_name: "QA", admission_no: `ADM-${n}`, status: n ? "withdrawn" : "active" });
const link = (n: number) => ({ parent_id: id(10 + n), student_id: id(30 + n), relationship: "Guardian", is_primary: n === 0 });
type Read = { table: string; columns: string; filters: Record<string, unknown>; from: number; to: number; token?: string; signal?: AbortSignal };
type Reply = { data: unknown[] | null; error: { message: string } | null; count?: number | null };

function database(options: { cap?: number; change?: (reply: Reply, request: Read) => Reply; tables?: Record<string, unknown[]> } = {}) {
  const tables: Record<string, unknown[]> = { user_roles: [{ role: "school_admin", school_id: schoolId, user_id: userId }], schools: [{ id: schoolId, is_active: true }],
    ...(options.tables ?? { parents: [parent(0), parent(1)], profiles: [profile(0), profile(1)], students: [pupil(0), pupil(1)], student_parents: [link(0), link(1)] }) };
  const calls: Read[] = [];
  const client = { from(table: string) {
    const request: Read = { table, columns: "", filters: {}, from: 0, to: 199 };
    const query = {
      select(columns: string) { request.columns = columns; return query; },
      eq(key: string, value: unknown) { request.filters[key] = value; return query; },
      in(key: string, value: unknown) { request.filters[key] = value; return query; },
      order() { return query; },
      range(from: number, to: number) { request.from = from; request.to = to; return query; },
      setHeader(key: string, value: string) { expect(key).toBe("Authorization"); request.token = value; return query; },
      abortSignal(value: AbortSignal) { request.signal = value; return query; },
      then<T = Reply, U = never>(yes?: ((reply: Reply) => T | PromiseLike<T>) | null, no?: ((reason: unknown) => U | PromiseLike<U>) | null) {
        calls.push(request);
        const rows = (tables[table] ?? []).filter(raw => Object.entries(request.filters).every(([key, expected]) => {
          const value = (raw as Record<string, unknown>)[key]; return Array.isArray(expected) ? expected.includes(value) : value === expected;
        }));
        const reply: Reply = { data: rows.slice(request.from, Math.min(request.to + 1, request.from + (options.cap ?? 200))), count: rows.length, error: null };
        return Promise.resolve(options.change ? options.change(reply, request) : reply).then(yes, no);
      },
    };
    return query;
  } };
  return { client: client as unknown as SupabaseClient, calls };
}

beforeEach(() => { owner.mockReset(); owner.mockResolvedValue({ user: { id: userId }, access_token: "owned-qa-token" }); });

describe("school guardian directory reads", () => {
  it("reads every lower-cap page with the captured owner's token and maps retained children without profile contact claims", async () => {
    const db = database({ cap: 1 });
    const signal = new AbortController().signal;
    const rows = await loadGuardianDirectory(db.client, userId, schoolId, signal);
    expect(rows).toEqual([
      { id: id(10), name: "Guardian 0", code: "G-0", mobile: "+919876543210", account: "active", children: [{ id: id(30), name: "Child 0 QA", admissionNumber: "ADM-0", status: "active", relationship: "Guardian", primary: true }] },
      { id: id(11), name: "Guardian 1", code: "G-1", mobile: null, account: "inactive", children: [{ id: id(31), name: "Child 1 QA", admissionNumber: "ADM-1", status: "withdrawn", relationship: "Guardian", primary: false }] },
    ]);
    expect(owner).toHaveBeenCalledWith(db.client, userId, signal);
    expect(db.calls.every(call => call.token === "Bearer owned-qa-token" && call.signal === signal)).toBe(true);
    expect(db.calls.filter(call => ["parents", "profiles", "students"].includes(call.table)).every(call => call.filters.school_id === schoolId)).toBe(true);
    expect(db.calls.filter(call => call.table === "user_roles")).toHaveLength(2);
    expect(db.calls.filter(call => call.table === "user_roles").every(call => call.filters.user_id === userId)).toBe(true);
    expect(db.calls.filter(call => call.table === "parents").map(call => call.from)).toEqual([0, 1]);
    expect(db.calls.filter(call => call.table === "profiles").every(call => !call.columns.includes("phone") && !call.columns.includes("email"))).toBe(true);
  });

  it("keeps a guardian without a linked login visible without inventing a name or contact", async () => {
    const db = database({ tables: { parents: [{ ...parent(0), profile_id: null, guardian_code: null, registered_mobile: null }] } });
    expect(await loadGuardianDirectory(db.client, userId, schoolId, new AbortController().signal)).toEqual([
      { id: id(10), name: null, code: null, mobile: null, account: "unlinked", children: [] },
    ]);
    expect(db.calls.some(call => call.table === "profiles" || call.table === "students")).toBe(false);
  });

  it.each([
    { name: "foreign parent", change: (reply: Reply, request: Read) => request.table === "parents" ? { ...reply, data: [{ ...parent(0), school_id: foreignSchool }], count: 1 } : reply },
    { name: "duplicate parent", change: (reply: Reply, request: Read) => request.table === "parents" ? { ...reply, data: [parent(0), parent(0)], count: 2 } : reply },
    { name: "duplicate child pair", change: (reply: Reply, request: Read) => request.table === "student_parents" ? { ...reply, data: [link(0), link(0)], count: 2 } : reply },
    { name: "incomplete child", change: (reply: Reply, request: Read) => request.table === "students" ? { ...reply, data: [], count: 0 } : reply },
    { name: "missing profile", change: (reply: Reply, request: Read) => request.table === "profiles" ? { ...reply, data: [], count: 0 } : reply },
    { name: "foreign child", change: (reply: Reply, request: Read) => request.table === "students" ? { ...reply, data: [{ ...pupil(0), school_id: foreignSchool }], count: 1 } : reply },
    { name: "missing count", change: (reply: Reply) => ({ ...reply, count: null }) },
    { name: "inconsistent count", change: (reply: Reply) => ({ ...reply, count: 0 }) },
  ])("fails closed for $name", async ({ change }) => {
    const db = database({ change });
    await expect(loadGuardianDirectory(db.client, userId, schoolId, new AbortController().signal)).rejects.toThrow(/could not be verified completely/);
  });

  it("does not query a directory after a missing or changed owner", async () => {
    const db = database(); owner.mockResolvedValue(null);
    await expect(loadGuardianDirectory(db.client, userId, schoolId, new AbortController().signal)).rejects.toThrow("Sign in again");
    expect(db.calls).toHaveLength(0);
    owner.mockRejectedValueOnce(new Error("Your account changed"));
    await expect(loadGuardianDirectory(db.client, userId, schoolId, new AbortController().signal)).rejects.toThrow("Your account changed");
    expect(db.calls).toHaveLength(0);
  });

  it("aborts before following a late previous-account page into profile or child reads", async () => {
    const controller = new AbortController();
    const db = database({ change: (reply, request) => { if (request.table === "parents") controller.abort(); return reply; } });
    await expect(loadGuardianDirectory(db.client, userId, schoolId, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(db.calls.map(call => call.table)).toEqual(["user_roles", "schools", "parents"]);
  });

  it.each(["teacher", "parent", "accountant", "reception"])("does not represent a %s account's permitted subset as an office directory", async role => {
    const db = database({ tables: { user_roles: [{ role, school_id: schoolId, user_id: userId }] } });
    await expect(loadGuardianDirectory(db.client, userId, schoolId, new AbortController().signal)).rejects.toThrow("current School Admin or Principal");
    expect(db.calls.map(call => call.table)).toEqual(["user_roles"]);
  });

  it("rejects a same-owner role loss before returning already-read private rows", async () => {
    let checks = 0;
    const db = database({ change: (reply, request) => request.table === "user_roles" && ++checks > 1
      ? { ...reply, data: [{ role: "parent", school_id: schoolId }], count: 1 } : reply });
    await expect(loadGuardianDirectory(db.client, userId, schoolId, new AbortController().signal)).rejects.toThrow("current School Admin or Principal");
    expect(db.calls.some(call => call.table === "students")).toBe(true);
  });

  it("rejects a global administrator's unavailable or inactive school", async () => {
    const db = database({ tables: { user_roles: [{ role: "super_admin", school_id: null, user_id: userId }], schools: [{ id: schoolId, is_active: false }] } });
    await expect(loadGuardianDirectory(db.client, userId, schoolId, new AbortController().signal)).rejects.toThrow("active school");
    expect(db.calls.some(call => call.table === "parents")).toBe(false);
  });
});
