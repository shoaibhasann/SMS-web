import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { FamilyFeePaymentDetail } from "../components/family/family-fee-notification-detail";

const { onAuth, loadPayment, loadDue, readAccess } = vi.hoisted(() => ({
  onAuth: vi.fn(), loadPayment: vi.fn(), loadDue: vi.fn(), readAccess: vi.fn(),
}));
const router = { replace: vi.fn() };
let query: URLSearchParams;
vi.mock("next/navigation", () => ({
  useParams: () => ({ module: "invoices" }), useSearchParams: () => query, useRouter: () => router,
}));
vi.mock("@/lib/auth/access", () => ({ readActiveSchoolAccess: readAccess }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: onAuth } }) }));
vi.mock("@/lib/notifications/family", async (original) => ({
  ...await original<typeof import("../lib/notifications/family")>(),
  loadFamilyFeePayment: loadPayment, loadFamilyFeeDue: loadDue,
}));
vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ role, children }: { role: string; children: ReactNode }) => <main aria-label={`${role} workspace`}>{children}</main>,
}));
vi.mock("@/components/finance/family-receipts", () => ({
  FamilyReceipts: () => <section aria-label="Family receipts" />,
}));
vi.mock("@/components/admin/admin-finance-workspace", () => ({
  AdminFinanceWorkspace: () => <section aria-label="Office receipts" />,
}));

const id = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const actor = id(1);
const schoolId = id(2);
const paid = {
  id: id(3), student_id: id(4), student_name: "QA Pupil", fee_name: "November tuition", receipt_no: "RCPT-EXACT-01",
  amount: "123456.75", net_amount: "123456.75", status: "paid",
  paid_at: "2026-11-09T12:00:00Z", payment_method: "upi", reversed_at: null, reversal_reference: null,
};
const reversed = {
  ...paid, status: "reversed", net_amount: "0.00", reversed_at: "2026-11-10T10:00:00Z", reversal_reference: "REV-QA-01",
};

function roleAccess(...roles: string[]) {
  readAccess.mockResolvedValue({
    userId: actor, profileSchoolId: schoolId, roles: roles.map((role) => ({ role, school_id: schoolId })),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  query = new URLSearchParams({ child: paid.student_id, payment: paid.id });
  onAuth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  loadPayment.mockResolvedValue(paid);
  roleAccess("school_admin", "student", "parent");
});

describe("exact fee payment links", () => {
  it.each([["student", ""], ["parent", "guardian"]] as const)(
    "uses the requested %s role on a mixed account and shows only the requested receipt",
    async (role, view) => {
      if (view) query.set("view", view);
      render(<ModulePage />);
      expect(await screen.findByText(paid.receipt_no)).toBeInTheDocument();
      expect(screen.getByRole("main", { name: `${role} workspace` })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: paid.fee_name })).toBeInTheDocument();
      expect(screen.getByText(paid.student_name)).toBeInTheDocument();
      expect(screen.getByText("₹1,23,456.75")).toBeInTheDocument();
      expect(screen.getByText("9 Nov 2026")).toHaveAttribute("datetime", paid.paid_at);
      expect(screen.getByText("UPI")).toBeInTheDocument();
      expect(screen.getByText("Paid")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to notifications" })).toHaveAttribute(
        "href", view ? "/modules/notifications?view=guardian" : "/modules/notifications",
      );
      expect(loadPayment).toHaveBeenCalledWith(
        expect.anything(), { id: paid.id, studentId: paid.student_id, role, userId: actor }, expect.any(AbortSignal),
      );
      expect(loadDue).not.toHaveBeenCalled();
      expect(screen.queryByRole("region", { name: "Office receipts" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Family receipts" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["duplicate payment", (params: URLSearchParams) => params.append("payment", id(5))],
    ["duplicate child", (params: URLSearchParams) => params.append("child", id(5))],
    ["invalid payment", (params: URLSearchParams) => params.set("payment", "not-a-uuid")],
    ["invalid child", (params: URLSearchParams) => params.set("child", "not-a-uuid")],
    ["missing child", (params: URLSearchParams) => params.delete("child")],
    ["ambiguous fee and payment", (params: URLSearchParams) => params.set("fee", id(6))],
  ] as const)("rejects %s without fetching a target or receipts", async (_name, change) => {
    change(query);
    render(<ModulePage />);
    expect(await screen.findByText("This payment receipt is no longer available.")).toBeInTheDocument();
    expect(loadPayment).not.toHaveBeenCalled();
    expect(loadDue).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Family receipts" })).not.toBeInTheDocument();
  });

  it("requires a guardian role for the guardian target, even for a Student and Office account", async () => {
    roleAccess("school_admin", "student");
    query.set("view", "guardian");
    render(<ModulePage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("main", { name: /workspace$/ })).not.toBeInTheDocument();
    expect(loadPayment).not.toHaveBeenCalled();
  });

  it("keeps the original receipt and displays the net amount and correction after refresh", async () => {
    const user = userEvent.setup();
    render(<FamilyFeePaymentDetail paymentId={paid.id} studentId={paid.student_id} role="parent" userId={actor} />);
    expect(await screen.findByText("Paid")).toBeInTheDocument();
    loadPayment.mockResolvedValueOnce(reversed);
    await user.click(screen.getByRole("button", { name: "Refresh payment receipt" }));
    expect(await screen.findByText("Reversed")).toBeInTheDocument();
    expect(screen.getByText(paid.receipt_no)).toBeInTheDocument();
    expect(screen.getByText("₹1,23,456.75")).toBeInTheDocument();
    expect(screen.getByText(/Effective recorded amount: ₹0.00/)).toBeInTheDocument();
    expect(screen.getByText(/REV-QA-01/)).toBeInTheDocument();
    expect(screen.getByText("10 Nov 2026 IST")).toHaveAttribute("datetime", reversed.reversed_at);
    expect(screen.queryByRole("button", { name: /refund|reverse payment|pay now/i })).not.toBeInTheDocument();
    loadPayment.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Refresh payment receipt" }));
    expect(await screen.findByText("This payment receipt is no longer available.")).toBeInTheDocument();
    expect(screen.queryByText(paid.receipt_no)).not.toBeInTheDocument();
  });

  it("aborts an earlier target and denies a wrong-child response", async () => {
    let resolve: (value: typeof paid) => void = () => {};
    loadPayment.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const mounted = render(<FamilyFeePaymentDetail paymentId={paid.id} studentId={paid.student_id} role="parent" userId={actor} />);
    const signal = loadPayment.mock.calls[0][2] as AbortSignal;
    mounted.rerender(<FamilyFeePaymentDetail paymentId={paid.id} studentId={id(7)} role="parent" userId={actor} />);
    expect(signal.aborted).toBe(true);
    expect(await screen.findByText("This payment receipt is no longer available.")).toBeInTheDocument();
    await act(async () => { resolve(paid); });
    expect(screen.queryByText(paid.receipt_no)).not.toBeInTheDocument();
  });
});
