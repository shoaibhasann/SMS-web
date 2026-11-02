"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Eye, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  AdminDemoService,
  adminAdmissionsDemoMetrics,
  type AdminDemoModule,
  type AdminDemoRecord,
  type AdminInventoryMovement,
  type AdminLibraryLoan,
  type AdminTransportAllocation,
} from "@/lib/admin/admin-demo-service";

type Column = { key: string; label: string };
type ModuleConfig = { title: string; description: string; columns: Column[] };

const configs: Record<AdminDemoModule, ModuleConfig> = {
  students: { title: "Students", description: "Student directory, class placement, and parent details.", columns: [{ key: "admissionNo", label: "Admission No." }, { key: "name", label: "Student" }, { key: "className", label: "Class" }, { key: "section", label: "Section" }, { key: "parent", label: "Parent" }, { key: "mobile", label: "Mobile" }, { key: "status", label: "Status" }] },
  parents: { title: "Parents", description: "Parent and guardian contacts with linked children.", columns: [{ key: "name", label: "Parent" }, { key: "relationship", label: "Relationship" }, { key: "mobile", label: "Mobile" }, { key: "email", label: "Email" }, { key: "children", label: "Children" }, { key: "status", label: "Status" }] },
  teachers: { title: "Teachers & Staff", description: "School staff profiles and academic assignments.", columns: [{ key: "employeeId", label: "Employee ID" }, { key: "name", label: "Name" }, { key: "designation", label: "Designation" }, { key: "department", label: "Department" }, { key: "mobile", label: "Mobile" }, { key: "assignments", label: "Assignments" }, { key: "status", label: "Status" }] },
  attendance: { title: "Attendance", description: "School-wide attendance records.", columns: [{ key: "date", label: "Date" }, { key: "student", label: "Student" }, { key: "className", label: "Class" }, { key: "section", label: "Section" }, { key: "rollNo", label: "Roll No." }, { key: "status", label: "Status" }] },
  academics: { title: "Academics", description: "Academic years, classes, sections, and subjects.", columns: [] },
  admissions: { title: "Admissions", description: "Admission enquiries and application progress.", columns: [{ key: "applicationNo", label: "Application" }, { key: "studentName", label: "Student" }, { key: "parentName", label: "Parent" }, { key: "className", label: "Class" }, { key: "stage", label: "Stage" }, { key: "receivedOn", label: "Received" }, { key: "status", label: "Status" }] },
  timetable: { title: "Timetable", description: "Class and subject timetable entries.", columns: [{ key: "day", label: "Day" }, { key: "period", label: "Period" }, { key: "startTime", label: "Start" }, { key: "endTime", label: "End" }, { key: "className", label: "Class" }, { key: "section", label: "Section" }, { key: "subject", label: "Subject" }, { key: "teacher", label: "Teacher" }, { key: "room", label: "Room" }] },
  events: { title: "Events & Calendar", description: "School events and important dates.", columns: [{ key: "title", label: "Event" }, { key: "type", label: "Type" }, { key: "date", label: "Date" }, { key: "startTime", label: "Start" }, { key: "endTime", label: "End" }, { key: "location", label: "Venue" }, { key: "audience", label: "Audience" }, { key: "status", label: "Status" }] },
  notifications: { title: "Notifications", description: "School messages and delivery status.", columns: [{ key: "title", label: "Notification" }, { key: "type", label: "Type" }, { key: "audience", label: "Audience" }, { key: "date", label: "Date" }, { key: "status", label: "Status" }] },
  library: { title: "Library", description: "Book catalogue, issues, returns, and fines.", columns: [{ key: "name", label: "Book" }, { key: "isbn", label: "ISBN" }, { key: "category", label: "Category" }, { key: "author", label: "Author" }, { key: "quantity", label: "Copies" }, { key: "available", label: "Available" }, { key: "status", label: "Status" }] },
  transport: { title: "Transport", description: "Routes, stops, vehicles, and student allocations.", columns: [{ key: "vehicleNumber", label: "Vehicle" }, { key: "type", label: "Type" }, { key: "capacity", label: "Capacity" }, { key: "driver", label: "Driver" }, { key: "route", label: "Route" }, { key: "stops", label: "Stops" }, { key: "status", label: "Status" }] },
  inventory: { title: "Inventory", description: "School stock and recorded movements.", columns: [{ key: "name", label: "Item" }, { key: "category", label: "Category" }, { key: "quantity", label: "Quantity" }, { key: "condition", label: "Condition" }, { key: "location", label: "Location" }, { key: "purchaseDate", label: "Purchased" }, { key: "status", label: "Status" }] },
  "hr-payroll": { title: "HR & Payroll", description: "Staff records and payroll overview.", columns: [{ key: "name", label: "Staff" }, { key: "employeeId", label: "Employee ID" }, { key: "department", label: "Department" }, { key: "designation", label: "Designation" }, { key: "salary", label: "Monthly Salary" }, { key: "status", label: "Status" }] },
  leave: { title: "Leave Management", description: "Staff leave requests and approval status.", columns: [{ key: "employee", label: "Employee" }, { key: "leaveType", label: "Leave Type" }, { key: "from", label: "From" }, { key: "to", label: "To" }, { key: "days", label: "Days" }, { key: "status", label: "Status" }] },
  profile: { title: "School Profile", description: "School administrator and school contact details.", columns: [{ key: "name", label: "Name" }, { key: "designation", label: "Designation" }, { key: "email", label: "Email" }, { key: "mobile", label: "Phone" }, { key: "school", label: "School" }, { key: "status", label: "Status" }] },
  documents: { title: "School Documents", description: "School documents and policy files.", columns: [{ key: "name", label: "Document" }, { key: "category", label: "Category" }, { key: "fileName", label: "File" }, { key: "uploadedOn", label: "Uploaded" }, { key: "status", label: "Status" }] },
  reports: { title: "Reports & Analytics", description: "School report catalogue and generation status.", columns: [{ key: "name", label: "Report" }, { key: "type", label: "Type" }, { key: "period", label: "Period" }, { key: "generatedOn", label: "Generated" }, { key: "status", label: "Status" }] },
  "audit-logs": { title: "Audit Logs", description: "Recent school activity and administrative changes.", columns: [{ key: "dateTime", label: "Date & Time" }, { key: "user", label: "User" }, { key: "role", label: "Role" }, { key: "action", label: "Action" }, { key: "module", label: "Module" }, { key: "entity", label: "Record" }, { key: "description", label: "Details" }] },
  settings: { title: "School Settings", description: "School details and academic preferences.", columns: [{ key: "schoolName", label: "School" }, { key: "phone", label: "Phone" }, { key: "email", label: "Email" }, { key: "currentYear", label: "Academic Year" }, { key: "workingDays", label: "Working Days" }, { key: "attendanceRule", label: "Attendance" }] },
};

const hiddenKeys = new Set(["id"]);
const labelFor = (key: string) => key.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
const text = (value: unknown) => value == null || value === "" ? "—" : String(value);

export function AdminDemoWorkspace({ module }: { module: AdminDemoModule }) {
  const config = configs[module];
  const [records, setRecords] = useState<AdminDemoRecord[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [selected, setSelected] = useState<AdminDemoRecord | null>(null);
  const [editing, setEditing] = useState<AdminDemoRecord | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [extraForm, setExtraForm] = useState<"loan" | "allocation" | "movement" | null>(null);
  const [extraValues, setExtraValues] = useState<Record<string, string>>({});
  const [toast, setToast] = useState("");
  const [loans, setLoans] = useState<AdminLibraryLoan[]>([]);
  const [allocations, setAllocations] = useState<AdminTransportAllocation[]>([]);
  const [movements, setMovements] = useState<AdminInventoryMovement[]>([]);

  const refresh = () => {
    setRecords(AdminDemoService.load(module));
    if (module === "library") setLoans(AdminDemoService.loadLibraryLoans());
    if (module === "transport") setAllocations(AdminDemoService.loadTransportAllocations());
    if (module === "inventory") setMovements(AdminDemoService.loadInventoryMovements());
  };
  useEffect(refresh, [module]);

  const columns = useMemo(() => {
    const configured = config.columns;
    if (configured.length || !records.length) return configured;
    return Object.keys(records[0]).filter((key) => !hiddenKeys.has(key) && key !== "recordType").map((key) => ({ key, label: labelFor(key) }));
  }, [config.columns, records]);
  const filtered = records.filter((record) =>
    (statusFilter === "All" || text(record.status) === statusFilter) &&
    Object.values(record).join(" ").toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const statuses = [...new Set(records.map((record) => text(record.status)).filter((value) => value !== "—"))];

  function openForm(record?: AdminDemoRecord) {
    setEditing(record ?? null);
    const source = record
      ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== "id"))
      : records[0]
        ? Object.fromEntries(Object.keys(records[0]).filter((key) => key !== "id").map((key) => [key, ""]))
        : Object.fromEntries(columns.map(({ key }) => [key, ""]));
    setForm(Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value ?? "")])));
    setFormOpen(true);
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = editing
      ? records.map((record) => record.id === editing.id ? { ...record, ...form } : record)
      : [...records, { id: `${module}-${Date.now()}`, ...form }];
    AdminDemoService.save(module, next);
    setRecords(next);
    setEditing(null);
    setFormOpen(false);
    setToast(editing ? "Changes saved to demo data." : "Added to demo data.");
  }
  function remove(record: AdminDemoRecord) {
    if (!window.confirm(`Delete “${text(record[columns[0]?.key])}” from this browser’s demo data?`)) return;
    const next = records.filter((item) => item.id !== record.id);
    AdminDemoService.save(module, next);
    setRecords(next);
    if (selected?.id === record.id) setSelected(null);
  }
  function updateStatus(record: AdminDemoRecord, status: string) {
    const next = records.map((item) => item.id === record.id ? { ...item, status } : item);
    AdminDemoService.save(module, next);
    setRecords(next);
  }
  function submitExtra(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (extraForm === "loan") {
      const next = [...loans, {
        id: `loan-${Date.now()}`,
        student: extraValues.student ?? "",
        admissionNo: extraValues.admissionNo ?? "",
        book: extraValues.book ?? "",
        issuedOn: extraValues.issuedOn ?? "",
        dueDate: extraValues.dueDate ?? "",
        fine: 0,
        status: "Issued" as const,
      }];
      AdminDemoService.saveLibraryLoans(next);
      setLoans(next);
      const books = records.map((record) => record.name === (extraValues.book ?? "") ? { ...record, available: Math.max(0, Number(record.available ?? 0) - 1), status: Number(record.available ?? 0) <= 1 ? "Issued" : record.status } : record);
      AdminDemoService.save(module, books);
      setRecords(books);
    } else if (extraForm === "allocation") {
      const next = [...allocations, {
        id: `allocation-${Date.now()}`,
        student: extraValues.student ?? "",
        className: extraValues.className ?? "",
        route: extraValues.route ?? "",
        stop: extraValues.stop ?? "",
        status: "Active" as const,
      }];
      AdminDemoService.saveTransportAllocations(next);
      setAllocations(next);
    } else if (extraForm === "movement") {
      const next = [...movements, {
        id: `movement-${Date.now()}`,
        item: extraValues.item ?? "",
        quantityChange: Number(extraValues.quantityChange || 0),
        reason: extraValues.reason ?? "",
        recordedOn: extraValues.recordedOn ?? new Date().toISOString().slice(0, 10),
      }];
      AdminDemoService.saveInventoryMovements(next);
      setMovements(next);
      const updated = records.map((record) => record.name === (extraValues.item ?? "") ? { ...record, quantity: Math.max(0, Number(record.quantity ?? 0) + Number(extraValues.quantityChange || 0)) } : record);
      AdminDemoService.save(module, updated);
      setRecords(updated);
    }
    setExtraForm(null);
    setExtraValues({});
    setToast("Saved to demo data.");
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p><h1 className="mt-1 text-3xl font-black">{config.title}</h1><p className="mt-2 text-sm muted">{config.description}</p></div>
        <div className="flex gap-2"><button type="button" onClick={refresh} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold"><RefreshCw size={16} /> Reset demo data</button><button type="button" onClick={() => openForm()} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white"><Plus size={16} /> Add record</button></div>
      </header>
      <div className="rounded-xl border border-sky-300/50 bg-sky-500/5 px-4 py-3 text-xs leading-5 text-sky-800 dark:text-sky-200">Demo preview: changes are saved in this browser only.</div>
      {toast && <p role="status" className="text-sm text-emerald-600">{toast}</p>}

      {module === "admissions" && <div className="grid gap-3 sm:grid-cols-3"><article className="card p-4"><p className="text-xs muted">Applications</p><p className="mt-2 text-2xl font-black">{records.length}</p></article><article className="card p-4"><p className="text-xs muted">Pending review</p><p className="mt-2 text-2xl font-black">{records.filter((item) => item.status === "Pending").length}</p></article><article className="card p-4"><p className="text-xs muted">Available seats</p><p className="mt-2 text-2xl font-black">{adminAdmissionsDemoMetrics.availableSeats}</p></article></div>}

      <section className="card overflow-hidden">
        <div className="grid gap-3 border-b border-[var(--border)] p-4 sm:grid-cols-2">
          <label className="relative"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 muted" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`Search ${config.title.toLowerCase()}`} className="field pl-9" /></label>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="field"><option>All</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select>
        </div>
        <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr>{columns.map((column) => <th key={column.key} className="p-3">{column.label}</th>)}<th className="p-3 text-right">Actions</th></tr></thead>
          <tbody className="divide-y divide-[var(--border)]">{filtered.map((record) => <tr key={record.id}>
            {columns.map((column) => <td key={column.key} className="max-w-64 p-3">{text(record[column.key])}</td>)}
            <td className="p-3"><div className="flex justify-end gap-1">
              <button type="button" onClick={() => setSelected(record)} aria-label="View details" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Eye size={15} /></button>
              <button type="button" onClick={() => openForm(record)} aria-label="Edit record" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Pencil size={15} /></button>
              {module === "admissions" && record.status === "Pending" && <><button type="button" onClick={() => updateStatus(record, "Approved")} className="rounded-lg px-2 text-xs font-semibold text-emerald-600">Approve</button><button type="button" onClick={() => updateStatus(record, "Rejected")} className="rounded-lg px-2 text-xs font-semibold text-red-600">Reject</button></>}
              {module === "leave" && record.status === "Pending" && <><button type="button" onClick={() => updateStatus(record, "Approved")} className="rounded-lg px-2 text-xs font-semibold text-emerald-600">Approve</button><button type="button" onClick={() => updateStatus(record, "Rejected")} className="rounded-lg px-2 text-xs font-semibold text-red-600">Reject</button></>}
              {module === "notifications" && record.status !== "Sent" && <button type="button" onClick={() => updateStatus(record, "Sent")} className="rounded-lg px-2 text-xs font-semibold text-blue-600">Send</button>}
              {module === "reports" && <button type="button" onClick={() => { const next = records.map((item) => item.id === record.id ? { ...item, status: "Generated", generatedOn: new Date().toISOString().slice(0, 10) } : item); AdminDemoService.save(module, next); setRecords(next); }} className="rounded-lg px-2 text-xs font-semibold text-blue-600">Generate</button>}
              <button type="button" onClick={() => remove(record)} aria-label="Delete record" className="rounded-lg p-2 text-red-600 hover:bg-red-500/10"><Trash2 size={15} /></button>
            </div></td>
          </tr>)}{!filtered.length && <tr><td className="p-6 text-center muted" colSpan={columns.length + 1}>No records match the selected filters.</td></tr>}</tbody>
        </table></div>
      </section>

      {module === "library" && <section className="card overflow-hidden"><div className="flex items-center justify-between border-b border-[var(--border)] p-4"><h2 className="font-bold">Issue history</h2><button type="button" onClick={() => { setExtraForm("loan"); setExtraValues({ issuedOn: new Date().toISOString().slice(0, 10) }); }} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white">Issue book</button></div><div className="divide-y divide-[var(--border)]">{loans.map((loan) => <div key={loan.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"><div><p className="font-semibold">{loan.student} · {loan.book}</p><p className="text-xs muted">Due {loan.dueDate} · Fine {loan.fine} · {loan.status}</p></div>{loan.status !== "Returned" && <button type="button" onClick={() => { const next = loans.map((item) => item.id === loan.id ? { ...item, status: "Returned" as const, fine: 0 } : item); AdminDemoService.saveLibraryLoans(next); setLoans(next); const books = records.map((record) => record.name === loan.book ? { ...record, available: Math.min(Number(record.quantity ?? 0), Number(record.available ?? 0) + 1), status: "Available" } : record); AdminDemoService.save(module, books); setRecords(books); }} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-semibold">Mark returned</button>}</div>)}</div></section>}
      {module === "transport" && <section className="card overflow-hidden"><div className="flex items-center justify-between border-b border-[var(--border)] p-4"><h2 className="font-bold">Student route allocations</h2><button type="button" onClick={() => setExtraForm("allocation")} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white">Add allocation</button></div><div className="divide-y divide-[var(--border)]">{allocations.map((item) => <div key={item.id} className="flex flex-wrap justify-between gap-2 p-4 text-sm"><span>{item.student} · {item.className} · {item.route} · {item.stop}</span><span className="font-semibold">{item.status}</span></div>)}</div></section>}
      {module === "inventory" && <section className="card overflow-hidden"><div className="flex items-center justify-between border-b border-[var(--border)] p-4"><h2 className="font-bold">Stock movements</h2><button type="button" onClick={() => setExtraForm("movement")} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white">Record movement</button></div><div className="divide-y divide-[var(--border)]">{movements.map((item) => <div key={item.id} className="p-4 text-sm">{item.item} · {item.quantityChange} · {item.reason} · {item.recordedOn}</div>)}</div></section>}

      {selected && <section className="card space-y-4 p-5"><div className="flex items-start justify-between"><div><h2 className="font-bold">Record details</h2><p className="text-sm muted">{config.title}</p></div><button type="button" onClick={() => setSelected(null)} className="text-sm font-semibold text-blue-600">Close</button></div><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(selected).filter(([key]) => key !== "id").map(([key, value]) => <div key={key}><dt className="text-xs muted">{labelFor(key)}</dt><dd className="mt-1 text-sm font-semibold">{text(value)}</dd></div>)}</dl></section>}
      {formOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"><form onSubmit={save} className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"><div><h2 className="text-lg font-bold">{editing ? "Edit record" : "Add record"}</h2><p className="text-sm muted">Saved to this browser’s demo data.</p></div><div className="grid gap-3 sm:grid-cols-2">{Object.entries(form).map(([key, value]) => <label key={key} className="space-y-1.5 text-sm font-medium">{labelFor(key)}<input value={value} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} className="field" /></label>)}</div><div className="flex justify-end gap-2"><button type="button" onClick={() => setFormOpen(false)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button><button className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">{editing ? "Save changes" : "Add to demo data"}</button></div></form></div>}
      {extraForm && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4"><form onSubmit={submitExtra} className="w-full max-w-lg space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl"><h2 className="text-lg font-bold">{extraForm === "loan" ? "Issue a book" : extraForm === "allocation" ? "Student route allocation" : "Record stock movement"}</h2>{(extraForm === "loan" ? [{ key: "student", label: "Student" }, { key: "admissionNo", label: "Admission No." }, { key: "book", label: "Book" }, { key: "issuedOn", label: "Issued On", type: "date" }, { key: "dueDate", label: "Due Date", type: "date" }] : extraForm === "allocation" ? [{ key: "student", label: "Student" }, { key: "className", label: "Class" }, { key: "route", label: "Route" }, { key: "stop", label: "Stop" }] : [{ key: "item", label: "Item" }, { key: "quantityChange", label: "Quantity Change", type: "number" }, { key: "reason", label: "Reason" }, { key: "recordedOn", label: "Recorded On", type: "date" }]).map(({ key, label, type }) => <label key={key} className="block space-y-1.5 text-sm font-medium">{label}<input required type={type ?? "text"} value={extraValues[key] ?? ""} onChange={(event) => setExtraValues((current) => ({ ...current, [key]: event.target.value }))} className="field" /></label>)}<div className="flex justify-end gap-2"><button type="button" onClick={() => setExtraForm(null)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button><button className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">Save to demo data</button></div></form></div>}
    </div>
  );
}
