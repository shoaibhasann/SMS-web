import type { SupabaseClient } from "@supabase/supabase-js";
import { readPages } from "@/lib/attendance/repository";
import { boundMfaSession } from "@/lib/auth/staff-mfa";

type ParentRow = { id: string; school_id: string; profile_id: string | null; guardian_code: string | null; registered_mobile: string | null };
type ProfileRow = { id: string; school_id: string; full_name: string | null; is_active: boolean };
type StudentRow = { id: string; school_id: string; first_name: string; middle_name: string | null; last_name: string | null; admission_no: string; status: string };
type LinkRow = { parent_id: string; student_id: string; relationship: string; is_primary: boolean };
type Page<T> = { data: T[] | null; error: { message: string } | null; count?: number | null };

export type GuardianDirectoryRecord = {
  id: string; name: string | null; code: string | null; mobile: string | null;
  account: "active" | "inactive" | "unlinked";
  children: { id: string; name: string; admissionNumber: string; status: string; relationship: string; primary: boolean }[];
};

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value: unknown): value is string => typeof value === "string";
const optionalText = (value: unknown): value is string | null => value === null || text(value);
const unreadable = () => new Error("Guardian records could not be verified completely. Reload or ask your school administrator to review the mapping.");

/** The directory is a current read, not a transaction snapshot or proof of native contact verification. */
export async function loadGuardianDirectory(client: SupabaseClient, userId: string, schoolId: string, signal: AbortSignal): Promise<GuardianDirectoryRecord[]> {
  if (!uuid(userId) || !uuid(schoolId)) throw unreadable();
  const session = await boundMfaSession(client, userId, signal);
  if (!session) throw new Error("Sign in again to view guardians.");
  const authorization = `Bearer ${session.access_token}`;
  async function read<T>(query: (from: number, to: number) => PromiseLike<Page<T>>, description: string) {
    return readPages<T>(async (from, to) => {
      signal.throwIfAborted();
      const result = await query(from, to);
      signal.throwIfAborted();
      if (!result.error && (!Number.isSafeInteger(result.count) || Number(result.count) < 0
        || Array.isArray(result.data) && (result.data.length > to - from + 1 || from + result.data.length > Number(result.count)))) throw unreadable();
      return result;
    }, description);
  }
  async function verifyOffice() {
    const roles = await read<{ role: string; school_id: string | null }>((from, to) => client.from("user_roles")
      .select("role,school_id", { count: "exact" }).eq("user_id", userId).order("id").range(from, to)
      .setHeader("Authorization", authorization).abortSignal(signal), "Current guardian-directory access");
    if (!roles.every(role => role && text(role.role) && (role.school_id === null || uuid(role.school_id)))
      || !roles.some(role => role.role === "super_admin" && role.school_id === null
        || ["school_admin", "principal"].includes(role.role) && role.school_id === schoolId)) {
      throw new Error("A current School Admin or Principal role is required to view this guardian directory.");
    }
    const schools = await read<{ id: string; is_active: boolean }>((from, to) => client.from("schools")
      .select("id,is_active", { count: "exact" }).eq("id", schoolId).order("id").range(from, to)
      .setHeader("Authorization", authorization).abortSignal(signal), "Current school access");
    if (schools.length !== 1 || schools[0]?.id !== schoolId || schools[0].is_active !== true) throw new Error("Current access to an active school is required to view guardians.");
  }
  await verifyOffice();
  const parents = await read<ParentRow>((from, to) => client.from("parents")
    .select("id,school_id,profile_id,guardian_code,registered_mobile", { count: "exact" }).eq("school_id", schoolId)
    .order("id").range(from, to).setHeader("Authorization", authorization).abortSignal(signal), "Guardians");
  const parentIds = new Set<string>(), profileIds = new Set<string>();
  for (const parent of parents) {
    if (!parent || !uuid(parent.id) || parentIds.has(parent.id) || parent.school_id !== schoolId
      || !(parent.profile_id === null || uuid(parent.profile_id)) || !optionalText(parent.guardian_code) || !optionalText(parent.registered_mobile)) throw unreadable();
    parentIds.add(parent.id);
    if (parent.profile_id) profileIds.add(parent.profile_id);
  }
  const profiles = new Map<string, ProfileRow>(), links: LinkRow[] = [];
  const ids = Array.from(profileIds);
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    for (const profile of await read<ProfileRow>((from, to) => client.from("profiles")
      .select("id,school_id,full_name,is_active", { count: "exact" }).eq("school_id", schoolId).in("id", batch)
      .order("id").range(from, to).setHeader("Authorization", authorization).abortSignal(signal), "Guardian profiles")) {
      if (!profile || !uuid(profile.id) || !batch.includes(profile.id) || profiles.has(profile.id) || profile.school_id !== schoolId
        || !optionalText(profile.full_name) || typeof profile.is_active !== "boolean") throw unreadable();
      profiles.set(profile.id, profile);
    }
  }
  if (Array.from(profileIds).some(id => !profiles.has(id))) throw unreadable();
  const guardians = Array.from(parentIds), linkedPairs = new Set<string>();
  for (let offset = 0; offset < guardians.length; offset += 100) {
    const batch = guardians.slice(offset, offset + 100);
    for (const link of await read<LinkRow>((from, to) => client.from("student_parents")
      .select("parent_id,student_id,relationship,is_primary", { count: "exact" }).in("parent_id", batch)
      .order("parent_id").order("student_id").range(from, to).setHeader("Authorization", authorization).abortSignal(signal), "Guardian child links")) {
      const key = `${link?.parent_id}:${link?.student_id}`;
      if (!link || !batch.includes(link.parent_id) || !uuid(link.student_id) || linkedPairs.has(key)
        || !text(link.relationship) || typeof link.is_primary !== "boolean") throw unreadable();
      linkedPairs.add(key); links.push(link);
    }
  }
  const children = new Map<string, StudentRow>(), childIds = Array.from(new Set(links.map(link => link.student_id)));
  for (let offset = 0; offset < childIds.length; offset += 100) {
    const batch = childIds.slice(offset, offset + 100);
    for (const child of await read<StudentRow>((from, to) => client.from("students")
      .select("id,school_id,first_name,middle_name,last_name,admission_no,status", { count: "exact" })
      .eq("school_id", schoolId).in("id", batch).order("id").range(from, to)
      .setHeader("Authorization", authorization).abortSignal(signal), "Linked students")) {
      if (!child || !uuid(child.id) || !batch.includes(child.id) || children.has(child.id) || child.school_id !== schoolId
        || !text(child.first_name) || !optionalText(child.middle_name) || !optionalText(child.last_name)
        || !text(child.admission_no) || !child.admission_no.trim() || !text(child.status)) throw unreadable();
      children.set(child.id, child);
    }
  }
  if (childIds.some(id => !children.has(id))) throw unreadable();
  const byParent = new Map<string, GuardianDirectoryRecord["children"]>();
  for (const link of links) {
    const child = children.get(link.student_id)!;
    const records = byParent.get(link.parent_id) ?? [];
    records.push({ id: child.id, name: [child.first_name, child.middle_name, child.last_name].filter(Boolean).join(" "),
      admissionNumber: child.admission_no, status: child.status, relationship: link.relationship, primary: link.is_primary });
    byParent.set(link.parent_id, records);
  }
  await verifyOffice();
  return parents.map(parent => {
    const profile = parent.profile_id ? profiles.get(parent.profile_id)! : null;
    return { id: parent.id, name: profile?.full_name ?? null, code: parent.guardian_code, mobile: parent.registered_mobile,
      account: profile ? profile.is_active ? "active" as const : "inactive" as const : "unlinked" as const,
      children: byParent.get(parent.id) ?? [] };
  }).sort((a, b) => (a.name || a.code || "").localeCompare(b.name || b.code || "") || a.id.localeCompare(b.id));
}
