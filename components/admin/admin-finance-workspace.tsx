"use client";

import { FormEvent, useCallback, useEffect, useRef, useMemo, useState } from "react";
import { BadgeIndianRupee, Download, Eye, Printer, ReceiptText, RefreshCw, Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { adminFinanceReportDemo } from "@/lib/admin/admin-dashboard-demo";

type FeeRecord = {
  id: string;
  student_id: string;
  fee_structure_id: string | null;
  amount: number;
  discount: number;
  late_fee: number;
  status: string;
  billing_period: string | null;
  due_date: string | null;
};

type PaymentRecord = {
  id: string;
  student_fee_id: string;
  student_id: string;
  receipt_no: string;
  amount: number;
  payment_method: string;
  status: string;
  paid_at: string;
};

type Student = { id: string; name: string; admission_no: string };
type FeeStructure = { id: string; name: string };
type FeeStructureRecord = FeeStructure & { amount: number; frequency: string };

function logError(context: string, error: unknown) {
  if (error && typeof error === "object") {
    const item = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    console.error(context, {
      message: item.message,
      details: item.details,
      hint: item.hint,
      code: item.code,
    });
  } else {
    console.error(context, error);
  }
}

function money(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
}

export function AdminFinanceWorkspace({ mode }: { mode: "fees" | "invoices" | "reports" }) {
  const [supabase] = useState(createClient);
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  const [schoolId, setSchoolId] = useState("");
  const [currentYearId, setCurrentYearId] = useState("");
  const [fees, setFees] = useState<FeeRecord[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [students, setStudents] = useState<Record<string, Student>>({});
  const [structures, setStructures] = useState<Record<string, string>>({});
  const [structureRows, setStructureRows] = useState<FeeStructureRecord[]>([]);
  const [structureName, setStructureName] = useState("Tuition Fee");
  const [structureFrequency, setStructureFrequency] = useState("monthly");
  const [structureAmount, setStructureAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [selectedFeeId, setSelectedFeeId] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [localMessage, setLocalMessage] = useState("");
  const [selectedReceipt, setSelectedReceipt] = useState<PaymentRecord | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<FeeRecord | null>(null);
  const [invoiceTab, setInvoiceTab] = useState<"invoices" | "receipts">("invoices");
  const [financeSearch, setFinanceSearch] = useState("");
  const [financeStatus, setFinanceStatus] = useState("All");
  const [financeStudent, setFinanceStudent] = useState("All");
  const [financeMonth, setFinanceMonth] = useState("");

  const load = useCallback(() => {
    const request = ++latestRequest.current;
    const isCurrent = () => mounted.current && request === latestRequest.current;
    return supabase.auth.getUser().then(async ({ data: auth, error: authError }) => {
      try {
        if (!isCurrent()) return;
        setLoading(true);
        setError("");
        if (authError) throw authError;
        if (!auth.user) throw new Error("Please sign in again.");
        const { data: roles, error: rolesError } = await supabase
          .from("user_roles")
          .select("role,school_id")
          .eq("user_id", auth.user.id);
        if (rolesError) throw rolesError;

        let schoolId = (roles ?? []).find((row) =>
          row.role === "school_admin" && row.school_id,
        )?.school_id ?? "";
        if (!schoolId && (roles ?? []).some((row) => row.role === "super_admin")) {
          const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("school_id")
            .eq("id", auth.user.id)
            .maybeSingle();
          if (profileError) throw profileError;
          schoolId = profile?.school_id ?? "";
        }
        if (!schoolId) throw new Error("Choose a school-linked admin account to view finance records.");

        const [feeResult, paymentResult, structureResult, yearResult] = await Promise.all([
          supabase.from("student_fees").select("id,student_id,fee_structure_id,amount,discount,late_fee,status,billing_period,due_date").eq("school_id", schoolId).order("created_at", { ascending: false }),
          supabase.from("fee_payments").select("id,student_fee_id,student_id,receipt_no,amount,payment_method,status,paid_at").eq("school_id", schoolId).order("paid_at", { ascending: false }),
          supabase.from("fee_structures").select("id,name,amount,frequency").eq("school_id", schoolId),
          supabase.from("academic_years").select("id").eq("school_id", schoolId).eq("is_current", true).maybeSingle(),
        ]);
        const results = [
          ["student_fees", feeResult],
          ["fee_payments", paymentResult],
          ["fee_structures", structureResult],
          ["academic_years", yearResult],
        ] as const;
        for (const [table, result] of results) {
          if (result.error) {
            logError(`[Admin Finance] SELECT ${table} failed`, result.error);
            throw result.error;
          }
        }
        const feeRows = (feeResult.data ?? []) as FeeRecord[];
        const paymentRows = (paymentResult.data ?? []) as PaymentRecord[];
        const studentIds = [...new Set([...feeRows.map((row) => row.student_id), ...paymentRows.map((row) => row.student_id)])];

        const studentRows = [];
        for (let offset = 0; offset < studentIds.length; offset += 500) {
          const batch = studentIds.slice(offset, offset + 500);
          const { data, error: studentError } = await supabase
            .from("students")
            .select("id,first_name,middle_name,last_name,admission_no")
            .eq("school_id", schoolId)
            .in("id", batch);
          if (studentError) {
            logError("[Admin Finance] SELECT students failed", studentError);
            throw studentError;
          }
          studentRows.push(...(data ?? []));
        }

        if (!isCurrent()) return;
        setSchoolId(schoolId);
        setFees(feeRows);
        setPayments(paymentRows);
        const loadedStructures = (structureResult.data ?? []) as FeeStructureRecord[];
        setStructureRows(loadedStructures);
        setCurrentYearId(yearResult.data?.id ?? "");
        setStudents(Object.fromEntries(studentRows.map((student) => [
          student.id,
          {
            id: student.id,
            name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
            admission_no: student.admission_no,
          },
        ])));
        setStructures(Object.fromEntries(loadedStructures.map((structure) => [structure.id, structure.name])));

      } catch (loadError) {
        if (!isCurrent()) return;
        logError("Admin finance data load failed", loadError);
        setError("Finance records could not be loaded. Please refresh or contact your administrator.");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    }, (loadError: unknown) => {
      if (!isCurrent()) return;
      logError("Admin finance data load failed", loadError);
      setError("Finance records could not be loaded. Please refresh or contact your administrator.");
      setLoading(false);
    });
  }, [supabase]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; latestRequest.current += 1; };
  }, [load]);

  const paidByFee = useMemo(() => {
    const totals = new Map<string, number>();
    for (const payment of payments) {
      if (payment.status !== "paid") continue;
      totals.set(payment.student_fee_id, (totals.get(payment.student_fee_id) ?? 0) + Number(payment.amount));
    }
    return totals;
  }, [payments]);

  const totalCollected = payments.reduce((total, payment) =>
    total + (payment.status === "paid" ? Number(payment.amount) : 0), 0);
  const outstanding = fees.reduce((total, fee) => {
    const due = Number(fee.amount) - Number(fee.discount) + Number(fee.late_fee);
    return total + Math.max(0, due - (paidByFee.get(fee.id) ?? 0));
  }, 0);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const collectedThisMonth = payments.reduce((total, payment) =>
    total + (payment.status === "paid" && payment.paid_at?.startsWith(currentMonth) ? Number(payment.amount) : 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const collectedToday = payments.reduce((total, payment) =>
    total + (payment.status === "paid" && payment.paid_at?.startsWith(today) ? Number(payment.amount) : 0), 0);
  const pendingFeeCount = fees.filter((fee) => fee.status !== "paid").length;
  const overdueFeeCount = fees.filter((fee) => fee.status !== "paid" && fee.due_date && fee.due_date < today).length;
  const filteredFees = fees.filter((fee) =>
    (financeStatus === "All" || fee.status === financeStatus) &&
    (financeStudent === "All" || fee.student_id === financeStudent) &&
    `${students[fee.student_id]?.name ?? ""} ${students[fee.student_id]?.admission_no ?? ""} ${structures[fee.fee_structure_id ?? ""] ?? ""}`.toLowerCase().includes(financeSearch.toLowerCase()),
  );
  const filteredPayments = payments.filter((payment) =>
    (financeStatus === "All" || payment.status === financeStatus) &&
    (financeStudent === "All" || payment.student_id === financeStudent) &&
    (!financeMonth || payment.paid_at?.startsWith(financeMonth)) &&
    `${payment.receipt_no} ${students[payment.student_id]?.name ?? ""} ${students[payment.student_id]?.admission_no ?? ""}`.toLowerCase().includes(financeSearch.toLowerCase()),
  );
  const filteredInvoices = fees.filter((fee) =>
    (financeStatus === "All" || fee.status === financeStatus) &&
    (financeStudent === "All" || fee.student_id === financeStudent) &&
    `${students[fee.student_id]?.name ?? ""} ${students[fee.student_id]?.admission_no ?? ""} ${structures[fee.fee_structure_id ?? ""] ?? ""}`.toLowerCase().includes(financeSearch.toLowerCase()),
  );

  function previewPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fee = fees.find((row) => row.id === selectedFeeId);
    if (!fee) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    setLocalMessage(`Payment preview for ${students[fee.student_id]?.name ?? "student"}: ${money(amount)} via ${paymentMethod}. No payment was saved.`);
    setPaymentDialogOpen(false);
    setPaymentAmount("");
  }

  function downloadReceipt(payment: PaymentRecord) {
    const student = students[payment.student_id];
    const blob = new Blob([JSON.stringify({
      receipt: payment.receipt_no,
      student: student?.name ?? "Student",
      admissionNumber: student?.admission_no ?? "",
      amount: Number(payment.amount),
      paymentMethod: payment.payment_method,
      paidAt: payment.paid_at,
      status: payment.status,
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${payment.receipt_no}-preview.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadInvoice(fee: FeeRecord) {
    const paid = paidByFee.get(fee.id) ?? 0;
    const total = Number(fee.amount) - Number(fee.discount) + Number(fee.late_fee);
    const invoice = {
      school: "School invoice preview",
      student: students[fee.student_id]?.name ?? "Student",
      admissionNumber: students[fee.student_id]?.admission_no ?? "",
      fee: structures[fee.fee_structure_id ?? ""] ?? "Fee",
      billingPeriod: fee.billing_period,
      subtotal: Number(fee.amount),
      discount: Number(fee.discount),
      lateFee: Number(fee.late_fee),
      paid,
      pending: Math.max(0, total - paid),
      total,
      dueDate: fee.due_date,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(invoice, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `invoice-preview-${students[fee.student_id]?.admission_no ?? fee.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function createFeeStructure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !currentYearId || !structureName.trim() || !Number(structureAmount)) return;
    setError("");
    setLocalMessage("");
    try {
      const { error: saveError } = await supabase.from("fee_structures").insert({
        school_id: schoolId,
        academic_year_id: currentYearId,
        name: structureName.trim(),
        frequency: structureFrequency,
        amount: Number(structureAmount),
      });
      if (saveError) throw saveError;
      setLocalMessage("Fee structure saved.");
      setStructureAmount("");
      await load();
    } catch (saveError) {
      logError("Admin fee structure save failed", saveError);
      setError("Fee structure could not be saved. Check your school access and try again.");
    }
  }

  const labels = {
    fees: { title: "Fee Records", subtitle: "School-scoped fee assignments and balances." },
    invoices: { title: "Invoices & Receipts", subtitle: "Existing payment receipts recorded for this school." },
    reports: { title: "Finance Reports", subtitle: "Totals calculated from the school’s existing fee and payment records." },
  }[mode];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-blue-600">School Administration</p>
          <h1 className="mt-1 text-3xl font-black">{labels.title}</h1>
          <p className="mt-2 text-sm muted">{labels.subtitle}</p>
        </div>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]">
          <RefreshCw size={16} /> Refresh
        </button>
      </header>

      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {localMessage && <div role="status" className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm text-sky-800 dark:text-sky-200">{localMessage}</div>}

      {mode === "reports" && (
        <>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="card p-5"><div className="flex items-center gap-2 text-sm muted"><BadgeIndianRupee size={16} /> Recorded collections</div><div className="mt-2 text-2xl font-black">{money(totalCollected)}</div></div>
          <div className="card p-5"><div className="text-sm muted">Collected this month</div><div className="mt-2 text-2xl font-black">{money(collectedThisMonth)}</div></div>
          <div className="card p-5"><div className="text-sm muted">Outstanding balance</div><div className="mt-2 text-2xl font-black">{money(outstanding)}</div></div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="card overflow-hidden">
            <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="font-bold">Student-wise dues</h2></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Fee</th><th className="p-3">Total</th><th className="p-3">Paid</th><th className="p-3">Pending</th></tr></thead>
              <tbody className="divide-y divide-[var(--border)]">{fees.slice(0, 20).map((fee) => {
                const total = Number(fee.amount) - Number(fee.discount) + Number(fee.late_fee);
                const paid = paidByFee.get(fee.id) ?? 0;
                return <tr key={fee.id}><td className="p-3 font-semibold">{students[fee.student_id]?.name ?? "Student"}</td><td className="p-3">{structures[fee.fee_structure_id ?? ""] ?? "Fee"}</td><td className="p-3">{money(total)}</td><td className="p-3">{money(paid)}</td><td className="p-3">{money(Math.max(0, total - paid))}</td></tr>;
              })}{!fees.length && <tr><td colSpan={5} className="p-5 text-sm muted">No fee balances recorded.</td></tr>}</tbody>
            </table></div>
          </section>
          <section className="card overflow-hidden">
            <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="font-bold">Class-wise dues · demo preview</h2></div>
            <div className="divide-y divide-[var(--border)]">{adminFinanceReportDemo.classDues.map((row) => <div key={row.className} className="flex items-center justify-between gap-3 p-4 text-sm"><div><p className="font-semibold">{row.className}</p><p className="text-xs muted">{row.pendingStudents} students with balance · sample data</p></div><p className="font-bold">{money(row.balance)}</p></div>)}</div>
          </section>
        </div>
        <section className="card overflow-hidden">
          <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="font-bold">Payment history</h2></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm">
            <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Date</th><th className="p-3">Receipt</th><th className="p-3">Student</th><th className="p-3">Method</th><th className="p-3">Amount</th><th className="p-3">Status</th></tr></thead>
            <tbody className="divide-y divide-[var(--border)]">{payments.slice(0, 20).map((payment) => <tr key={payment.id}><td className="p-3">{payment.paid_at ? new Date(payment.paid_at).toLocaleDateString() : "—"}</td><td className="p-3">{payment.receipt_no}</td><td className="p-3">{students[payment.student_id]?.name ?? "Student"}</td><td className="p-3 capitalize">{payment.payment_method.replaceAll("_", " ")}</td><td className="p-3">{money(Number(payment.amount))}</td><td className="p-3 capitalize">{payment.status}</td></tr>)}
              {!payments.length && <tr><td colSpan={6} className="p-5 text-sm muted">No payment history available.</td></tr>}
            </tbody>
          </table></div>
        </section>
        </>
      )}

      {mode === "fees" && (
        <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[["Today's Collection", money(collectedToday)], ["Monthly Collection", money(collectedThisMonth)], ["Pending Fees", pendingFeeCount], ["Overdue Fees", overdueFeeCount]].map(([label, value]) => <article key={String(label)} className="card p-4"><p className="text-xs font-semibold muted">{label}</p><p className="mt-2 text-2xl font-black">{value}</p></article>)}
        </div>
        <section className="card p-5">
          <h2 className="font-bold">Fee structures</h2>
          <form onSubmit={createFeeStructure} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1.5 text-sm font-medium">Fee Category<select value={structureName} onChange={(event) => setStructureName(event.target.value)} className="field">{["Admission Fee", "Tuition Fee", "Annual Fee", "Transport", "Other"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="space-y-1.5 text-sm font-medium">Frequency<select value={structureFrequency} onChange={(event) => setStructureFrequency(event.target.value)} className="field"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="half_yearly">Half-yearly</option><option value="yearly">Yearly</option><option value="custom">Custom</option></select></label>
            <label className="space-y-1.5 text-sm font-medium">Amount<input required type="number" min="0.01" step="0.01" value={structureAmount} onChange={(event) => setStructureAmount(event.target.value)} className="field" /></label>
            <button disabled={!currentYearId} className="self-end rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">Add Fee Structure</button>
          </form>
          {!currentYearId && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">A current academic year is required to add fee structures.</p>}
          <div className="mt-4 flex flex-wrap gap-2">{structureRows.map((structure) => <span key={structure.id} className="rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium">{structure.name} · {structure.frequency} · {money(Number(structure.amount))}</span>)}</div>
        </section>
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4"><h2 className="font-bold">Student fee records</h2>
            <button type="button" disabled={!fees.length} onClick={() => { setSelectedFeeId(fees[0]?.id ?? ""); setPaymentDialogOpen(true); setLocalMessage(""); }} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Record Payment Preview</button>
          </div>
          <div className="grid gap-2 border-b border-[var(--border)] p-4 sm:grid-cols-3">
            <label className="relative"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 muted" /><input value={financeSearch} onChange={(event) => setFinanceSearch(event.target.value)} placeholder="Search student or fee" className="field pl-9" /></label>
            <select value={financeStudent} onChange={(event) => setFinanceStudent(event.target.value)} className="field"><option value="All">All students</option>{Object.values(students).map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select>
            <select value={financeStatus} onChange={(event) => setFinanceStatus(event.target.value)} className="field"><option value="All">All statuses</option>{[...new Set(fees.map((fee) => fee.status))].map((status) => <option key={status} value={status}>{status}</option>)}</select>
          </div>
          {loading ? <p className="p-5 text-sm muted">Loading fee records…</p> : fees.length === 0 ? <p className="p-5 text-sm muted">No fee records found.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Fee</th><th className="p-3">Period</th><th className="p-3">Amount</th><th className="p-3">Paid</th><th className="p-3">Balance</th><th className="p-3">Due</th><th className="p-3">Status</th></tr></thead>
                <tbody className="divide-y divide-[var(--border)]">{filteredFees.map((fee) => {
                  const due = Number(fee.amount) - Number(fee.discount) + Number(fee.late_fee);
                  const paid = paidByFee.get(fee.id) ?? 0;
                  const student = students[fee.student_id];
                  return <tr key={fee.id}>
                    <td className="p-3 font-semibold">{student?.name ?? "Student"}<span className="block text-xs muted">{student?.admission_no ?? ""}</span></td>
                    <td className="p-3">{fee.fee_structure_id ? structures[fee.fee_structure_id] ?? "Fee" : "Fee"}</td>
                    <td className="p-3">{fee.billing_period ?? "—"}</td>
                    <td className="p-3">{money(due)}</td><td className="p-3">{money(paid)}</td><td className="p-3">{money(Math.max(0, due - paid))}</td><td className="p-3">{fee.due_date ?? "—"}</td><td className="p-3 capitalize">{fee.status.replaceAll("_", " ")}</td>
                  </tr>;
                })}{!filteredFees.length && <tr><td className="p-5 text-sm muted" colSpan={8}>No fee records match the selected filters.</td></tr>}</tbody>
              </table>
            </div>
          )}
        </section>
        </>
      )}

      {mode === "invoices" && (
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
            <h2 className="flex items-center gap-2 font-bold"><ReceiptText size={17} />Invoices &amp; Receipts</h2>
            <div className="flex gap-1 rounded-xl border border-[var(--border)] p-1">
              <button type="button" onClick={() => setInvoiceTab("invoices")} className={`rounded-lg px-3 py-1.5 text-sm ${invoiceTab === "invoices" ? "bg-blue-600 text-white" : "muted"}`}>Invoices</button>
              <button type="button" onClick={() => setInvoiceTab("receipts")} className={`rounded-lg px-3 py-1.5 text-sm ${invoiceTab === "receipts" ? "bg-blue-600 text-white" : "muted"}`}>Receipts</button>
            </div>
          </div>
          <div className="grid gap-2 border-b border-[var(--border)] p-4 sm:grid-cols-2 lg:grid-cols-4">
            <label className="relative"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 muted" /><input value={financeSearch} onChange={(event) => setFinanceSearch(event.target.value)} placeholder={`Search ${invoiceTab}`} className="field pl-9" /></label>
            <label className="space-y-1.5 text-xs font-semibold muted">Payment month<input type="month" value={financeMonth} onChange={(event) => setFinanceMonth(event.target.value)} className="field mt-1 text-sm" /></label>
            <select value={financeStudent} onChange={(event) => setFinanceStudent(event.target.value)} className="field"><option value="All">All students</option>{Object.values(students).map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select>
            <select value={financeStatus} onChange={(event) => setFinanceStatus(event.target.value)} className="field"><option value="All">All statuses</option>{[...new Set((invoiceTab === "invoices" ? fees.map((fee) => fee.status) : payments.map((payment) => payment.status)))].map((status) => <option key={status} value={status}>{status}</option>)}</select>
          </div>
          {loading ? <p className="p-5 text-sm muted">Loading {invoiceTab}…</p> : invoiceTab === "invoices" ? filteredInvoices.length === 0 ? <p className="p-5 text-sm muted">No invoices match the selected filters.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[740px] text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Fee</th><th className="p-3">Period</th><th className="p-3">Total</th><th className="p-3">Paid</th><th className="p-3">Pending</th><th className="p-3">Due</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead>
                <tbody className="divide-y divide-[var(--border)]">{filteredInvoices.map((fee) => {
                  const total = Number(fee.amount) - Number(fee.discount) + Number(fee.late_fee);
                  const paid = paidByFee.get(fee.id) ?? 0;
                  return <tr key={fee.id}>
                    <td className="p-3 font-semibold">{students[fee.student_id]?.name ?? "Student"}<span className="block text-xs muted">{students[fee.student_id]?.admission_no ?? ""}</span></td>
                    <td className="p-3">{structures[fee.fee_structure_id ?? ""] ?? "Fee"}</td><td className="p-3">{fee.billing_period ?? "—"}</td>
                    <td className="p-3">{money(total)}</td><td className="p-3">{money(paid)}</td><td className="p-3">{money(Math.max(0, total - paid))}</td><td className="p-3">{fee.due_date ?? "—"}</td><td className="p-3 capitalize">{fee.status}</td>
                    <td className="p-3"><div className="flex gap-1"><button type="button" onClick={() => setSelectedInvoice(fee)} aria-label="View invoice" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Eye size={15} /></button><button type="button" onClick={() => window.print()} aria-label="Print invoice" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Printer size={15} /></button><button type="button" onClick={() => downloadInvoice(fee)} aria-label="Download invoice preview" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Download size={15} /></button></div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          ) : payments.length === 0 ? <p className="p-5 text-sm muted">No payment receipts found.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Receipt</th><th className="p-3">Student</th><th className="p-3">Date</th><th className="p-3">Method</th><th className="p-3">Amount</th><th className="p-3">Status</th><th className="p-3 text-right">Actions</th></tr></thead>
                <tbody className="divide-y divide-[var(--border)]">{filteredPayments.map((payment) => <tr key={payment.id}>
                  <td className="p-3 font-semibold">{payment.receipt_no}</td>
                  <td className="p-3">{students[payment.student_id]?.name ?? "Student"}<span className="block text-xs muted">{students[payment.student_id]?.admission_no ?? ""}</span></td>
                  <td className="p-3">{payment.paid_at ? new Date(payment.paid_at).toLocaleString() : "—"}</td>
                  <td className="p-3 capitalize">{payment.payment_method.replaceAll("_", " ")}</td>
                  <td className="p-3">{money(Number(payment.amount))}</td>
                  <td className="p-3 capitalize">{payment.status}</td>
                  <td className="p-3"><div className="flex gap-1">
                    <button type="button" aria-label={`View ${payment.receipt_no}`} onClick={() => setSelectedReceipt(payment)} className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Eye size={15} /></button>
                    <button type="button" aria-label={`Print ${payment.receipt_no}`} onClick={() => window.print()} className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Printer size={15} /></button>
                    <button type="button" aria-label={`Download ${payment.receipt_no} preview`} onClick={() => downloadReceipt(payment)} className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Download size={15} /></button>
                  </div></td>
                </tr>)}{!filteredPayments.length && <tr><td className="p-5 text-sm muted" colSpan={7}>No receipts match the selected filters.</td></tr>}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {mode === "reports" && !loading && <p className="text-sm muted">Figures reflect saved fee records and payments only; no financial records were changed.</p>}
      {loading && mode === "reports" && <p className="text-sm muted">Loading finance totals…</p>}
      {mode === "invoices" && selectedInvoice && <section className="card space-y-3 p-5">
        <div className="flex items-start justify-between"><div><h2 className="font-bold">Invoice detail</h2><p className="mt-1 text-sm muted">School fee record preview</p></div><button type="button" onClick={() => setSelectedInvoice(null)} className="text-sm font-semibold text-blue-600">Close</button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div><p className="text-xs muted">Student</p><p className="font-semibold">{students[selectedInvoice.student_id]?.name ?? "Student"}</p></div>
          <div><p className="text-xs muted">Admission No.</p><p className="font-semibold">{students[selectedInvoice.student_id]?.admission_no ?? "—"}</p></div>
          <div><p className="text-xs muted">Fee</p><p className="font-semibold">{structures[selectedInvoice.fee_structure_id ?? ""] ?? "Fee"}</p></div>
          <div><p className="text-xs muted">Subtotal</p><p className="font-semibold">{money(Number(selectedInvoice.amount))}</p></div>
          <div><p className="text-xs muted">Discount</p><p className="font-semibold">{money(Number(selectedInvoice.discount))}</p></div>
          <div><p className="text-xs muted">Late Fee</p><p className="font-semibold">{money(Number(selectedInvoice.late_fee))}</p></div>
          <div><p className="text-xs muted">Paid</p><p className="font-semibold">{money(paidByFee.get(selectedInvoice.id) ?? 0)}</p></div>
          <div><p className="text-xs muted">Pending</p><p className="font-semibold">{money(Math.max(0, Number(selectedInvoice.amount) - Number(selectedInvoice.discount) + Number(selectedInvoice.late_fee) - (paidByFee.get(selectedInvoice.id) ?? 0)))}</p></div>
          <div><p className="text-xs muted">Total</p><p className="font-semibold">{money(Number(selectedInvoice.amount) - Number(selectedInvoice.discount) + Number(selectedInvoice.late_fee))}</p></div>
        </div>
      </section>}
      {mode === "invoices" && selectedReceipt && <section className="card space-y-3 p-5">
        <div className="flex items-start justify-between"><div><h2 className="font-bold">Receipt {selectedReceipt.receipt_no}</h2><p className="mt-1 text-sm muted">School payment record</p></div><button type="button" onClick={() => setSelectedReceipt(null)} className="text-sm font-semibold text-blue-600">Close</button></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><p className="text-xs muted">Student</p><p className="font-semibold">{students[selectedReceipt.student_id]?.name ?? "Student"}</p></div>
          <div><p className="text-xs muted">Admission No.</p><p className="font-semibold">{students[selectedReceipt.student_id]?.admission_no ?? "—"}</p></div>
          <div><p className="text-xs muted">Amount</p><p className="font-semibold">{money(Number(selectedReceipt.amount))}</p></div>
          <div><p className="text-xs muted">Payment date</p><p className="font-semibold">{selectedReceipt.paid_at ? new Date(selectedReceipt.paid_at).toLocaleString() : "—"}</p></div>
          <div><p className="text-xs muted">Method</p><p className="font-semibold capitalize">{selectedReceipt.payment_method.replaceAll("_", " ")}</p></div>
          <div><p className="text-xs muted">Status</p><p className="font-semibold capitalize">{selectedReceipt.status}</p></div>
        </div>
      </section>}
      {paymentDialogOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4">
        <form onSubmit={previewPayment} className="w-full max-w-lg space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl">
          <div><h2 className="text-lg font-bold">Record Payment Preview</h2><p className="mt-1 text-sm muted">This is a UI-only preview; no financial record will be saved.</p></div>
          <label className="block space-y-1.5 text-sm font-medium">Student fee record<select required value={selectedFeeId} onChange={(event) => setSelectedFeeId(event.target.value)} className="field">{fees.map((fee) => <option key={fee.id} value={fee.id}>{students[fee.student_id]?.name ?? "Student"} · {structures[fee.fee_structure_id ?? ""] ?? "Fee"} · balance {money(Math.max(0, Number(fee.amount) - Number(fee.discount) + Number(fee.late_fee) - (paidByFee.get(fee.id) ?? 0)))}</option>)}</select></label>
          <label className="block space-y-1.5 text-sm font-medium">Amount<input required type="number" min="0.01" step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="field" /></label>
          <label className="block space-y-1.5 text-sm font-medium">Payment Method<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} className="field"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank Transfer</option><option value="card">Card</option><option value="cheque">Cheque</option></select></label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setPaymentDialogOpen(false)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold">Cancel</button><button className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white">Preview only</button></div>
        </form>
      </div>}
    </div>
  );
}
