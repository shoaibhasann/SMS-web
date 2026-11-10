import Link from "next/link";
import { ArrowUpRight, FileDown, FileUp } from "lucide-react";
import { academicCsvTemplates } from "@/lib/admin/academic-setup-csv";
import { assignmentCsvTemplate } from "@/lib/assignments/csv";
import { historicalCalendarCsvHeader } from "@/lib/attendance/historical-calendar-csv";
import { openingBalanceCsvTemplate } from "@/lib/finance/fee-batches";
import { guardianCsvTemplate } from "@/lib/guardian-invitations/guardian-csv";
import { maxRosterImportStudents, rosterCsvTemplate } from "@/lib/students/roster-csv";
import { staffCsvTemplate } from "@/lib/teachers/staff-csv";

export function SchoolDataImport({ school }: { school: { id: string; name: string } }) {
  const steps = [
    { name: "Academic setup", href: "/modules/academics",
      detail: "Create the academic year, then import classes before sections. Import subjects before teaching assignments.",
      templates: Object.entries(academicCsvTemplates).map(([key, template]) => ({ name: template.label, filename: `${key}-template.csv`, csv: `${template.header}\n${template.sample}\n` })) },
    { name: "Students", href: "/modules/students",
      detail: `Select the year, class and section for each file. Import admission numbers and names in batches of up to ${maxRosterImportStudents}.`,
      templates: [{ name: "Students", filename: "students-template.csv", csv: rosterCsvTemplate }] },
    { name: "Staff", href: "/modules/teachers",
      detail: "Import directory records using employee IDs. Invite staff separately when they need sign-in access.",
      templates: [{ name: "Staff", filename: "staff-template.csv", csv: staffCsvTemplate }] },
    { name: "Teaching assignments", href: "/modules/teacher-assignments",
      detail: "Match each employee ID to the class, section and subject names already in SMS.",
      templates: [{ name: "Teaching assignments", filename: "teaching-assignments-template.csv", csv: assignmentCsvTemplate }] },
    { name: "Guardian invitations", href: "/modules/guardian-invitations",
      detail: "Match each guardian email to a saved admission number. Guardian access begins after the invitation is accepted.",
      templates: [{ name: "Guardian invitations", filename: "guardian-invitations-template.csv", csv: guardianCsvTemplate }] },
    { name: "Historical calendar", href: "#attendance-calendar",
      detail: "Open the historical calendar import to fill missing past working days and holidays for a saved academic year.",
      templates: [{ name: "Historical calendar", filename: "historical-school-calendar-template.csv", csv: `${historicalCalendarCsvHeader}\n` }] },
    { name: "Opening fee balances", href: `/modules/fees?school=${encodeURIComponent(school.id)}`,
      detail: "Choose Opening balances under bulk demands. Reconcile outstanding debt against the school ledger before posting. Payment and receipt history needs a separate migration.",
      templates: [{ name: "Opening balances", filename: "opening-balances-template.csv", csv: openingBalanceCsvTemplate }] },
  ];
  const action = "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-[var(--primary)] hover:bg-[var(--surface-2)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2";
  return (
    <details className="card min-w-0" aria-labelledby="school-data-import-heading">
      <summary className="cursor-pointer px-5 py-4 focus-visible:outline-2 focus-visible:outline-offset-2">
        <span id="school-data-import-heading" className="inline-flex items-center gap-2 align-middle font-semibold"><FileUp size={18} aria-hidden="true" />Import school data</span>
      </summary>
      <div className="border-t border-[var(--border)]">
        <p className="break-words px-5 py-4 text-sm leading-6 muted">
          Prepare UTF-8 CSV files for <strong>{school.name}</strong> using the templates below. Keep admission numbers and employee IDs as text in your spreadsheet. Check the school and preview in each import before confirming.
        </p>
        <ol className="divide-y divide-[var(--border)] px-5">
          {steps.map((step, index) => (
            <li key={step.name} className="flex items-start gap-3 py-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[var(--surface-2)] text-xs font-semibold" aria-hidden="true">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold">{step.name}</h3>
                <p className="mt-1 text-sm leading-5 muted">{step.detail}</p>
                <div className="mt-1 flex flex-wrap gap-x-1">
                  <Link href={step.href} prefetch={false} className={action}>Open {step.name.toLowerCase()}<ArrowUpRight size={14} aria-hidden="true" /></Link>
                  {step.templates.map(({ name, filename, csv }) => (
                    <a className={action} key={filename} download={filename} href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}>
                      <FileDown size={14} aria-hidden="true" />{name} CSV template
                    </a>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
        <p className="border-t border-[var(--border)] px-5 py-4 text-sm leading-6 muted">
          Detailed student profiles, historical attendance marks, exam results, payment history and documents need an assisted migration. Keep the original export until the imported records have been reconciled.
        </p>
      </div>
    </details>
  );
}
