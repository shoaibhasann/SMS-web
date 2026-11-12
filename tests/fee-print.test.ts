import { afterEach, describe, expect, it, vi } from "vitest";
import { feeDocumentCsv, formatIstDateTime, formatSchoolDay, printFeeDocument, statusTone } from "@/lib/finance/fee-print";

afterEach(() => vi.restoreAllMocks());

describe("fee documents", () => {
  it("formats receipt times in IST whatever the browser timezone", () => {
    expect(formatIstDateTime("2026-11-01T20:00:00Z")).toMatch(/^2 Nov 2026, 1:30\s?am IST$/i);
    expect(formatIstDateTime(null)).toBe("—");
  });

  it("formats school days without a timezone shift and tones fee statuses", () => {
    expect(formatSchoolDay("2026-04-10")).toBe("10 Apr 2026");
    expect(formatSchoolDay(null)).toBe("—");
    expect(statusTone("paid")).toContain("text-success");
    expect(statusTone("overdue")).toContain("text-danger");
    expect(statusTone("unknown")).not.toMatch(/text-(success|warning|danger)/);
  });

  it("escapes CSV cells and neutralises spreadsheet formulas", () => {
    const csv = feeDocumentCsv({ title: "Fee receipt R-1", schoolName: "Alpha, \"North\"", rows: [["Student", "=HYPERLINK(\"x\")"], ["Amount", "₹1,000.00"]] });
    expect(csv.split("\r\n")).toEqual(["Field,Value", "School,\"Alpha, \"\"North\"\"\"", "Document,Fee receipt R-1", "Student,\"'=HYPERLINK(\"\"x\"\")\"", "Amount,\"₹1,000.00\"", ""]);
  });

  it("prints names as text in a separate window and detaches the opener", () => {
    const doc = document.implementation.createHTMLDocument("print");
    const popup = { document: doc, opener: window as unknown, focus: vi.fn(), print: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    printFeeDocument({ title: "Fee receipt R-1", schoolName: "Alpha School", rows: [["Student", "<img src=x onerror=alert(1)>"]] });
    expect(doc.title).toBe("Fee receipt R-1");
    expect(doc.body.querySelector("img")).toBeNull();
    expect(doc.body.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(doc.head.querySelector("style")?.textContent).toContain("@media print");
    expect(popup.opener).toBeNull(); expect(popup.print).toHaveBeenCalledOnce();
  });

  it("throws a clear error when the popup is blocked", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    expect(() => printFeeDocument({ title: "t", schoolName: "s", rows: [] })).toThrow("print window was blocked");
  });
});
