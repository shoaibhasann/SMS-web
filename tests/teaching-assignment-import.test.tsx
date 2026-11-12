import type { SupabaseClient } from "@supabase/supabase-js";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TeachingAssignmentManager } from "@/components/academic/teaching-assignment-manager";
import { assignmentCsvTemplate, parseAssignmentCsv } from "@/lib/assignments/csv";
import { createAssignmentImportRepository } from "@/lib/assignments/import";
import type { AssignmentData, TeachingAssignmentRepository } from "@/lib/assignments/repository";

const header = assignmentCsvTemplate.split("\n")[0];
const assignment = {
  employeeId: "QA-T01", className: "Class 6", sectionName: "A", subjectName: "Science", isClassTeacher: true,
};
const matched = {
  row_number: 1, employee_id: "QA-T01", class_name: "Class 6", section_name: "A", subject_name: "Science",
  is_class_teacher: true, teacher_id: "teacher", teacher_name: "QA Teacher", class_id: "class", section_id: "section",
  subject_id: "subject", error: null,
};
const data: AssignmentData = {
  year: { id: "year", name: "2026–27" },
  teachers: [{ id: "teacher", name: "QA Teacher" }],
  classes: [{ id: "class", name: "Class 6" }],
  sections: [{ id: "section", class_id: "class", name: "A" }],
  subjects: [{ id: "subject", name: "Science" }],
  rows: [],
};

function renderManager(rpc: ReturnType<typeof vi.fn>) {
  const client = { rpc } as unknown as SupabaseClient;
  const repo: TeachingAssignmentRepository = {
    access: vi.fn().mockResolvedValue({ userId: "user", schools: [{ id: "school-a", name: "QA School", canManage: true, teacherId: null }] }),
    load: vi.fn().mockResolvedValue(data),
    save: vi.fn(),
    remove: vi.fn(), timetablePeriods: vi.fn().mockResolvedValue([]),
    ...createAssignmentImportRepository(client),
  };
  render(<TeachingAssignmentManager repository={repo} />);
  return repo;
}

async function upload(user: ReturnType<typeof userEvent.setup>, rows: string) {
  await user.click(await screen.findByText("Import teaching assignments from CSV"));
  const bytes = new TextEncoder().encode(`${header}\n${rows}`);
  const file = Object.assign(new File([bytes], "assignments.csv", { type: "text/csv" }), {
    arrayBuffer: async () => bytes.buffer,
  });
  await user.upload(screen.getByLabelText("Teaching assignment CSV file"), file);
}

describe("teaching assignment CSV", () => {
  it("parses template data and reports duplicate assignments, class duty conflicts and invalid rows", () => {
    const rows = parseAssignmentCsv(`\uFEFF${header}\r\n QA-T01 ,Class 6,A,"Science",TRUE\r\nQA-T01,Class 6,A,Science,false\r\nQA-T02,Class 6,A,Math,true\r\nQA-T01,Class 6,B,Math,true\r\nQA-T03,Class 6,A,Math,maybe\r\n`);
    expect(rows[0]).toEqual({ ...assignment, rowNumber: 1, issue: null });
    expect(rows.slice(1).map((row) => row.issue)).toEqual([
      "This assignment repeats row 1.",
      "Row 1 already assigns a class teacher for this class and section.",
      "Row 1 already assigns a class-teacher duty to this teacher.",
      "Use true or false for is_class_teacher.",
    ]);
    expect(() => parseAssignmentCsv(`${header}\n${Array.from({ length: 51 }, (_, index) => `QA-T${index},Class 6,A,Science,false`).join("\n")}`))
      .toThrow(/between 1 and 50/);
  });

  it("blocks local duplicate rows before reading or writing server data", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn();
    renderManager(rpc);
    await upload(user, "QA-T01,Class 6,A,Science,true\nQA-T01,Class 6,A,Science,false");

    expect(await screen.findByText("This assignment repeats row 1.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 2 teaching assignments" })).toBeDisabled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("shows matched scope and server conflicts without allowing partial import", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValue({ data: [{ ...matched, error: "This section already has a class teacher." }], error: null });
    renderManager(rpc);
    await upload(user, "QA-T01,Class 6,A,Science,true");

    const preview = within(await screen.findByRole("region", { name: "Teaching assignment CSV preview" }));
    expect(preview.getByText("QA Teacher")).toBeInTheDocument();
    expect(preview.getByText("Science")).toBeInTheDocument();
    expect(preview.getByText("This section already has a class teacher.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 1 teaching assignment" })).toBeDisabled();
    expect(rpc).toHaveBeenCalledExactlyOnceWith("preview_teacher_assignment_import", {
      p_school_id: "school-a", p_academic_year_id: "year", p_rows: [assignment],
    });
  });

  it("sends the matched IDs, retries with the same request ID and reloads the existing list", async () => {
    const user = userEvent.setup();
    const rpc = vi.fn().mockResolvedValueOnce({ data: [matched], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "Network lost" } })
      .mockImplementationOnce(async (_name, params) => ({
        data: { request_id: params.p_request_id, assignment_count: 1 }, error: null,
      }));
    const repo = renderManager(rpc);
    vi.mocked(repo.load).mockResolvedValueOnce(data).mockResolvedValueOnce({
      ...data,
      rows: [{ id: "new-assignment", teacher_id: "teacher", academic_year_id: "year", class_id: "class",
        section_id: "section", subject_id: "subject", is_class_teacher: true }],
    });
    await upload(user, "QA-T01,Class 6,A,Science,true");

    expect(await screen.findByText("assignments.csv · 1 of 1 ready")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search assignments" }), "unrelated");
    expect(rpc).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Import 1 teaching assignment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/retry from this same preview/i);
    await user.click(screen.getByRole("button", { name: "Retry same assignment import" }));
    expect(await screen.findByText("1 teaching assignment imported.")).toBeInTheDocument();
    expect(await screen.findByRole("cell", { name: "Science" })).toBeInTheDocument();
    expect(repo.load).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[2]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls[2]).toEqual(["import_teacher_assignments", {
      p_school_id: "school-a", p_academic_year_id: "year", p_request_id: expect.any(String),
      p_rows: [{ ...assignment, teacherId: "teacher", classId: "class", sectionId: "section", subjectId: "subject" }],
    }]);
  });
});
