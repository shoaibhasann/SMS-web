import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModulePage from "../app/(dashboard)/modules/[module]/page";
import { FamilyFeeDueDetail } from "../components/family/family-fee-notification-detail";

const { onAuth, load, readAccess } = vi.hoisted(() => ({
  onAuth: vi.fn(), load: vi.fn(), readAccess: vi.fn(),
}));
const router = { replace: vi.fn() };
let query: URLSearchParams;
vi.mock("next/navigation", () => ({
  useParams: () => ({ module: "invoices" }), useSearchParams: () => query, useRouter: () => router,
}));
vi.mock("@/lib/auth/access", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/auth/access")>(), readActiveSchoolAccess: readAccess }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { onAuthStateChange: onAuth } }) }));
vi.mock("@/lib/notifications/family", async (original) => ({
  ...await original<typeof import("../lib/notifications/family")>(), loadFamilyFeeDue: load,
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
const fee = {
  id: id(3), student_id: id(4), student_name: "QA Pupil", fee_name: "November tuition",
  due_date: "2026-11-10", balance: "123456.75", status: "overdue" as const,
};

function roleAccess(...roles: string[]) {
  readAccess.mockResolvedValue({
    userId: actor, profileSchoolId: schoolId, roles: roles.map((role) => ({ role, school_id: schoolId })),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  query = new URLSearchParams({ child: fee.student_id, fee: fee.id });
  onAuth.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  load.mockResolvedValue(fee);
  roleAccess("student");
});

describe("exact fee due links", () => {
  it.each([["student", ""], ["parent", "guardian"]] as const)(
    "uses the requested %s role even on a mixed account and shows the current INR balance",
    async (role, view) => {
      roleAccess("school_admin", "student", "parent");
      if (view) query.set("view", view);
      render(<ModulePage />);
      expect(await screen.findByRole("heading", { name: fee.fee_name })).toBeInTheDocument();
      expect(screen.getByRole("main", { name: `${role} workspace` })).toBeInTheDocument();
      expect(screen.getByText(fee.student_name)).toBeInTheDocument();
      expect(screen.getByText("₹1,23,456.75")).toBeInTheDocument();
      expect(screen.getByText("10 November 2026")).toHaveAttribute("datetime", fee.due_date);
      expect(screen.getByText("Overdue")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Back to notifications" })).toHaveAttribute(
        "href", view ? "/modules/notifications?view=guardian" : "/modules/notifications",
      );
      expect(load).toHaveBeenCalledWith(expect.anything(), { id: fee.id, studentId: fee.student_id, role, userId: actor }, expect.any(AbortSignal));
      expect(screen.queryByRole("region", { name: "Office receipts" })).not.toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Family receipts" })).not.toBeInTheDocument();
    },
  );

  it.each([
    ["duplicate fee", (params: URLSearchParams) => params.append("fee", id(5))],
    ["duplicate child", (params: URLSearchParams) => params.append("child", id(5))],
    ["invalid child", (params: URLSearchParams) => params.set("child", "invalid")],
    ["missing child", (params: URLSearchParams) => params.delete("child")],
    ["empty fee", (params: URLSearchParams) => params.set("fee", "")],
  ] as const)("keeps a link with %s unavailable without requesting receipts", async (_name, change) => {
    change(query);
    render(<ModulePage />);
    expect(await screen.findByText("This fee is no longer available.")).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Family receipts" })).not.toBeInTheDocument();
  });

  it("preserves the regular invoices and receipts route when no fee is requested", async () => {
    query.delete("fee");
    render(<ModulePage />);
    expect(await screen.findByRole("region", { name: "Family receipts" })).toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("does not use another school's Student role or fall back to the office view", async () => {
    readAccess.mockResolvedValue({
      userId: actor, profileSchoolId: schoolId, roles: [
        { role: "school_admin", school_id: schoolId }, { role: "student", school_id: id(6) },
      ],
    });
    render(<ModulePage />);
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"));
    expect(screen.queryByRole("region", { name: "Office receipts" })).not.toBeInTheDocument();
    expect(load).not.toHaveBeenCalled();
  });

  it("discards a response for the wrong child and an older pending request", async () => {
    let resolve: (value: typeof fee) => void = () => {};
    load.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const mounted = render(<FamilyFeeDueDetail feeId={fee.id} studentId={fee.student_id} role="parent" userId={actor} />);
    const oldSignal = load.mock.calls[0][2] as AbortSignal;
    mounted.rerender(<FamilyFeeDueDetail feeId={fee.id} studentId={id(5)} role="parent" userId={actor} />);
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByText("This fee is no longer available.")).toBeInTheDocument();
    await act(async () => { resolve(fee); });
    expect(screen.queryByText(fee.student_name)).not.toBeInTheDocument();
  });

  it("hides an outdated balance on refresh and on sign-in changes", async () => {
    const user = userEvent.setup();
    let resolve: (value: null) => void = () => {};
    const mounted = render(<FamilyFeeDueDetail feeId={fee.id} studentId={fee.student_id} role="parent" userId={actor} />);
    await screen.findByText("₹1,23,456.75");
    load.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await user.click(screen.getByRole("button", { name: "Refresh fee details" }));
    expect(screen.queryByText("₹1,23,456.75")).not.toBeInTheDocument();
    await act(async () => { resolve(null); });
    expect(await screen.findByText("This fee is no longer available.")).toBeInTheDocument();
    mounted.rerender(<FamilyFeeDueDetail feeId={fee.id} studentId={fee.student_id} role="parent" userId={id(8)} />);
    await screen.findByText("₹1,23,456.75");
    const callback = onAuth.mock.calls.at(-1)![0];
    await act(async () => callback("SIGNED_OUT", null));
    expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed.");
    expect(screen.queryByText("₹1,23,456.75")).not.toBeInTheDocument();
  });

  it("leads with the balance due and retries a failed load from under the error", async () => {
    const user = userEvent.setup();
    load.mockRejectedValueOnce(new Error("offline"));
    render(<FamilyFeeDueDetail feeId={fee.id} studentId={fee.student_id} role="parent" userId={actor} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This fee could not be loaded.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("₹1,23,456.75")).toHaveClass("text-2xl");
    expect(screen.getByText("Balance due")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the balance on focus and tab return and ignores a replayed initial session", async () => {
    render(<FamilyFeeDueDetail feeId={fee.id} studentId={fee.student_id} role="parent" userId={actor} />);
    const balance = await screen.findByText("₹1,23,456.75");
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => onAuth.mock.calls.at(-1)![0]("INITIAL_SESSION", null));
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByText("₹1,23,456.75")).toBe(balance);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
