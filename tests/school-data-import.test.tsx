import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SchoolDataImport } from "@/components/admin/school-data-import";
import { maxRosterImportStudents } from "@/lib/students/roster-csv";

describe("school data import steps", () => {
  it("says the Students template also takes DOB and registered mobile", () => {
    render(<SchoolDataImport school={{ id: "school-a", name: "QA School" }} />);
    expect(screen.getByText(`Import admission numbers, names, date of birth and registered mobile in batches of up to ${maxRosterImportStudents}.`, { exact: false })).toBeInTheDocument();
  });
});
