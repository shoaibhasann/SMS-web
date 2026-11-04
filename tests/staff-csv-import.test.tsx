import type { SupabaseClient } from "@supabase/supabase-js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaffCsvImport } from "@/components/admin/staff-csv-import";

const header = "employee_id,full_name,staff_type\n";
const schoolId = "10000000-0000-0000-0000-000000000001";

function uploadCsv(text: string) {
  const file = new File([text], "staff.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  fireEvent.change(screen.getByLabelText("Staff CSV file"), { target: { files: [file] } });
}

function openImport() {
  const details = screen.getByText("Import staff from CSV").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("staff CSV import panel", () => {
  it("blocks the whole batch when a directory ID or another file row matches", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = { rpc } as unknown as SupabaseClient;
    render(<StaffCsvImport client={client} schoolId={schoolId} existingEmployeeIds={["EXISTING-T", "EXISTING-S"]}
      disabled={false} refreshVersion={0} onBusyChange={vi.fn()} onImported={vi.fn()} />);
    openImport();
    uploadCsv(header + "existing-t,First,staff\nEXISTING-S,Second,teacher\nNEW-1,Third,teacher\nnew-1,Fourth,staff\n");
    const table = within(await screen.findByRole("region", { name: "Staff CSV preview" }));
    expect(table.getAllByText("Employee ID already exists in this school.")).toHaveLength(2);
    expect(table.getAllByText("Employee ID repeats in this file.")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Import 4 records" })).toBeDisabled();
    expect(rpc.mock.calls.map(([method]) => method)).not.toContain("import_school_staff");
  });

  it("retries an unconfirmed import with the same request after directory refresh", async () => {
    const responses = [
      { data: null, error: { code: "", message: "connection dropped" } },
      { data: { teacher_count: 1, staff_count: 1 }, error: null },
    ];
    const rpc = vi.fn().mockImplementation(async (method: string) => method === "import_school_staff"
      ? responses.shift()
      : { data: [], error: null });
    const client = { rpc } as unknown as SupabaseClient;
    const onImported = vi.fn();
    const onBusyChange = vi.fn();
    const props = { client, schoolId, disabled: false, refreshVersion: 0, onBusyChange, onImported };
    const view = render(<StaffCsvImport {...props} existingEmployeeIds={[]} />);
    openImport();
    uploadCsv(header + "NEW-T,Imported Teacher,teacher\nNEW-S,Imported Staff,staff\n");
    fireEvent.click(await screen.findByRole("button", { name: "Import 2 records" }));
    expect(await screen.findByRole("button", { name: "Retry same import" })).toBeEnabled();
    view.rerender(<StaffCsvImport {...props} existingEmployeeIds={["NEW-T", "NEW-S"]} refreshVersion={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry same import" }));
    expect(await screen.findByText("2 staff records imported. 1 teaching · 1 non-teaching.")).toBeVisible();
    const imports = rpc.mock.calls.filter(([method]) => method === "import_school_staff");
    expect(imports).toHaveLength(2);
    expect(imports[1]).toEqual(imports[0]);
    expect(onImported).toHaveBeenCalledTimes(1);
  });
});
