import type { SupabaseClient } from "@supabase/supabase-js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AcademicSetupCsvImport } from "@/components/admin/academic-setup-csv-import";
import type { AcademicSetup } from "@/lib/admin/academic-setup";

const schoolId = "10000000-0000-0000-0000-000000000001";
const setup: AcademicSetup = {
  years: [], subjects: [],
  classes: [{ id: "six", name: "Class 6", is_active: true, sort_order: 60 }],
  sections: [{ id: "section-a", class_id: "six", name: "A" }],
};

function uploadSections(text: string) {
  const content = "class_name,name\n" + text;
  const file = new File([content], "sections.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(content).buffer });
  const details = screen.getByText("Import sections from CSV").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  fireEvent.change(screen.getByLabelText("Sections CSV file"), { target: { files: [file] } });
}

describe("academic CSV import panel", () => {
  it("shows duplicate and invalid class rows and blocks import", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    render(<AcademicSetupCsvImport client={{ rpc } as unknown as SupabaseClient} schoolId={schoolId} kind="sections"
      setup={setup} disabled={false} refreshVersion={0} onBusyChange={vi.fn()} onImported={vi.fn()} />);
    uploadSections("Class 6,a\nclass 6,C\nClass 6,B\nClass 6,b\n");
    const preview = within(await screen.findByRole("region", { name: "Sections CSV preview" }));
    expect(preview.getByText("Name already exists in this class.")).toBeVisible();
    expect(preview.getByText("Use an exact name from the active classes in this school.")).toBeVisible();
    expect(preview.getAllByText("Name repeats in this file.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Import 4 records" })).toBeDisabled();
    expect(rpc.mock.calls.map(([method]) => method)).not.toContain("import_academic_setup_records");
  });

  it("replays the original class mapping when the response is lost and the catalog refreshes", async () => {
    const replies = [
      { data: null, error: { code: "", message: "connection dropped" } },
      { data: 1, error: null },
    ];
    const rpc = vi.fn().mockImplementation(async (method: string) => method === "import_academic_setup_records"
      ? replies.shift()
      : { data: [], error: null });
    const onImported = vi.fn();
    const props = {
      client: { rpc } as unknown as SupabaseClient, schoolId, kind: "sections" as const, disabled: false,
      refreshVersion: 0, onBusyChange: vi.fn(), onImported,
    };
    const view = render(<AcademicSetupCsvImport {...props} setup={setup} />);
    uploadSections("Class 6,B\n");
    fireEvent.click(await screen.findByRole("button", { name: "Import 1 record" }));
    expect(await screen.findByRole("button", { name: "Retry same import" })).toBeEnabled();
    view.rerender(<AcademicSetupCsvImport {...props}
      setup={{ ...setup, classes: [{ ...setup.classes[0], name: "Renamed Class 6" }] }} refreshVersion={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry same import" }));
    expect(await screen.findByText("1 section imported.")).toBeVisible();
    const imports = rpc.mock.calls.filter(([method]) => method === "import_academic_setup_records");
    expect(imports).toHaveLength(2);
    expect(imports[0][1]).toEqual(expect.objectContaining({
      p_records: [{ name: "B", classId: "six", className: "Class 6" }],
    }));
    expect(imports[1]).toEqual(imports[0]);
    expect(onImported).toHaveBeenCalledTimes(1);
  });
});
