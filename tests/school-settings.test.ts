// @vitest-environment node
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { loadSchoolSettings, parseSchoolSettings, saveSchoolSettings, schoolDetails, validateSchoolDetails, type SchoolDetails, type SchoolSettingsIntent } from "@/lib/admin/school-settings";

const id = (n: number) => `a1000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const owner = id(1), schoolId = id(2);
const details: SchoolDetails = { name: "QA School", board: "CBSE", affiliation_no: null, address: "School Road\nFirozabad", city: "Firozabad", state: "Uttar Pradesh", pincode: "283203", phone: "+91 (5612) 123-456", email: "office@example.test", website: "https://school.example/contact/@office" };
function record() {
  return { school: { ...details, id: schoolId, code: null, timezone: "UTC", revision: 0 }, can_edit: true,
    setup: { school_day: "2026-11-07", current_year: null, current_year_count: 0, active_classes: 0, sections: 0, classes_without_sections: 0,
      active_subjects: 0, teachers: 0, linked_teachers: 0, teaching_assignments: 0, sections_without_class_teacher: 0,
      enrolled_students: 0, invalid_enrollments: 0, linked_students: 0, pending_guardian_invitations: 0, today_attendance: 0 }, history: [] };
}
const intent = (): SchoolSettingsIntent => ({ schoolId, expectedRevision: 0, requestId: id(3), details: structuredClone(details), reason: "School approved contact update." });
function fake() {
  const getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: owner }, access_token: "token-a" } }, error: null });
  const getUser = vi.fn().mockResolvedValue({ data: { user: { id: owner, is_anonymous: false } }, error: null });
  const header = vi.fn(), abort = vi.fn();
  const rpc = vi.fn<(name: string, ...args: unknown[]) => unknown>().mockImplementation((name) => ({ setHeader: header.mockImplementation(() => ({ abortSignal: abort.mockResolvedValue({ data: name === "get_school_settings" ? record() : { revision: 1, changed: true, replayed: false }, error: null }) })) }));
  return { client: { auth: { getSession, getUser }, rpc } as unknown as SupabaseClient, rpc, getSession, getUser, header, abort };
}

describe("school settings boundary", () => {
  it("normalizes only editable fields, preserves multiline addresses and leaves optional fields null", () => {
    const source = { ...details, name: "  QA School ", email: " OFFICE@EXAMPLE.TEST ", phone: " ", code: "cannot-edit", timezone: "cannot-edit", revision: 6 };
    const result = schoolDetails(source);
    expect(result).toEqual({ ...details, email: "office@example.test", phone: null });
    expect(Object.keys(result)).toHaveLength(10);
    expect(validateSchoolDetails(result)).toBeNull();
    expect(validateSchoolDetails({ ...details, address: "Line 1\r\nLine 2", board: "UP_BOARD" })).toBeNull();
    expect(validateSchoolDetails({ ...details, phone: "011-22334455", email: null, website: null })).toBeNull();
  });

  it.each([
    { name: " " }, { name: "a" }, { name: "x".repeat(161) }, { board: "OTHER" }, { pincode: "123" },
    { phone: "123456" }, { phone: "1234567890123456" }, { phone: "1234567 ext9" }, { phone: "+(91) 1234567" }, { email: "invalid" },
    { address: "School\tRoad" }, { city: "Name\nCity" }, { website: "http://school.example" },
    { website: "https://user:password@school.example" }, { website: "https://school.example:99999" }, { website: "https://school.example:0" },
    { website: "https://school.example\\private" }, { website: "https://school.example/a b" },
    { website: "https://विद्यालय.example" }, { website: "https://[::1]/" }, { website: "https://school.example./" },
  ])("rejects unsafe or invalid details before Auth requests (%j)", async (patch) => {
    const f = fake(), bad = { ...details, ...patch } as SchoolDetails;
    expect(validateSchoolDetails(bad)).not.toBeNull();
    await expect(saveSchoolSettings(f.client, owner, { ...intent(), details: bad })).rejects.toMatchObject({ code: "validation" });
    expect(f.getSession).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });

  it("accepts nullable school code and real zero setup counts without inventing progress", () => {
    expect(parseSchoolSettings(record(), schoolId).setup).toMatchObject({ current_year: null, linked_students: 0, today_attendance: 0 });
  });

  it("fails closed on a foreign, malformed or inconsistent snapshot", () => {
    for (const value of [null, {}, { ...record(), school: { ...record().school, id: id(90) } },
      { ...record(), can_edit: "true" }, { ...record(), setup: { ...record().setup, active_classes: -1 } },
      { ...record(), setup: { ...record().setup, teachers: 0, linked_teachers: 1 } },
      { ...record(), setup: { ...record().setup, current_year_count: 1, current_year: null } },
      { ...record(), setup: { ...record().setup, school_day: "2026-02-31" } },
      { ...record(), setup: { ...record().setup, enrolled_students: 1, linked_students: 2 } },
      { ...record(), school: { ...record().school, revision: 2147483648 } },
      { ...record(), history: [{ id: id(99), revision: 1, changed_at: "2026-11-07T00:00:00Z", actor_name: "Admin", changed_fields: ["reason"] }] }]) {
      expect(() => parseSchoolSettings(value, schoolId)).toThrow(/could not be verified/);
    }
  });

  it("loads only the chosen school with the verified immutable request token", async () => {
    const f = fake(), controller = new AbortController();
    expect((await loadSchoolSettings(f.client, owner, schoolId, controller.signal)).school.id).toBe(schoolId);
    expect(f.getUser).toHaveBeenCalledWith("token-a");
    expect(f.rpc).toHaveBeenCalledWith("get_school_settings", { p_school_id: schoolId });
    expect(f.header).toHaveBeenCalledWith("Authorization", "Bearer token-a"); expect(f.abort).toHaveBeenCalledWith(controller.signal);
  });

  it("sends exact versioned retry inputs without readonly fields or arbitrary school paths", async () => {
    const f = fake(), input = intent();
    await expect(saveSchoolSettings(f.client, owner, input)).resolves.toEqual({ revision: 1, changed: true, replayed: false });
    expect(f.rpc).toHaveBeenCalledWith("save_school_settings", { p_school_id: schoolId, p_expected_revision: 0, p_request_id: id(3), p_details: details, p_reason: input.reason });
    expect(f.header).toHaveBeenCalledWith("Authorization", "Bearer token-a");
  });

  it.each([null, { user: { id: id(4) }, access_token: "token-b" }, { user: { id: owner }, access_token: "" }])("rejects absent or switched local session (%j)", async (session) => {
    const f = fake(); f.getSession.mockResolvedValue({ data: { session }, error: null });
    await expect(saveSchoolSettings(f.client, owner, intent())).rejects.toMatchObject({ code: "access" });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("verifies the captured token with Auth and aborts before a write on mismatch or cancellation", async () => {
    const f = fake(); f.getUser.mockResolvedValueOnce({ data: { user: { id: id(9) } }, error: null });
    await expect(saveSchoolSettings(f.client, owner, intent())).rejects.toMatchObject({ code: "access" }); expect(f.rpc).not.toHaveBeenCalled();
    const controller = new AbortController(); f.getUser.mockImplementationOnce(async () => { controller.abort(); return { data: { user: { id: owner } }, error: null }; });
    await expect(saveSchoolSettings(f.client, owner, intent(), controller.signal)).rejects.toMatchObject({ name: "AbortError" }); expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each([["42501", "access"], ["40001", "conflict"], ["PT409", "conflict"], ["22023", "validation"], ["500", "unconfirmed"]])("maps %s without exposing server detail", async (code, expected) => {
    const f = fake(); f.rpc.mockImplementation(() => ({ setHeader: () => ({ abortSignal: () => Promise.resolve({ data: null, error: { code, message: "private server detail" } }) }) }));
    const call = saveSchoolSettings(f.client, owner, intent());
    await expect(call).rejects.toMatchObject({ code: expected }); await expect(call).rejects.not.toThrow(/private server detail/);
  });

  it.each([{ revision: "1", changed: true, replayed: false }, { revision: 7, changed: true, replayed: false },
    { revision: 1, changed: false, replayed: true }, { revision: 2147483648, changed: true, replayed: false }])("does not claim success for an inconsistent save receipt (%j)", async (data) => {
    const f = fake(); f.rpc.mockImplementation(() => ({ setHeader: () => ({ abortSignal: () => Promise.resolve({ data, error: null }) }) }));
    await expect(saveSchoolSettings(f.client, owner, intent())).rejects.toMatchObject({ code: "unconfirmed" });
  });

  it("requires distinct descending immutable history revisions and nonempty allowed changed fields", () => {
    const event = { id: id(10), revision: 3, changed_at: "2026-11-07T00:00:00Z", actor_name: "School Admin", changed_fields: ["name"] };
    const school = { ...record().school, revision: 3 };
    for (const history of [[{ ...event, changed_fields: [] }], [{ ...event, changed_fields: ["name", "name"] }],
      [event, { ...event, revision: 2 }], [event, { ...event, id: id(11), revision: 3 }],
      [{ ...event, revision: 2 }, { ...event, id: id(11), revision: 3 }]]) {
      expect(() => parseSchoolSettings({ ...record(), school, history }, schoolId)).toThrow(/could not be verified/);
    }
    expect(parseSchoolSettings({ ...record(), school, history: [event, { ...event, id: id(11), revision: 2 }] }, schoolId).history).toHaveLength(2);
  });

  it("real SDK cannot replace A's bound Authorization with B while shared Auth prepares fetch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ revision: 1, changed: true, replayed: false }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createClient("https://school.example.supabase.co", "publishable-test-key", {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetcher },
    });
    let token = "token-a";
    vi.spyOn(client.auth, "getSession").mockImplementation(async () => ({ data: { session: { user: { id: token === "token-a" ? owner : id(8) }, access_token: token } }, error: null }) as Awaited<ReturnType<typeof client.auth.getSession>>);
    vi.spyOn(client.auth, "getUser").mockImplementation(async () => { token = "token-b"; return { data: { user: { id: owner } }, error: null } as Awaited<ReturnType<typeof client.auth.getUser>>; });
    await saveSchoolSettings(client, owner, intent());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer token-a");
    expect(token).toBe("token-b");
  });
});
