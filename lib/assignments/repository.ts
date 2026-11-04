import type { SupabaseClient } from "@supabase/supabase-js";

export type AssignmentSchool = { id: string; name: string; canManage: boolean; teacherId: string | null };
export type AssignmentAccess = { userId: string; schools: AssignmentSchool[] };
export type AssignmentOption = { id: string; name: string };
export type AssignmentSection = AssignmentOption & { class_id: string };
export type TeachingAssignmentRow = {
  id: string; teacher_id: string; academic_year_id: string; class_id: string;
  section_id: string | null; subject_id: string; is_class_teacher: boolean;
};
export type TeachingAssignmentDraft = Omit<TeachingAssignmentRow, "id" | "academic_year_id" | "section_id"> & { section_id: string };
export type AssignmentData = {
  year: AssignmentOption; teachers: AssignmentOption[]; classes: AssignmentOption[];
  sections: AssignmentSection[]; subjects: AssignmentOption[]; rows: TeachingAssignmentRow[];
};
export interface TeachingAssignmentRepository {
  access(): Promise<AssignmentAccess>;
  load(school: AssignmentSchool): Promise<AssignmentData>;
  save(schoolId: string, yearId: string, draft: TeachingAssignmentDraft, previous: TeachingAssignmentRow | null): Promise<void>;
  remove(schoolId: string, previous: TeachingAssignmentRow): Promise<void>;
}
type RoleRow = { role: string; school_id: string | null };
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };
const COLUMNS = "id,teacher_id,academic_year_id,class_id,section_id,subject_id,is_class_teacher";
const managerRoles = new Set(["school_admin", "principal"]);

function failure(error: { code?: string } | null, fallback: string): Error {
  if (error?.code === "23505") return new Error("This assignment or class-teacher duty conflicts with an existing record. Refresh and review the assignments.");
  if (error?.code === "42501") return new Error("Your permission changed or this record is inaccessible. Refresh before trying again.");
  return new Error(fallback);
}

async function pages<T>(query: (from: number, to: number) => PromiseLike<Result>, label: string): Promise<T[]> {
  const rows: T[] = [];
  let expected: number | null = null;
  for (let from = 0; ; from = rows.length) {
    const result = await query(from, from + 199);
    if (result.error || !Array.isArray(result.data) || typeof result.count !== "number") {
      throw failure(result.error, `${label} could not be loaded completely. Refresh or contact your administrator.`);
    }
    if ((expected !== null && expected !== result.count) || (!result.data.length && rows.length < result.count)) {
      throw new Error(`${label} changed while loading. Please refresh.`);
    }
    expected = result.count;
    rows.push(...result.data as T[]);
    if (rows.length === expected) return rows;
    if (rows.length > expected) throw new Error(`${label} changed while loading. Please refresh.`);
  }
}

function permitted(roles: RoleRow[], schoolId: string) {
  return roles.some((row) => row.role === "super_admin" ||
    (managerRoles.has(row.role) && row.school_id === schoolId));
}

export function createTeachingAssignmentRepository(client: SupabaseClient): TeachingAssignmentRepository {
  async function identity() {
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) throw new Error("Please sign in again to view teaching assignments.");
    const roles = await pages<RoleRow>((from, to) => client.from("user_roles")
      .select("role,school_id", { count: "exact" }).eq("user_id", user.id).order("id").range(from, to), "Your school permissions");
    return { user, roles };
  }

  async function authorize(schoolId: string) {
    const { roles } = await identity();
    if (!permitted(roles, schoolId)) throw new Error("Only an administrator or principal for this school can change teaching assignments.");
  }

  function expectedFields(row: TeachingAssignmentRow) {
    return { id: row.id, teacher_id: row.teacher_id, academic_year_id: row.academic_year_id,
      class_id: row.class_id, subject_id: row.subject_id, is_class_teacher: row.is_class_teacher };
  }

  return {
    async access() {
      const { user, roles } = await identity();
      const global = roles.some((row) => row.role === "super_admin");
      const managerSchools = new Set(roles.filter((row) => managerRoles.has(row.role) && row.school_id).map((row) => row.school_id!));
      const teacherSchools = new Set(roles.filter((row) => row.role === "teacher" && row.school_id).map((row) => row.school_id!));
      const teachers = teacherSchools.size ? await pages<{ id: string; school_id: string }>((from, to) => client.from("teachers")
        .select("id,school_id", { count: "exact" }).eq("profile_id", user.id).in("school_id", [...teacherSchools])
        .order("id").range(from, to), "Your teacher profile") : [];
      const ownTeachers = new Map<string, string>();
      for (const teacher of teachers) {
        if (ownTeachers.has(teacher.school_id)) throw new Error("More than one teacher profile exists for this school. Ask an administrator to resolve it.");
        ownTeachers.set(teacher.school_id, teacher.id);
      }
      const ids = [...new Set([...managerSchools, ...ownTeachers.keys()])];
      if (!global && !ids.length) throw new Error("No school administrator, principal or linked teacher access is available for this account.");
      const schools = await pages<AssignmentOption>((from, to) => {
        const query = client.from("schools").select("id,name", { count: "exact" }).order("id");
        return (global ? query : query.in("id", ids)).range(from, to);
      }, "Your schools");
      if ((!global && schools.length !== ids.length) || !schools.length) throw new Error("An authorized school could not be accessed. Contact your administrator.");
      return { userId: user.id, schools: schools.map((school) => ({ ...school,
        canManage: global || managerSchools.has(school.id), teacherId: ownTeachers.get(school.id) ?? null,
      })) };
    },

    async load(school) {
      const years = await pages<AssignmentOption>((from, to) => client.from("academic_years")
        .select("id,name", { count: "exact" }).eq("school_id", school.id).eq("is_current", true)
        .order("id").range(from, to), "The current academic year");
      if (years.length !== 1) throw new Error("Exactly one current academic year is required. Ask your administrator to check the school setup.");
      const year = years[0];
      if (!school.canManage && !school.teacherId) throw new Error("A teacher profile is required to read your assignments.");
      const [teachers, classes, sections, subjects] = await Promise.all([
        pages<{ id: string; full_name: string | null; employee_id: string | null }>((from, to) => {
          const query = client.from("teachers").select("id,full_name,employee_id", { count: "exact" }).eq("school_id", school.id).order("id");
          return (school.canManage ? query : query.eq("id", school.teacherId!)).range(from, to);
        }, "Teachers"),
        pages<AssignmentOption>((from, to) => client.from("classes").select("id,name", { count: "exact" }).eq("school_id", school.id).order("id").range(from, to), "Classes"),
        pages<AssignmentSection>((from, to) => client.from("sections").select("id,name,class_id", { count: "exact" }).eq("school_id", school.id).order("id").range(from, to), "Sections"),
        pages<AssignmentOption>((from, to) => client.from("subjects").select("id,name", { count: "exact" }).eq("school_id", school.id).order("id").range(from, to), "Subjects"),
      ]);
      const teacherIds = teachers.map((teacher) => teacher.id);
      if (!school.canManage && (teachers.length !== 1 || teachers[0].id !== school.teacherId)) {
        throw new Error("Your teacher profile is no longer accessible. Refresh or contact your administrator.");
      }
      const rows: TeachingAssignmentRow[] = [];
      for (let offset = 0; offset < teacherIds.length; offset += 100) {
        rows.push(...await pages<TeachingAssignmentRow>((from, to) => client.from("teacher_subject_assignments")
          .select(COLUMNS, { count: "exact" }).eq("academic_year_id", year.id).in("teacher_id", teacherIds.slice(offset, offset + 100))
          .order("id").range(from, to), "Teaching assignments"));
      }
      const classIds = new Set(classes.map((row) => row.id));
      const subjectIds = new Set(subjects.map((row) => row.id));
      for (const row of rows) {
        if (!teacherIds.includes(row.teacher_id) || row.academic_year_id !== year.id || !classIds.has(row.class_id) || !subjectIds.has(row.subject_id) ||
          (row.section_id !== null && !sections.some((section) => section.id === row.section_id && section.class_id === row.class_id))) {
          throw new Error("An assignment has inaccessible or mismatched school records. Ask an administrator to review it.");
        }
      }
      return { year, rows, classes, sections, subjects,
        teachers: teachers.map((teacher) => ({ id: teacher.id, name: teacher.full_name || teacher.employee_id || "Unnamed teacher" })),
      };
    },

    async save(schoolId, yearId, draft, previous) {
      if (!schoolId || !yearId || !draft.teacher_id || !draft.class_id || !draft.section_id || !draft.subject_id) throw new Error("Teacher, class, section and subject are required.");
      await authorize(schoolId);
      if (previous && previous.academic_year_id !== yearId) throw new Error("The assignment year changed. Refresh before saving.");
      const payload = { ...draft, academic_year_id: yearId };
      let result: Result;
      if (previous) {
        const query = client.from("teacher_subject_assignments").update(payload).match(expectedFields(previous));
        result = await (previous.section_id === null ? query.is("section_id", null) : query.eq("section_id", previous.section_id)).select(COLUMNS);
      } else result = await client.from("teacher_subject_assignments").insert(payload).select(COLUMNS);
      if (result.error) throw failure(result.error, "The teaching assignment could not be saved. Refresh or contact your administrator.");
      const saved = Array.isArray(result.data) && result.data[0] && typeof result.data[0] === "object"
        ? result.data[0] as Record<string, unknown> : null;
      if (!Array.isArray(result.data) || result.data.length !== 1 ||
        !saved || typeof saved.id !== "string" || !saved.id ||
        (previous && saved.id !== previous.id) || Object.entries(payload).some(([key, value]) => saved[key] !== value)) {
        throw new Error("The assignment changed elsewhere or could not be accessed. No successful save was confirmed. Refresh before retrying.");
      }
    },

    async remove(schoolId, previous) {
      await authorize(schoolId);
      const query = client.from("teacher_subject_assignments").delete().match(expectedFields(previous));
      const result = await (previous.section_id === null ? query.is("section_id", null) : query.eq("section_id", previous.section_id)).select("id");
      if (result.error) throw failure(result.error, "The teaching assignment could not be removed. Refresh or contact your administrator.");
      if (!Array.isArray(result.data) || result.data.length !== 1 || result.data[0].id !== previous.id) {
        throw new Error("The assignment changed elsewhere or could not be accessed. No removal was confirmed. Refresh before retrying.");
      }
    },
  };
}
