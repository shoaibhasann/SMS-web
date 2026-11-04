import { describe, expect, it } from "vitest";
import type { AcademicSetup } from "@/lib/admin/academic-setup";
import { parseAcademicSetupCsv, previewAcademicSetupCsv } from "@/lib/admin/academic-setup-csv";

const setup: AcademicSetup = {
  years: [],
  classes: [
    { id: "six", name: "Class 6", is_active: true, sort_order: 60 },
    { id: "seven", name: "Class 7", is_active: false, sort_order: 70 },
  ],
  sections: [{ id: "section-a", class_id: "six", name: "A" }],
  subjects: [{ id: "science", name: "Science", code: "SCI", is_active: true }],
};

describe("academic CSV preview", () => {
  it("shows class order validation and duplicate names", () => {
    const rows = parseAcademicSetupCsv('\uFEFFname,sort_order\r\n"Literature, Part 1",12\r\n class 6 ,6\r\nDuplicate,7\r\nduplicate,8\r\nOut of bounds,9999', "classes");
    expect(previewAcademicSetupCsv("classes", rows, setup)).toEqual([
      expect.objectContaining({ record: { name: "Literature, Part 1", sortOrder: 12 } }),
      expect.objectContaining({ issue: "Name already exists in this school." }),
      expect.objectContaining({ issue: "Name repeats in this file." }),
      expect.objectContaining({ issue: "Name repeats in this file." }),
      expect.objectContaining({ issue: "Use a display order between 0 and 999." }),
    ]);
  });

  it("resolves exact active class names and reports invalid or duplicate sections", () => {
    const rows = parseAcademicSetupCsv("class_name,name\nClass 6, B\nClass 6, a\nclass 6,C\nClass 7,C", "sections");
    expect(previewAcademicSetupCsv("sections", rows, setup)).toEqual([
      expect.objectContaining({ record: { name: "B", classId: "six", className: "Class 6" } }),
      expect.objectContaining({ issue: "Name already exists in this class." }),
      expect.objectContaining({ issue: "Use an exact name from the active classes in this school." }),
      expect.objectContaining({ issue: "Use an exact name from the active classes in this school." }),
    ]);
  });

  it("permits blank subject codes and flags repeated codes independently of names", () => {
    const rows = parseAcademicSetupCsv("name,code\nMath,\nArt,\nPhysics,sci\nHindi,HIN\nहिंदी,hin", "subjects");
    expect(previewAcademicSetupCsv("subjects", rows, setup)).toEqual([
      expect.objectContaining({ record: { name: "Math", code: "" } }),
      expect.objectContaining({ record: { name: "Art", code: "" } }),
      expect.objectContaining({ issue: "Subject code already exists in this school." }),
      expect.objectContaining({ issue: "Subject code repeats in this file." }),
      expect.objectContaining({ issue: "Subject code repeats in this file." }),
    ]);
    expect(() => parseAcademicSetupCsv("name,sort_order\nA,1", "subjects")).toThrow("template columns");
  });
});
