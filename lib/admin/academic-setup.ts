import type { SupabaseClient } from "@supabase/supabase-js";
import { readPages } from "@/lib/attendance/repository";

type NamedRecord = { id: string; name: string };
type Year = NamedRecord & { start_date: string; end_date: string; is_current: boolean };
type SchoolClass = NamedRecord & { sort_order: number; is_active: boolean };
type Section = NamedRecord & { class_id: string };
type Subject = NamedRecord & { code: string | null; is_active: boolean };

export type AcademicSetup = {
  years: Year[];
  classes: SchoolClass[];
  sections: Section[];
  subjects: Subject[];
};

export async function loadAcademicSetup(client: SupabaseClient, schoolId: string): Promise<AcademicSetup> {
  const [years, classes, sections, subjects] = await Promise.all([
    readPages<Year>((from, to) => client.from("academic_years")
      .select("id,name,start_date,end_date,is_current", { count: "exact" })
      .eq("school_id", schoolId).order("start_date", { ascending: false }).order("id").range(from, to), "Could not load years"),
    readPages<SchoolClass>((from, to) => client.from("classes")
      .select("id,name,sort_order,is_active", { count: "exact" })
      .eq("school_id", schoolId).order("sort_order").order("name").order("id").range(from, to), "Could not load classes"),
    readPages<Section>((from, to) => client.from("sections")
      .select("id,name,class_id", { count: "exact" })
      .eq("school_id", schoolId).order("name").order("id").range(from, to), "Could not load sections"),
    readPages<Subject>((from, to) => client.from("subjects")
      .select("id,name,code,is_active", { count: "exact" })
      .eq("school_id", schoolId).order("name").order("id").range(from, to), "Could not load subjects"),
  ]);
  return { years, classes, sections, subjects };
}

export type AcademicSetupDraft =
  | { kind: "years"; name: string; startDate: string; endDate: string; firstYear: boolean }
  | { kind: "classes"; name: string; sortOrder: number }
  | { kind: "sections"; name: string; classId: string }
  | { kind: "subjects"; name: string; code: string };

export async function addAcademicSetupRecord(client: SupabaseClient, schoolId: string, draft: AcademicSetupDraft) {
  const name = draft.name.trim();
  if (!name || name.length > 100) throw new Error("Enter a name of 1 to 100 characters.");
  let result;
  switch (draft.kind) {
    case "years": {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      if (!day.test(draft.startDate) || !day.test(draft.endDate) || draft.startDate > draft.endDate) {
        throw new Error("Choose an end date on or after the start date.");
      }
      result = await client.from("academic_years").insert({
        school_id: schoolId, name, start_date: draft.startDate, end_date: draft.endDate, is_current: draft.firstYear,
      });
      break;
    }
    case "classes":
      if (!Number.isInteger(draft.sortOrder) || draft.sortOrder < 0 || draft.sortOrder > 999) {
        throw new Error("Enter a display order between 0 and 999.");
      }
      result = await client.from("classes").insert({ school_id: schoolId, name, sort_order: draft.sortOrder });
      break;
    case "sections":
      if (!draft.classId) throw new Error("Choose an active class.");
      result = await client.from("sections").insert({ school_id: schoolId, class_id: draft.classId, name });
      break;
    case "subjects": {
      const code = draft.code.trim();
      if (code.length > 30) throw new Error("Use at most 30 characters for the subject code.");
      result = await client.from("subjects").insert({ school_id: schoolId, name, code: code || null });
      break;
    }
  }
  if (result.error?.code === "23505") {
    throw new Error(draft.kind === "years"
      ? "This year name or current year is already in use. Refresh and check the school’s years."
      : draft.kind === "subjects" ? "A subject with this name or code already exists here."
      : "A record with this name already exists here.");
  }
  if (result.error) throw new Error("The record could not be saved. Check your school access and try again.");
}
