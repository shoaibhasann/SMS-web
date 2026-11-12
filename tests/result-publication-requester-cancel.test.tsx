import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ResultPublicationWorkspace } from "@/components/academic/result-publication-workspace";
import { resultDetail, resultSummary } from "./result-publication-fixture";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: mocks.rpc, auth: {
  getUser: async () => ({ data: { user: { id: "teacher" } }, error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
} }) }));
vi.mock("@/lib/attendance/repository", () => ({ loadSchoolManagementAccess: vi.fn() }));

beforeEach(() => { mocks.rpc.mockReset(); });

it("lets a requester whose assignment was removed cancel their own pending request", async () => {
  const pending = resultDetail();
  let cancelled = false;
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "list_assessment_publication_candidates") return { data: [], error: null };
    if (name === "list_assessment_result_submissions") {
      const rows = cancelled ? [] : [resultSummary(pending)];
      return { data: { rows, total_count: rows.length, offset: args.p_offset }, error: null };
    }
    if (name === "get_assessment_result_submission") return { data: null, error: { code: "42501", message: "You cannot view this submitted result snapshot." } };
    if (name === "cancel_assessment_result_submission") { cancelled = true; return { data: args.p_submission_id, error: null }; }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const user = userEvent.setup();
  render(<ResultPublicationWorkspace role="teacher" userId="teacher" />);
  await user.click(await screen.findByRole("button", { name: "Open result snapshot" }));
  expect(await screen.findByText(/You can still cancel your pending request/)).toBeInTheDocument();
  await user.type(screen.getByLabelText("Cancellation reason"), "My assignment moved to another teacher");
  await user.click(screen.getByRole("button", { name: "Cancel publication request" }));
  expect(await screen.findByText(/Request cancelled/)).toBeInTheDocument();
  expect(mocks.rpc).toHaveBeenCalledWith("cancel_assessment_result_submission", { p_submission_id: pending.id, p_reason: "My assignment moved to another teacher" });
  expect(await screen.findByText("No publication requests on this page.")).toBeInTheDocument();
});

it("keeps neutral copy and a retry for a transient detail failure on the requester's own pending row", async () => {
  const pending = resultDetail();
  let fail = true;
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
    if (name === "list_assessment_publication_candidates") return { data: [], error: null };
    if (name === "list_assessment_result_submissions") return { data: { rows: [resultSummary(pending)], total_count: 1, offset: args.p_offset }, error: null };
    if (name === "get_assessment_result_submission") return fail ? { data: null, error: { message: "Failed to fetch" } } : { data: pending, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  });
  const user = userEvent.setup();
  render(<ResultPublicationWorkspace role="teacher" userId="teacher" />);
  await user.click(await screen.findByRole("button", { name: "Open result snapshot" }));
  expect(await screen.findByText(/The saved snapshot could not be loaded right now/)).toBeInTheDocument();
  expect(screen.queryByText(/teaching assignment for this assessment changed/)).not.toBeInTheDocument();
  expect(screen.getByLabelText("Cancellation reason")).toBeInTheDocument();
  fail = false;
  await user.click(screen.getByRole("button", { name: "Retry loading snapshot" }));
  expect(await screen.findByRole("button", { name: "Cancel publication request" })).toBeInTheDocument();
  expect(screen.queryByText(/could not be loaded right now/)).not.toBeInTheDocument();
});
