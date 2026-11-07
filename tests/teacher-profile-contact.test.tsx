import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeacherModuleView } from "@/components/teacher/teacher-views";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), getUser: vi.fn(), onAuthStateChange: vi.fn(), unsubscribe: vi.fn(),
  from: vi.fn(), profileHeader: vi.fn(), profileSignal: vi.fn(), profileResult: vi.fn(),
  rpc: vi.fn(), rpcHeader: vi.fn(), rpcSignal: vi.fn(), rpcResult: vi.fn(), assignments: vi.fn(),
  setSession: vi.fn(), updateUser: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getSession: mocks.getSession, getUser: mocks.getUser, onAuthStateChange: mocks.onAuthStateChange, setSession: mocks.setSession, updateUser: mocks.updateUser },
  from: mocks.from, rpc: mocks.rpc,
}) }));
vi.mock("@/lib/academic", () => ({ getCurrentTeacherAssignments: mocks.assignments, getCurrentTeacherId: vi.fn() }));

type Result = { data: null; error: { code: string; message: string } | null };
const userA = { id: "teacher-a", email: "teacher-a@example.test", is_anonymous: false } as User;
const userB = { id: "teacher-b", email: "teacher-b@example.test", is_anonymous: false } as User;
const teacher = { full_name: "Teacher A", employee_id: "EMP-A", designation: "Teacher", department: null,
  joining_date: null, qualification: null, registered_mobile: "9876500000" };
let current: User, listen: (event: AuthChangeEvent, session: Session | null) => void;
const nativeSession = (user = current) => ({ user, access_token: user.id === userA.id ? "owner-A-jwt" : "owner-B-jwt" } as Session);
function changed(user: User | null) {
  if (user) current = user;
  listen(user ? "SIGNED_IN" : "SIGNED_OUT", user ? nativeSession(user) : null);
}
const pending = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => {
  vi.clearAllMocks(); current = userA;
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.getSession.mockImplementation(async () => ({ data: { session: nativeSession() }, error: null }));
  mocks.getUser.mockImplementation(async (token: string) => ({ data: { user: token === "owner-A-jwt" ? userA : userB }, error: null }));
  mocks.onAuthStateChange.mockImplementation((callback) => { listen = callback; return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }; });
  mocks.assignments.mockResolvedValue([{ id: "assignment-a", class_name: "Grade 6", section_name: "A", subject_name: "Science", is_class_teacher: true }]);
  mocks.profileResult.mockResolvedValue({ data: teacher, error: null });
  mocks.from.mockImplementation(() => {
    const query = { select: () => query, eq: () => query, setHeader: mocks.profileHeader.mockImplementation(() => query),
      abortSignal: mocks.profileSignal.mockImplementation(() => query), maybeSingle: mocks.profileResult };
    return query;
  });
  mocks.rpcResult.mockResolvedValue({ data: null, error: null });
  mocks.rpc.mockImplementation(() => {
    const result = mocks.rpcResult();
    const request = { setHeader: mocks.rpcHeader.mockImplementation(() => request), abortSignal: mocks.rpcSignal.mockImplementation(() => request),
      then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) => result.then(resolve, reject) };
    return request;
  });
});
afterEach(() => { vi.restoreAllMocks(); });

async function loaded() {
  const mounted = render(<TeacherModuleView module="profile" />);
  await screen.findByRole("textbox", { name: "Update phone number" });
  return mounted;
}
async function edit(value: string) {
  const user = userEvent.setup(), field = screen.getByRole("textbox", { name: "Update phone number" });
  await user.clear(field); if (value) await user.type(field, value);
  return user;
}

describe("teacher school-contact owner fence", () => {
  it("pins profile reads and contact writes to the loaded, native-verified owner without adopting tokens", async () => {
    await loaded();
    expect(mocks.profileHeader).toHaveBeenCalledWith("Authorization", "Bearer owner-A-jwt");
    const user = await edit(" 9876512345 "); await user.click(screen.getByRole("button", { name: "Save Phone" }));
    expect(await screen.findByRole("status")).toHaveTextContent("School contact number updated. Your sign-in mobile has not changed.");
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("update_my_teacher_phone", { p_registered_mobile: "9876512345" });
    expect(mocks.rpcHeader).toHaveBeenCalledWith("Authorization", "Bearer owner-A-jwt");
    expect(mocks.getUser).toHaveBeenCalledWith("owner-A-jwt");
    expect(mocks.setSession).not.toHaveBeenCalled(); expect(mocks.updateUser).not.toHaveBeenCalled();
  });
  it("saves an empty school-contact field as null while preserving the sign-in email", async () => {
    await loaded(); const user = await edit(""); await user.click(screen.getByRole("button", { name: "Save Phone" }));
    await screen.findByRole("status");
    expect(mocks.rpc).toHaveBeenCalledWith("update_my_teacher_phone", { p_registered_mobile: null });
    expect(screen.getByText(userA.email!)).toBeInTheDocument();
  });
  it("accepts the same cached sign-in event while initial native owner verification is still pending", async () => {
    const verification = pending<{ data: { user: User }; error: null }>();
    mocks.getUser.mockReturnValueOnce(verification.promise);
    render(<TeacherModuleView module="profile" />);
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalled()); act(() => changed(userA));
    await act(async () => verification.resolve({ data: { user: userA }, error: null }));
    expect(await screen.findByRole("textbox", { name: "Update phone number" })).toHaveValue(teacher.registered_mobile);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("does not adopt an old native verification after the first observed sign-in belongs to another owner", async () => {
    const verification = pending<{ data: { user: User }; error: null }>();
    mocks.getUser.mockReturnValueOnce(verification.promise);
    render(<TeacherModuleView module="profile" />);
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalled()); act(() => changed(userB));
    await act(async () => verification.resolve({ data: { user: userA }, error: null }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your account changed");
    expect(mocks.from).not.toHaveBeenCalled(); expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("sends nothing and discards the old profile/draft when cached current ownership changes without a notification", async () => {
    await loaded(); const user = await edit("1111111111"); current = userB;
    await user.click(screen.getByRole("button", { name: "Save Phone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your account changed");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(screen.queryByText("Teacher A")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(userA.email!)).not.toBeInTheDocument();
  });
  it.each(["switch", "sign-out"])("aborts in-flight work and suppresses a late success after %s", async (action) => {
    await loaded(); const response = pending<Result>(); mocks.rpcResult.mockReturnValue(response.promise);
    const user = await edit("1111111111"); await user.click(screen.getByRole("button", { name: "Save Phone" }));
    await waitFor(() => expect(mocks.rpcSignal).toHaveBeenCalled());
    const signal = mocks.rpcSignal.mock.calls[0][0] as AbortSignal;
    act(() => changed(action === "switch" ? userB : null));
    expect(signal.aborted).toBe(true); expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
    await act(async () => response.resolve({ data: null, error: null }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("Teacher A")).not.toBeInTheDocument();
    expect(mocks.rpcHeader).not.toHaveBeenCalledWith("Authorization", "Bearer owner-B-jwt");
  });
  it("rejects a changed owner discovered after a committed response instead of showing the old success", async () => {
    await loaded(); const response = pending<Result>(); mocks.rpcResult.mockReturnValue(response.promise);
    const user = await edit("1111111111"); await user.click(screen.getByRole("button", { name: "Save Phone" }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalled()); current = userB;
    await act(async () => response.resolve({ data: null, error: null }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your account changed");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("never renders a delayed original profile after switching accounts during its read", async () => {
    const response = pending<{ data: typeof teacher; error: null }>(); mocks.profileResult.mockReturnValue(response.promise);
    render(<TeacherModuleView module="profile" />);
    await waitFor(() => expect(mocks.profileResult).toHaveBeenCalled()); act(() => changed(userB));
    await act(async () => response.resolve({ data: teacher, error: null }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your account changed");
    expect(screen.queryByText("Teacher A")).not.toBeInTheDocument(); expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("stays fenced after an A→B→A switch rather than restoring a delayed A response", async () => {
    const response = pending<{ data: typeof teacher; error: null }>(); mocks.profileResult.mockReturnValue(response.promise);
    render(<TeacherModuleView module="profile" />);
    await waitFor(() => expect(mocks.profileResult).toHaveBeenCalled()); act(() => { changed(userB); changed(userA); });
    await act(async () => response.resolve({ data: teacher, error: null }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your account changed"); expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("ignores the same owner's token refresh and avoids duplicate submissions", async () => {
    await loaded(); act(() => listen("TOKEN_REFRESHED", nativeSession(userA)));
    const response = pending<Result>(); mocks.rpcResult.mockReturnValue(response.promise);
    const form = screen.getByRole("form", { name: "Update teacher school contact" });
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox")).toBeDisabled();
    await act(async () => response.resolve({ data: null, error: null }));
    await screen.findByRole("status");
  });
  it("keeps the draft with an unconfirmed error and aborts/unsubscribes on unmount", async () => {
    const mounted = await loaded(); mocks.rpcResult.mockResolvedValue({ data: null, error: { code: "504", message: "upstream private details" } });
    const user = await edit("1111111111"); await user.click(screen.getByRole("button", { name: "Save Phone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Phone number could not be confirmed. Reload your profile before retrying.");
    expect(screen.getByRole("textbox")).toHaveValue("1111111111");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    const signal = mocks.rpcSignal.mock.calls[0][0] as AbortSignal; mounted.unmount();
    expect(signal.aborted).toBe(true); expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
