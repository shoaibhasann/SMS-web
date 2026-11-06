"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { BadgeIndianRupee, Download, Eye, Printer, ReceiptText, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { readPages } from "@/lib/attendance/repository";
import { schoolDate } from "@/lib/attendance/types";
import { CashierDayClose } from "@/components/admin/cashier-day-close";
import { FeeBatchWorkspace } from "@/components/finance/fee-batch-workspace";
import { FeeLedgerWorkspace } from "@/components/finance/fee-ledger";
import { feeMoney, formatFeeBillingPeriod, formatFeeMoney, type FeeLedgerRow } from "@/lib/finance/fee-batches";
import { FeeChangeWorkspace } from "@/components/finance/fee-change-workspace";
import { getOfficeFinanceSummary, loadOfficeFeePositions, loadOfficeFeeReceipts, type OfficeFeeReceipt, type OfficeFinanceSummary } from "@/lib/finance/fee-changes";
import { manualPaymentMethods as paymentMethods, manualPaymentLabel as paymentLabel } from "@/lib/finance/payment-methods";
import { LoadingState, Skeleton } from "@/components/ui/skeleton";

type FeeRecord = FeeLedgerRow & { id: string };
type PaymentRecord = OfficeFeeReceipt;

type Student = { id: string; name: string; admission_no: string };
type FeeStructure = { id: string; name: string };
type FeeStructureRecord = FeeStructure & { amount: number; frequency: string; academic_year_id: string; class_id: string | null };
type DemandStudent = Student & { enrollments: { class_id: string }[] };
type PaymentAttempt = { requestId: string; feeId: string; amount: string; method: string; reference: string };
type OfficeReceipt = { payment_id: string; receipt_no: string };

function readPaymentAttempt(key: string): PaymentAttempt | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (saved && ["requestId", "feeId", "amount", "method", "reference"].every((field) => typeof saved[field] === "string")) {
      return saved as PaymentAttempt;
    }
  } catch {
    // This browser may block session storage.
  }
  return null;
}

function savePaymentAttempt(key: string, attempt: PaymentAttempt | null) {
  try {
    if (attempt) sessionStorage.setItem(key, JSON.stringify(attempt));
    else sessionStorage.removeItem(key);
  } catch {
    // The current page keeps the same request ID when session storage is unavailable.
  }
}

function paise(value: string) {
  const canonical = feeMoney(value), negative = canonical.startsWith("-");
  const amount = BigInt(canonical.replace(/^-/, "").replace(".", ""));
  return negative ? -amount : amount;
}

function feeBalance(fee: FeeRecord) {
  return fee.balance;
}

function paymentDay(value: string | null) {
  return value ? schoolDate(new Date(value)) : "";
}

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

function money(value: string | number | null | undefined) {
  return value === undefined ? "—" : value === null ? "Review required" : formatFeeMoney(value);
}

function ReceiptStatus({ payment }: { payment: PaymentRecord }) {
  return <div className="space-y-1"><span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold capitalize ${payment.status === "reversed" ? "bg-amber-500/10 text-amber-900 dark:text-amber-200" : "bg-[var(--surface-2)]"}`}>{payment.status.replaceAll("_", " ")}</span>{payment.reversed_at && <p className="text-xs muted">Reversed {new Date(payment.reversed_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })} IST</p>}{payment.reversal_reference && <p className="max-w-52 break-all text-xs muted">{payment.reversal_reference}</p>}</div>;
}

export function AdminFinanceWorkspace({ mode, initialReceiptNo = "" }: { mode: "fees" | "invoices" | "reports"; initialReceiptNo?: string }) {
  const [supabase] = useState(createClient);
  const latestRequest = useRef(0);
  const mounted = useRef(true);
  const [schoolId, setSchoolId] = useState("");
  const [userId, setUserId] = useState("");
  const resolvedUser = useRef("");
  const [canReviewChanges, setCanReviewChanges] = useState(false);
  const [feeChangeBusy, setFeeChangeBusy] = useState(false);
  const [financeSummary, setFinanceSummary] = useState<OfficeFinanceSummary>();
  const [paymentStorageKey, setPaymentStorageKey] = useState("");
  const [currentYearId, setCurrentYearId] = useState("");
  const [fees, setFees] = useState<FeeRecord[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [students, setStudents] = useState<Record<string, Student>>({});
  const [structureRows, setStructureRows] = useState<FeeStructureRecord[]>([]);
  const [structureName, setStructureName] = useState("Tuition Fee");
  const [structureFrequency, setStructureFrequency] = useState("monthly");
  const [structureAmount, setStructureAmount] = useState("");
  const [demandStudents, setDemandStudents] = useState<DemandStudent[]>([]);
  const [demandStudentId, setDemandStudentId] = useState("");
  const [demandStructureId, setDemandStructureId] = useState("");
  const [billingPeriod, setBillingPeriod] = useState(() => schoolDate().slice(0, 7));
  const [demandDueDate, setDemandDueDate] = useState("");
  const [demandSaving, setDemandSaving] = useState(false);
  const demandInFlight = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [selectedFeeId, setSelectedFeeId] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [paymentReference, setPaymentReference] = useState("");
  const [paymentAttempt, setPaymentAttempt] = useState<PaymentAttempt | null>(null);
  const pendingPayment = useRef<{ key: string; attempt: PaymentAttempt } | null>(null);
  const [paymentSaving, setPaymentSaving] = useState(false);
  const paymentInFlight = useRef(false);
  const [paymentError, setPaymentError] = useState("");
  const [savedReceipt, setSavedReceipt] = useState<OfficeReceipt | null>(null);
  const [localMessage, setLocalMessage] = useState("");
  const [selectedReceipt, setSelectedReceipt] = useState<PaymentRecord | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<FeeRecord | null>(null);
  const [invoiceTab, setInvoiceTab] = useState<"invoices" | "receipts">(initialReceiptNo ? "receipts" : "invoices");
  const [financeSearch, setFinanceSearch] = useState(initialReceiptNo);
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
        resolvedUser.current = auth.user.id;
        const { data: roles, error: rolesError } = await supabase
          .from("user_roles")
          .select("role,school_id")
          .eq("user_id", auth.user.id);
        if (rolesError) throw rolesError;

        let schoolId = (roles ?? []).find((row) =>
          row.role === "school_admin" && row.school_id,
        )?.school_id ?? (roles ?? []).find((row) =>
          ["accountant", "principal"].includes(row.role) && row.school_id,
        )?.school_id ?? "";
        if (!schoolId && (roles ?? []).some((row) => row.role === "super_admin" && row.school_id === null)) {
          const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("school_id")
            .eq("id", auth.user.id)
            .maybeSingle();
          if (profileError) throw profileError;
          schoolId = profile?.school_id ?? "";
        }
        if (!schoolId) throw new Error("Choose a school-linked finance account to view finance records.");

        const [feeRows, paymentRows, loadedStructures, yearResult, summary] = await Promise.all([
          loadOfficeFeePositions(supabase, schoolId),
          loadOfficeFeeReceipts(supabase, schoolId),
          readPages<FeeStructureRecord>((from, to) => supabase.from("fee_structures")
            .select("id,name,amount,frequency,academic_year_id,class_id", { count: "exact" })
            .eq("school_id", schoolId).order("name").order("id").range(from, to), "Fee structures"),
          supabase.from("academic_years").select("id").eq("school_id", schoolId).eq("is_current", true).maybeSingle(),
          getOfficeFinanceSummary(supabase, schoolId),
        ]);
        if (yearResult.error) throw yearResult.error;
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

        const activeYearId = yearResult.data?.id ?? "";
        const roster = mode === "fees" && activeYearId
          ? await readPages((from, to) => supabase.from("students")
            .select("id,first_name,middle_name,last_name,admission_no,enrollments!inner(class_id)", { count: "exact" })
            .eq("school_id", schoolId).eq("status", "active")
            .eq("enrollments.academic_year_id", activeYearId).eq("enrollments.status", "active")
            .order("first_name").order("id").range(from, to), "Active enrolled students")
          : [];

        if (!isCurrent()) return;
        const key = `kids-corner-office-fees:${auth.user.id}:${schoolId}`;
        setSchoolId(schoolId);
        setUserId(auth.user.id);
        resolvedUser.current = auth.user.id;
        setCanReviewChanges((roles ?? []).some((row) => (["school_admin", "principal"].includes(row.role) && row.school_id === schoolId)
          || (row.role === "super_admin" && row.school_id === null)));
        setFinanceSummary(summary);
        setPaymentStorageKey(key);
        setPaymentAttempt(pendingPayment.current?.key === key ? pendingPayment.current.attempt : readPaymentAttempt(key));
        const mappedFees = feeRows.map((fee) => ({ ...fee, id: fee.demand_id }));
        setFees(mappedFees);
        setPayments(paymentRows);
        setSelectedReceipt((selected) => selected ? paymentRows.find((payment) => payment.id === selected.id) ?? null : null);
        setSelectedInvoice((selected) => selected ? mappedFees.find((fee) => fee.id === selected.id) ?? null : null);
        setStructureRows(loadedStructures);
        setCurrentYearId(activeYearId);
        setStudents(Object.fromEntries(studentRows.map((student) => [
          student.id,
          {
            id: student.id,
            name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
            admission_no: student.admission_no,
          },
        ])));
        setDemandStudents(roster.map((student) => ({
          id: student.id,
          name: [student.first_name, student.middle_name, student.last_name].filter(Boolean).join(" "),
          admission_no: student.admission_no,
          enrollments: student.enrollments,
        })));

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
  }, [mode, supabase]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted.current || !resolvedUser.current || session?.user.id === resolvedUser.current) return;
      latestRequest.current += 1; resolvedUser.current = "";
      setSchoolId(""); setUserId(""); setFees([]); setPayments([]); setStudents({}); setStructureRows([]); setFinanceSummary(undefined);
      setCurrentYearId(""); setDemandStudents([]); setDemandStudentId(""); setDemandStructureId(""); setPaymentStorageKey(""); setPaymentAttempt(null); setCanReviewChanges(false);
      setSelectedInvoice(null); setSelectedReceipt(null); setPaymentDialogOpen(false); setSavedReceipt(null);
      setError("Your sign-in changed. Reload this finance page to verify school access."); setLoading(false);
    });
    return () => { mounted.current = false; latestRequest.current += 1; subscription.unsubscribe(); };
  }, [load, supabase]);

  const payableFees = fees.filter((fee) =>
    ["pending", "partial"].includes(fee.status) && fee.financial_token && fee.balance !== null && paise(fee.balance) > BigInt(0),
  );
  const demandStudent = demandStudents.find((student) => student.id === demandStudentId);
  const demandStructures = structureRows.filter((structure) => structure.academic_year_id === currentYearId
    && Number(structure.amount) > 0
    && (!structure.class_id || demandStudent?.enrollments.some((enrollment) => enrollment.class_id === structure.class_id)));
  const totalCollected = financeSummary?.collections.net_amount;
  const outstanding = financeSummary?.balance;
  const collectedThisMonth = financeSummary?.collections.month_net;
  const collectedToday = financeSummary?.collections.today_net;
  const pendingFeeCount = financeSummary?.pending_count ?? "—";
  const overdueFeeCount = financeSummary?.overdue_count ?? "—";
  const filteredFees = fees.filter((fee) =>
    (financeStatus === "All" || fee.status === financeStatus) &&
    (financeStudent === "All" || fee.student_id === financeStudent) &&
    `${students[fee.student_id]?.name ?? ""} ${students[fee.student_id]?.admission_no ?? ""} ${fee.fee_name}`.toLowerCase().includes(financeSearch.toLowerCase()),
  );
  const filteredPayments = payments.filter((payment) =>
    (financeStatus === "All" || payment.status === financeStatus) &&
    (financeStudent === "All" || payment.student_id === financeStudent) &&
    (!financeMonth || paymentDay(payment.paid_at).startsWith(financeMonth)) &&
    `${payment.receipt_no} ${students[payment.student_id]?.name ?? ""} ${students[payment.student_id]?.admission_no ?? ""}`.toLowerCase().includes(financeSearch.toLowerCase()),
  );
  const filteredInvoices = fees.filter((fee) =>
    (financeStatus === "All" || fee.status === financeStatus) &&
    (financeStudent === "All" || fee.student_id === financeStudent) &&
    `${students[fee.student_id]?.name ?? ""} ${students[fee.student_id]?.admission_no ?? ""} ${fee.fee_name}`.toLowerCase().includes(financeSearch.toLowerCase()),
  );

  function openPayment() {
    const attempt = paymentAttempt;
    setSelectedFeeId(attempt?.feeId ?? payableFees[0]?.id ?? "");
    setPaymentAmount(attempt?.amount ?? "");
    setPaymentMethod(attempt?.method ?? "cash");
    setPaymentReference(attempt?.reference ?? "");
    setPaymentError("");
    setPaymentDialogOpen(true);
  }

  async function recordPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !paymentStorageKey || paymentInFlight.current || feeChangeBusy) return;

    if (!paymentAttempt) {
      const fee = payableFees.find((row) => row.id === selectedFeeId);
      if (!fee || !/^\d{1,10}(?:\.\d{1,2})?$/.test(paymentAmount) || paise(paymentAmount) <= BigInt(0)) {
        setPaymentError("Choose an open fee and enter a positive amount with up to two decimal places.");
        return;
      }
      if (fee.balance === null || paise(paymentAmount) > paise(fee.balance)) {
        setPaymentError("The amount exceeds the displayed balance. Refresh the fee records.");
        return;
      }
    }
    const attempt = paymentAttempt ?? {
      requestId: crypto.randomUUID(),
      feeId: selectedFeeId,
      amount: paymentAmount,
      method: paymentMethod,
      reference: paymentMethod === "cash" ? "" : paymentReference.trim(),
    };
    paymentInFlight.current = true;
    pendingPayment.current = { key: paymentStorageKey, attempt };
    savePaymentAttempt(paymentStorageKey, attempt);
    setPaymentAttempt(attempt);
    setPaymentSaving(true);
    setPaymentError("");
    setSavedReceipt(null);

    try {
      const { data: { user: currentUser }, error: authError } = await supabase.auth.getUser();
      if (authError || currentUser?.id !== userId || resolvedUser.current !== userId) return;
      const { data, error: saveError } = await supabase.rpc("record_office_fee_payment", {
        p_school_id: schoolId,
        p_student_fee_id: attempt.feeId,
        p_amount: attempt.amount,
        p_payment_method: attempt.method,
        p_request_id: attempt.requestId,
        p_reference: attempt.reference || null,
      });
      if (saveError) {
        if (["22023", "23505", "42501"].includes(saveError.code)) {
          pendingPayment.current = null;
          savePaymentAttempt(paymentStorageKey, null);
          if (mounted.current) {
            setPaymentAttempt(null);
            setPaymentError(saveError.message);
          }
          return;
        }
        throw saveError;
      }
      if (!data || typeof data.payment_id !== "string" || typeof data.receipt_no !== "string") {
        throw new Error("The server did not return a receipt.");
      }
      pendingPayment.current = null;
      savePaymentAttempt(paymentStorageKey, null);
      if (!mounted.current || resolvedUser.current !== userId) return;
      setPaymentAttempt(null);
      setSavedReceipt(data);
      setPaymentDialogOpen(false);
      await load();
    } catch {
      if (mounted.current) setPaymentError("The result could not be confirmed. Retry this same request to recover the receipt.");
    } finally {
      paymentInFlight.current = false;
      if (mounted.current) setPaymentSaving(false);
    }
  }

  async function issueDemand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schoolId || !demandStudentId || !demandStructureId || !billingPeriod || demandInFlight.current || feeChangeBusy) return;
    demandInFlight.current = true;
    setDemandSaving(true);
    setError("");
    setLocalMessage("");
    try {
      const { data, error: demandError } = await supabase.rpc("issue_office_fee_demand", {
        p_school_id: schoolId,
        p_student_id: demandStudentId,
        p_fee_structure_id: demandStructureId,
        p_billing_period: billingPeriod,
        p_due_date: demandDueDate || null,
      });
      if (!mounted.current) return;
      if (demandError || typeof data !== "string") {
        setError(demandError && ["22023", "23505", "42501"].includes(demandError.code)
          ? demandError.message : "The demand could not be confirmed. Retry with the same details.");
        return;
      }
      setLocalMessage("Fee demand ready for collection.");
      await load();
    } catch {
      if (mounted.current) setError("The demand could not be confirmed. Retry with the same details.");
    } finally {
      demandInFlight.current = false;
      if (mounted.current) setDemandSaving(false);
    }
  }

  function downloadReceipt(payment: PaymentRecord) {
    const student = students[payment.student_id];
    const blob = new Blob([JSON.stringify({
      receipt: payment.receipt_no,
      student: student?.name ?? "Student",
      admissionNumber: student?.admission_no ?? "",
      amount: payment.amount,
      creditedAmount: payment.net_amount,
      reversedAmount: payment.reversed_amount,
      reversedAt: payment.reversed_at,
      reversalReference: payment.reversal_reference,
      paymentMethod: payment.payment_method,
      paidAt: payment.paid_at,
      status: payment.status,
      recordedStatus: payment.recorded_status,
    }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${payment.receipt_no}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadInvoice(fee: FeeRecord) {
    const invoice = {
      school: "School invoice preview",
      student: students[fee.student_id]?.name ?? "Student",
      admissionNumber: students[fee.student_id]?.admission_no ?? "",
      fee: fee.fee_name,
      billingPeriod: formatFeeBillingPeriod(fee.billing_period),
      subtotal: fee.amount,
      discount: fee.discount,
      lateFee: fee.late_fee,
      baseNetAmount: fee.base_net_amount,
      approvedAdjustments: fee.adjustment_amount,
      paid: fee.paid_amount,
      grossPaidAmount: fee.gross_paid_amount,
      reversedAmount: fee.reversed_amount,
      pending: fee.balance,
      total: fee.net_amount,
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
    if (!schoolId || !currentYearId || !structureName.trim() || !Number(structureAmount) || feeChangeBusy) return;
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
        <div className="flex flex-wrap gap-2">
        <Link href="/modules/advance-credit" className="inline-flex min-h-11 items-center rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-[var(--surface-2)] dark:text-blue-300">Advance credit</Link>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold hover:bg-[var(--surface-2)]">
          <RefreshCw size={16} /> Refresh
        </button>
        </div>
      </header>

      {error && <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {financeSummary && financeSummary.invalid_count > 0 && <p role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-900 dark:text-amber-200">{financeSummary.invalid_count} financial records need reconciliation. Overall totals are unavailable; flagged fees cannot be paid or changed.</p>}
      {localMessage && <div role="status" className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4 text-sm text-sky-800 dark:text-sky-200">{localMessage}</div>}
      {savedReceipt && <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 text-sm">
        <span>Payment saved. Receipt <strong className="break-all">{savedReceipt.receipt_no}</strong></span>
        <Link href={`/modules/invoices?receipt=${encodeURIComponent(savedReceipt.receipt_no)}`} className="font-semibold text-blue-600 underline">View receipt</Link>
      </div>}

      {mode === "reports" && (
        <>
        {schoolId && <CashierDayClose key={`${userId}:${schoolId}`} schoolId={schoolId} client={supabase} />}
        {schoolId && userId && <FeeLedgerWorkspace key={`${userId}:${schoolId}:${currentYearId}`} client={supabase} schoolId={schoolId} academicYearId={currentYearId} />}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="card p-5"><div className="flex items-center gap-2 text-sm muted"><BadgeIndianRupee size={16} /> Net recorded collections</div><div className="mt-2 text-2xl font-black">{loading ? <Skeleton className="h-8 w-28" /> : money(totalCollected)}</div>{!loading && <p className="mt-2 text-xs muted">Gross money received {money(financeSummary?.collections.gross_amount)} · Reversals {money(financeSummary?.collections.reversal_amount)}{financeSummary?.collections.refund_amount !== undefined && ` · Offline refunds ${money(financeSummary.collections.refund_amount)}`}</p>}</div>
          <div className="card p-5"><div className="text-sm muted">Net collections this month</div><div className="mt-2 text-2xl font-black">{loading ? <Skeleton className="h-8 w-28" /> : money(collectedThisMonth)}</div></div>
          <div className="card p-5"><div className="text-sm muted">Outstanding balance</div><div className="mt-2 text-2xl font-black">{loading ? <Skeleton className="h-8 w-28" /> : money(outstanding)}</div></div>
        </div>
        <p className="text-xs muted">Collections include fee payments and money received as advance credit, less entry corrections and completed offline refunds. Applying stored credit and reserving a refund do not receive or send money. Original receipts and past closed-day snapshots remain available.</p>
        {financeSummary?.advance && <section aria-label="School advance credit totals" className="card space-y-3 p-5"><h2 className="font-bold">Advance credit and offline refunds</h2><dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[["Available student credit", financeSummary.advance.available_amount], ["Reserved for unpaid refunds", financeSummary.advance.reserved_amount], ["Offline refunds paid", financeSummary.collections.refund_amount], ["Offline refunds paid today", financeSummary.collections.today_refund]].map(([label, value]) => <div key={label}><dt className="text-xs muted">{label}</dt><dd className="mt-1 text-lg font-bold tabular-nums">{money(value)}</dd></div>)}</dl><p className="text-xs muted">Student credit is separate from outstanding fees until applied. <Link href="/modules/advance-credit" className="font-semibold text-blue-700 underline dark:text-blue-300">Open advance credit</Link></p></section>}
        <div>
          <section className="card overflow-hidden">
            <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="font-bold">Student-wise dues</h2></div>
            <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm">
              <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Fee</th><th className="p-3">Total</th><th className="p-3">Paid</th><th className="p-3">Pending</th></tr></thead>
              <tbody className="divide-y divide-[var(--border)]">{loading ? <tr><td colSpan={5} className="p-5"><LoadingState variant="table" label="Loading student fee balances…" /></td></tr> : <>{fees.slice(0, 20).map((fee) => <tr key={fee.id}><td className="p-3 font-semibold">{students[fee.student_id]?.name ?? fee.student_name}</td><td className="p-3">{fee.fee_name}</td><td className="p-3">{money(fee.net_amount)}</td><td className="p-3">{money(fee.paid_amount)}</td><td className="p-3">{money(fee.balance)}</td></tr>)}{!fees.length && <tr><td colSpan={5} className="p-5 text-sm muted">No fee balances recorded.</td></tr>}</>}</tbody>
            </table></div>
          </section>
        </div>
        <section className="card overflow-hidden">
          <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="font-bold">Payment history</h2></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm">
            <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Date</th><th className="p-3">Receipt</th><th className="p-3">Student</th><th className="p-3">Method</th><th className="p-3">Original amount</th><th className="p-3">Credited amount</th><th className="p-3">Status</th></tr></thead>
            <tbody className="divide-y divide-[var(--border)]">{loading ? <tr><td colSpan={7} className="p-5"><LoadingState variant="table" label="Loading payment history…" /></td></tr> : <>{payments.slice(0, 20).map((payment) => <tr key={payment.id}><td className="p-3">{paymentDay(payment.paid_at) || "—"}</td><td className="p-3">{payment.receipt_no}</td><td className="p-3">{students[payment.student_id]?.name ?? "Student"}</td><td className="p-3 capitalize">{paymentLabel(payment.payment_method)}</td><td className="p-3">{money(payment.amount)}</td><td className="p-3">{money(payment.net_amount)}</td><td className="p-3"><ReceiptStatus payment={payment} /></td></tr>)}
              {!payments.length && <tr><td colSpan={7} className="p-5 text-sm muted">No payment history available.</td></tr>}</>}
            </tbody>
          </table></div>
        </section>
        </>
      )}

      {mode === "fees" && (
        <>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[["Today's net collections", money(collectedToday)], ["Monthly net collections", money(collectedThisMonth)], ["Pending Fees", pendingFeeCount], ["Overdue Fees", overdueFeeCount]].map(([label, value]) => <article key={String(label)} className="card p-4"><p className="text-xs font-semibold muted">{label}</p><p className="mt-2 text-2xl font-black">{loading ? <Skeleton className="h-8 w-24" /> : value}</p></article>)}
        </div>
        <section className="card p-5">
          <h2 className="font-bold">Fee structures</h2>
          <form onSubmit={createFeeStructure} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1.5 text-sm font-medium">Fee Category<select value={structureName} onChange={(event) => setStructureName(event.target.value)} className="field">{["Admission Fee", "Tuition Fee", "Annual Fee", "Transport", "Other"].map((item) => <option key={item}>{item}</option>)}</select></label>
            <label className="space-y-1.5 text-sm font-medium">Frequency<select value={structureFrequency} onChange={(event) => setStructureFrequency(event.target.value)} className="field"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="half_yearly">Half-yearly</option><option value="yearly">Yearly</option><option value="custom">Custom</option></select></label>
            <label className="space-y-1.5 text-sm font-medium">Amount<input required type="number" min="0.01" step="0.01" value={structureAmount} onChange={(event) => setStructureAmount(event.target.value)} className="field" /></label>
            <button disabled={!currentYearId || feeChangeBusy} className="self-end rounded-xl bg-blue-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50">Add Fee Structure</button>
          </form>
          {!loading && !currentYearId && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">A current academic year is required to add fee structures.</p>}
          <div className="mt-4 flex flex-wrap gap-2">{structureRows.filter((structure) => Number(structure.amount) > 0).map((structure) => <span key={structure.id} className="rounded-full bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium">{structure.name} · {structure.frequency} · {money(Number(structure.amount))}</span>)}</div>
        </section>
        {schoolId && userId && currentYearId && <FeeBatchWorkspace client={supabase} schoolId={schoolId} userId={userId} academicYearId={currentYearId}
          structures={structureRows} disabled={loading || paymentSaving || demandSaving || feeChangeBusy} onPosted={() => { void load(); }} />}
        {schoolId && userId && <FeeChangeWorkspace client={supabase} schoolId={schoolId} userId={userId} canReview={canReviewChanges}
          demands={fees} payments={payments} disabled={loading || paymentSaving || demandSaving} onBusyChange={setFeeChangeBusy} onChanged={() => { void load(); }} />}
        <section className="card space-y-4 p-5">
          <div>
            <h2 className="font-bold">Issue a fee demand</h2>
            <p className="mt-1 text-sm muted">Assign a current-year fee structure to one enrolled student for a billing month.</p>
          </div>
          <form onSubmit={issueDemand} className="space-y-3">
            <fieldset disabled={loading || demandSaving || feeChangeBusy} className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1.5 text-sm font-medium">Enrolled student
                <select required value={demandStudentId} onChange={(event) => {
                  setDemandStudentId(event.target.value);
                  setDemandStructureId("");
                }} className="field">
                  <option value="">Choose student</option>
                  {demandStudents.map((student) => <option key={student.id} value={student.id}>{student.name} · {student.admission_no}</option>)}
                </select>
              </label>
              <label className="space-y-1.5 text-sm font-medium">Fee structure
                <select required value={demandStructureId} onChange={(event) => setDemandStructureId(event.target.value)} className="field">
                  <option value="">Choose structure</option>
                  {demandStructures.map((structure) => <option key={structure.id} value={structure.id}>{structure.name} · {money(Number(structure.amount))}</option>)}
                </select>
              </label>
              <label className="space-y-1.5 text-sm font-medium">Billing month
                <input required type="month" value={billingPeriod} onChange={(event) => setBillingPeriod(event.target.value)} className="field" />
              </label>
              <label className="space-y-1.5 text-sm font-medium">Due date
                <input type="date" value={demandDueDate} onChange={(event) => setDemandDueDate(event.target.value)} className="field" />
              </label>
            </fieldset>
            <button type="submit" disabled={loading || demandSaving || feeChangeBusy || !demandStudentId || !demandStructureId} className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {demandSaving ? "Issuing demand…" : "Issue demand"}
            </button>
          </form>
        </section>
        <section className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4"><h2 className="font-bold">Student fee records</h2>
            <button type="button" disabled={loading || feeChangeBusy || (!payableFees.length && !paymentAttempt)} onClick={openPayment} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {paymentAttempt ? "Resume payment request" : "Record payment"}
            </button>
          </div>
          <div className="grid gap-2 border-b border-[var(--border)] p-4 sm:grid-cols-3">
            <label className="relative"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 muted" /><input value={financeSearch} onChange={(event) => setFinanceSearch(event.target.value)} placeholder="Search student or fee" className="field pl-9" /></label>
            <select value={financeStudent} onChange={(event) => setFinanceStudent(event.target.value)} className="field"><option value="All">All students</option>{Object.values(students).map((student) => <option key={student.id} value={student.id}>{student.name}</option>)}</select>
            <select value={financeStatus} onChange={(event) => setFinanceStatus(event.target.value)} className="field"><option value="All">All statuses</option>{[...new Set(fees.map((fee) => fee.status))].map((status) => <option key={status} value={status}>{status}</option>)}</select>
          </div>
          {loading ? <LoadingState variant="table" className="p-5 text-sm muted">Loading fee records…</LoadingState> : fees.length === 0 ? <p className="p-5 text-sm muted">No fee records found.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[840px] text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Fee</th><th className="p-3">Period</th><th className="p-3">Amount</th><th className="p-3">Paid</th><th className="p-3">Balance</th><th className="p-3">Due</th><th className="p-3">Status</th></tr></thead>
                <tbody className="divide-y divide-[var(--border)]">{filteredFees.map((fee) => {
                  const student = students[fee.student_id];
                  return <tr key={fee.id}>
                    <td className="p-3 font-semibold">{student?.name ?? "Student"}<span className="block text-xs muted">{student?.admission_no ?? ""}</span></td>
                    <td className="p-3">{fee.fee_name}</td>
                    <td className="p-3">{formatFeeBillingPeriod(fee.billing_period)}</td>
                    <td className="p-3">{money(fee.net_amount)}</td><td className="p-3">{money(fee.paid_amount)}</td><td className="p-3">{money(fee.balance)}</td><td className="p-3">{fee.due_date ?? "—"}</td><td className="p-3 capitalize">{fee.status.replaceAll("_", " ")}</td>
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
          {loading ? <LoadingState variant="list" className="p-5 text-sm muted">Loading {invoiceTab}…</LoadingState> : invoiceTab === "invoices" ? filteredInvoices.length === 0 ? <p className="p-5 text-sm muted">No invoices match the selected filters.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[740px] text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Student</th><th className="p-3">Fee</th><th className="p-3">Period</th><th className="p-3">Total</th><th className="p-3">Paid</th><th className="p-3">Pending</th><th className="p-3">Due</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead>
                <tbody className="divide-y divide-[var(--border)]">{filteredInvoices.map((fee) => {
                  return <tr key={fee.id}>
                    <td className="p-3 font-semibold">{students[fee.student_id]?.name ?? "Student"}<span className="block text-xs muted">{students[fee.student_id]?.admission_no ?? ""}</span></td>
                    <td className="p-3">{fee.fee_name}</td><td className="p-3">{formatFeeBillingPeriod(fee.billing_period)}</td>
                    <td className="p-3">{money(fee.net_amount)}</td><td className="p-3">{money(fee.paid_amount)}</td><td className="p-3">{money(fee.balance)}</td><td className="p-3">{fee.due_date ?? "—"}</td><td className="p-3 capitalize">{fee.status.replaceAll("_", " ")}</td>
                    <td className="p-3"><div className="flex gap-1"><button type="button" onClick={() => setSelectedInvoice(fee)} aria-label="View invoice" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Eye size={15} /></button><button type="button" onClick={() => window.print()} aria-label="Print invoice" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Printer size={15} /></button><button type="button" onClick={() => downloadInvoice(fee)} aria-label="Download invoice preview" className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Download size={15} /></button></div></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          ) : payments.length === 0 ? <p className="p-5 text-sm muted">No payment receipts found.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead className="bg-[var(--surface-2)] text-xs uppercase muted"><tr><th className="p-3">Receipt</th><th className="p-3">Student</th><th className="p-3">Date</th><th className="p-3">Method</th><th className="p-3">Original amount</th><th className="p-3">Credited amount</th><th className="p-3">Status</th><th className="p-3 text-right">Actions</th></tr></thead>
                <tbody className="divide-y divide-[var(--border)]">{filteredPayments.map((payment) => <tr key={payment.id}>
                  <td className="p-3 font-semibold">{payment.receipt_no}</td>
                  <td className="p-3">{students[payment.student_id]?.name ?? "Student"}<span className="block text-xs muted">{students[payment.student_id]?.admission_no ?? ""}</span></td>
                  <td className="p-3">{payment.paid_at ? new Date(payment.paid_at).toLocaleString() : "—"}</td>
                  <td className="p-3 capitalize">{paymentLabel(payment.payment_method)}</td>
                  <td className="p-3">{money(payment.amount)}</td>
                  <td className="p-3">{money(payment.net_amount)}</td>
                  <td className="p-3"><ReceiptStatus payment={payment} /></td>
                  <td className="p-3"><div className="flex gap-1">
                    <button type="button" aria-label={`View ${payment.receipt_no}`} onClick={() => setSelectedReceipt(payment)} className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Eye size={15} /></button>
                    <button type="button" aria-label={`Print ${payment.receipt_no}`} onClick={() => window.print()} className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Printer size={15} /></button>
                    <button type="button" aria-label={`Download ${payment.receipt_no}`} onClick={() => downloadReceipt(payment)} className="rounded-lg p-2 hover:bg-[var(--surface-2)]"><Download size={15} /></button>
                  </div></td>
                </tr>)}{!filteredPayments.length && <tr><td className="p-5 text-sm muted" colSpan={8}>No receipts match the selected filters.</td></tr>}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {mode === "reports" && !loading && <p className="text-sm muted">Figures reflect saved fee demands and payments for this school.</p>}
      {loading && mode === "reports" && <LoadingState variant="list" className="text-sm muted">Loading finance totals…</LoadingState>}
      {mode === "invoices" && selectedInvoice && <section className="card space-y-3 p-5">
        <div className="flex items-start justify-between"><div><h2 className="font-bold">Invoice detail</h2><p className="mt-1 text-sm muted">School fee record preview</p></div><button type="button" onClick={() => setSelectedInvoice(null)} className="text-sm font-semibold text-blue-600">Close</button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div><p className="text-xs muted">Student</p><p className="font-semibold">{students[selectedInvoice.student_id]?.name ?? "Student"}</p></div>
          <div><p className="text-xs muted">Admission No.</p><p className="font-semibold">{students[selectedInvoice.student_id]?.admission_no ?? "—"}</p></div>
          <div><p className="text-xs muted">Fee</p><p className="font-semibold">{selectedInvoice.fee_name}</p></div>
          <div><p className="text-xs muted">Original subtotal</p><p className="font-semibold">{money(selectedInvoice.amount)}</p></div>
          <div><p className="text-xs muted">Original discount</p><p className="font-semibold">{money(selectedInvoice.discount)}</p></div>
          <div><p className="text-xs muted">Original late fee</p><p className="font-semibold">{money(selectedInvoice.late_fee)}</p></div>
          <div><p className="text-xs muted">Approved fee changes</p><p className="font-semibold">{money(selectedInvoice.adjustment_amount)}</p></div>
          <div><p className="text-xs muted">Credited payments</p><p className="font-semibold">{money(selectedInvoice.paid_amount)}</p></div>
          <div><p className="text-xs muted">Pending</p><p className="font-semibold">{money(selectedInvoice.balance)}</p></div>
          <div><p className="text-xs muted">Effective total</p><p className="font-semibold">{money(selectedInvoice.net_amount)}</p></div>
        </div>
      </section>}
      {mode === "invoices" && selectedReceipt && <section className="card space-y-3 p-5">
        <div className="flex items-start justify-between"><div><h2 className="font-bold">Receipt {selectedReceipt.receipt_no}</h2><p className="mt-1 text-sm muted">School payment record</p></div><button type="button" onClick={() => setSelectedReceipt(null)} className="text-sm font-semibold text-blue-600">Close</button></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><p className="text-xs muted">Student</p><p className="font-semibold">{students[selectedReceipt.student_id]?.name ?? "Student"}</p></div>
          <div><p className="text-xs muted">Admission No.</p><p className="font-semibold">{students[selectedReceipt.student_id]?.admission_no ?? "—"}</p></div>
          <div><p className="text-xs muted">Original receipt amount</p><p className="font-semibold">{money(selectedReceipt.amount)}</p></div>
          <div><p className="text-xs muted">Credited amount</p><p className="font-semibold">{money(selectedReceipt.net_amount)}</p></div>
          <div><p className="text-xs muted">Reversed amount</p><p className="font-semibold">{money(selectedReceipt.reversed_amount)}</p></div>
          <div><p className="text-xs muted">Payment date</p><p className="font-semibold">{selectedReceipt.paid_at ? new Date(selectedReceipt.paid_at).toLocaleString() : "—"}</p></div>
          <div><p className="text-xs muted">Method</p><p className="font-semibold capitalize">{paymentLabel(selectedReceipt.payment_method)}</p></div>
          <div><p className="text-xs muted">Status</p><ReceiptStatus payment={selectedReceipt} /></div>
        </div>
        {selectedReceipt.status === "reversed" && <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">This corrects a recorded entry; it does not send a bank refund. The original receipt amount remains in the audit history.</p>}
      </section>}
      {paymentDialogOpen && <div role="dialog" aria-modal="true" aria-labelledby="office-payment-title" className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/55 p-4">
        <form onSubmit={recordPayment} className="w-full max-w-lg space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-2xl">
          <div><h2 id="office-payment-title" className="text-lg font-bold">Record payment</h2><p className="mt-1 text-sm muted">Enter a payment already received by the school.</p></div>
          {paymentError && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{paymentError}</p>}
          <fieldset disabled={paymentSaving || Boolean(paymentAttempt)} className="space-y-4">
            <label className="block space-y-1.5 text-sm font-medium">Student fee record
              <select required value={selectedFeeId} onChange={(event) => setSelectedFeeId(event.target.value)} className="field">
                {paymentAttempt && !payableFees.some((fee) => fee.id === paymentAttempt.feeId) && <option value={paymentAttempt.feeId}>Previous payment request</option>}
                {payableFees.map((fee) => <option key={fee.id} value={fee.id}>{students[fee.student_id]?.name ?? fee.student_name} · {fee.fee_name} · balance {money(feeBalance(fee))}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5 text-sm font-medium">Amount
              <input required type="number" min="0.01" step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} className="field" />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">Payment method
              <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} className="field">
                {paymentMethods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {paymentMethod !== "cash" && <label className="block space-y-1.5 text-sm font-medium">Payment reference
              <input required maxLength={120} value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} className="field" />
            </label>}
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" disabled={paymentSaving} onClick={() => setPaymentDialogOpen(false)} className="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Close</button>
            <button type="submit" disabled={paymentSaving} className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {paymentSaving ? "Recording…" : paymentAttempt ? "Retry payment request" : "Save payment"}
            </button>
          </div>
        </form>
      </div>}
    </div>
  );
}
