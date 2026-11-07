import type { Session } from "@supabase/supabase-js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GateOperationsWorkspace } from "@/components/admin/gate-operations-workspace";
import { GateOperationsError, type GateDevice, type GateEvents, type GateMapping, type GateOperation, type GatePupils, type GateSetup } from "@/lib/attendance/gate-operations";

const { setup, events, pupils, save, createIntent, client } = vi.hoisted(() => ({ setup: vi.fn(), events: vi.fn(), pupils: vi.fn(), save: vi.fn(), createIntent: vi.fn(), client: { auth: { onAuthStateChange: vi.fn() } } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => client }));
vi.mock("@/lib/attendance/gate-operations", async original => ({ ...await original<typeof import("@/lib/attendance/gate-operations")>(), loadGateSetup: setup, loadGateEvents: events, searchGatePupils: pupils, saveGateOperation: save, createGateDeviceIntent: createIntent }));
const id = (value: number) => `80000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const userId = id(1), schoolId = id(2), deviceId = id(3), studentId = id(4), mappingId = id(5), secret = "a".repeat(43), now = "2026-11-07T07:30:00Z";
const props = { userId, schoolId };
const pupil = { student_id: studentId, student_name: "Aarav QA", admission_no: "QA-101" };
const device = (overrides: Partial<GateDevice> = {}): GateDevice => ({ device_id: deviceId, name: "Main school gate", late_after: "08:15", working_days: [1, 2, 3, 4, 5], created_at: now, revoked_at: null, ...overrides });
const mapping = (overrides: Partial<GateMapping> = {}): GateMapping => ({ mapping_id: mappingId, device_id: deviceId, subject_id: "card:101", student_id: studentId, valid_from: "2026-11-07", revoked_at: null, admission_no: pupil.admission_no, student_name: pupil.student_name, ...overrides });
const gateSetup = (overrides: Partial<GateSetup> = {}): GateSetup => ({ user_id: userId, school_id: schoolId, timezone: "Asia/Kolkata", page_size: 100, offset: 0, device_count: 1, devices: [device()], mapping_count: 1, mappings: [mapping()], ...overrides });
const emptySetup = (): GateSetup => gateSetup({ device_count: 0, devices: [], mapping_count: 0, mappings: [] });
const gateEvents = (overrides: Partial<GateEvents> = {}): GateEvents => ({ user_id: userId, school_id: schoolId, page_size: 100, offset: 0, total_count: 2, device_count: 1, events: [
  { receipt_id: id(10), device_id: deviceId, event_id: "arrival:101", subject_id: "card:101", direction: "IN", occurred_at: now, received_at: now, student_id: studentId, attendance_id: id(11), attendance_status: "present", status: "accepted", reason: "marked_present", device_name: "Main school gate", student_name: pupil.student_name, admission_no: pupil.admission_no },
  { receipt_id: id(12), device_id: deviceId, event_id: "exit:unknown", subject_id: "card:unknown", direction: "OUT", occurred_at: now, received_at: now, student_id: null, attendance_id: null, attendance_status: null, status: "held_review", reason: "unknown_subject", device_name: "Main school gate", student_name: null, admission_no: null },
], ...overrides });
const matches = (overrides: Partial<GatePupils> = {}): GatePupils => ({ user_id: userId, school_id: schoolId, query: "QA", offset: 0, page_size: 25, total_count: 1, pupils: [pupil], ...overrides });
const intent = (): Extract<GateOperation, { kind: "create_device" }> => ({ kind: "create_device", schoolId, deviceId, name: "Main gate", secret, lateAfter: "08:15", workingDays: [1] });
function pending<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
let changed: (event: string, session: Session | null) => void;
const unsubscribe = vi.fn();
async function ready() { await screen.findByRole("region", { name: "Gate device setup" }); await screen.findByText("IN · Accepted"); }
function fillDevice() { fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Main gate" } }); fireEvent.change(screen.getByLabelText("Late arrival cutoff (IST)"), { target: { value: "08:15" } }); fireEvent.click(screen.getByRole("checkbox", { name: "Monday" })); }
async function selectPupil() { fireEvent.change(screen.getByLabelText("Admission number or pupil name"), { target: { value: "QA" } }); fireEvent.click(screen.getByRole("button", { name: "Search pupils" })); fireEvent.click(await screen.findByRole("button", { name: /Aarav QA.*QA-101/ })); }
beforeEach(() => {
  vi.restoreAllMocks(); setup.mockReset().mockResolvedValue(gateSetup()); events.mockReset().mockResolvedValue(gateEvents()); pupils.mockReset().mockResolvedValue(matches()); save.mockReset().mockResolvedValue({ revoked_at: null }); createIntent.mockReset().mockImplementation(intent); unsubscribe.mockClear();
  client.auth.onAuthStateChange.mockImplementation((callback: typeof changed) => { changed = callback; return { data: { subscription: { unsubscribe } } }; });
});

describe("School gate operations workspace", () => {
  it("uses skeletons while access is checked and never offers generated scans", () => {
    setup.mockReturnValue(new Promise(() => {})); events.mockReturnValue(new Promise(() => {})); const { container } = render(<GateOperationsWorkspace {...props} />);
    expect(container.querySelector('[data-skeleton="form"]')).toBeInTheDocument(); expect(container.querySelector('[data-skeleton="list"]')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /scan|simulate|replay|resolve|approve/i })).not.toBeInTheDocument(); expect(save).not.toHaveBeenCalled();
  });
  it("requires an explicit cutoff and unchecked fallback weekdays without changing calendar policy", async () => {
    setup.mockResolvedValue(emptySetup()); render(<GateOperationsWorkspace {...props} />); await ready();
    expect(screen.getByLabelText("Late arrival cutoff (IST)")).toHaveValue(""); expect(screen.getAllByRole("checkbox")).toHaveLength(7); for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Register device" })).toBeDisabled(); expect(screen.getByText(/approved school calendar takes precedence/)).toBeInTheDocument(); expect(screen.getByRole("link", { name: "Configure school calendar" })).toHaveAttribute("href", "/modules/settings#attendance-calendar");
    fireEvent.submit(screen.getByRole("form", { name: "Register gate device" })); expect(createIntent).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it("reveals a confirmed secret only on request, clears it after acknowledgement and never persists or copies it", async () => {
    setup.mockResolvedValue(emptySetup()); const stored = vi.spyOn(Storage.prototype, "setItem"), copy = vi.fn(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    const result = pending<{ revoked_at: null }>(); save.mockReturnValue(result.promise); render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" }));
    expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument(); expect(createIntent).toHaveBeenCalledWith(schoolId, "Main gate", "08:15", [1]); setup.mockResolvedValue(gateSetup()); await act(async () => result.resolve({ revoked_at: null }));
    const field = await screen.findByLabelText("Device secret"); expect(field).toHaveAttribute("type", "password"); expect(field).toHaveValue(secret); expect(field).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Reveal device secret" })); expect(field).toHaveAttribute("type", "text"); fireEvent.click(screen.getByRole("button", { name: "Hide device secret" })); expect(field).toHaveAttribute("type", "password");
    expect(stored).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "I saved the credentials" })); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument();
  });
  it("freezes an unknown create outcome and retries the identical device ID and secret", async () => {
    setup.mockResolvedValue(emptySetup()); save.mockRejectedValueOnce(new GateOperationsError("Save outcome unknown")); render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" }));
    await screen.findByRole("region", { name: "Unconfirmed gate action" }); const original = save.mock.calls[0][2]; expect(screen.getByLabelText("Device name")).toBeDisabled(); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry same gate action" })); await screen.findByLabelText("Device secret"); expect(createIntent).toHaveBeenCalledTimes(1); expect(save.mock.calls[1][2]).toBe(original); expect(save.mock.calls[1][2].secret).toBe(secret);
  });
  it("never exposes credentials or claims activation when exact create retry returns a revoked device", async () => {
    setup.mockResolvedValue(emptySetup()); save.mockRejectedValueOnce(new GateOperationsError("Unknown outcome")).mockResolvedValueOnce({ revoked_at: now }); render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry same gate action" })); expect(await screen.findByRole("status")).toHaveTextContent("already revoked and is not active"); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument();
  });
  it("blocks duplicate writes while a device request is pending", async () => {
    setup.mockResolvedValue(emptySetup()); const result = pending<{ revoked_at: null }>(); save.mockReturnValue(result.promise); render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice();
    const form = screen.getByRole("form", { name: "Register gate device" }); fireEvent.submit(form); fireEvent.submit(form); expect(save).toHaveBeenCalledTimes(1); expect(createIntent).toHaveBeenCalledTimes(1); expect(screen.getByRole("button", { name: "Registering…" })).toBeDisabled();
    await act(async () => result.resolve({ revoked_at: null }));
  });
  it("requires explicit pupil selection and a valid exact identifier before mapping the correct ID", async () => {
    render(<GateOperationsWorkspace {...props} />); await ready(); const search = screen.getByLabelText("Admission number or pupil name"), link = screen.getByRole("button", { name: "Link selected pupil" });
    fireEvent.change(search, { target: { value: "Q" } }); expect(screen.getByRole("button", { name: "Search pupils" })).toBeDisabled(); expect(link).toBeDisabled();
    fireEvent.change(search, { target: { value: "QA" } }); fireEvent.click(screen.getByRole("button", { name: "Search pupils" })); await screen.findByRole("button", { name: /Aarav QA.*QA-101/ }); expect(link).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Aarav QA.*QA-101/ })); fireEvent.change(screen.getByLabelText("Device student identifier"), { target: { value: "invalid identifier" } }); expect(link).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Device student identifier"), { target: { value: "card:101" } }); fireEvent.click(link); await waitFor(() => expect(save).toHaveBeenCalledWith(client, userId, { kind: "map_student", schoolId, deviceId, mappingId: expect.any(String), studentId, subjectId: "card:101" }, expect.any(AbortSignal)));
    expect(await screen.findByRole("status")).toHaveTextContent("Student identifier linked");
  });
  it("drops pupil selection and cancels stale searches when the query changes", async () => {
    render(<GateOperationsWorkspace {...props} />); await ready(); await selectPupil(); fireEvent.change(screen.getByLabelText("Device student identifier"), { target: { value: "card:102" } }); expect(screen.getByRole("button", { name: "Link selected pupil" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Admission number or pupil name"), { target: { value: "Old" } }); expect(screen.getByRole("button", { name: "Link selected pupil" })).toBeDisabled();
    const old = pending<GatePupils>(); pupils.mockReturnValueOnce(old.promise); fireEvent.click(screen.getByRole("button", { name: "Search pupils" })); const signal = pupils.mock.calls.at(-1)![5] as AbortSignal;
    fireEvent.change(screen.getByLabelText("Admission number or pupil name"), { target: { value: "Different" } }); expect(signal.aborted).toBe(true); await act(async () => old.resolve(matches())); expect(screen.queryByRole("list", { name: "Matching pupils" })).not.toBeInTheDocument();
  });
  it("paginates pupil matches by 25 without automatically selecting a result", async () => {
    pupils.mockResolvedValueOnce(matches({ total_count: 26, pupils: Array.from({ length: 25 }, (_, index) => ({ ...pupil, student_id: id(index + 100), student_name: `Pupil ${index}` })) })).mockResolvedValueOnce(matches({ offset: 25, total_count: 26 }));
    render(<GateOperationsWorkspace {...props} />); await ready(); fireEvent.change(screen.getByLabelText("Admission number or pupil name"), { target: { value: "QA" } }); fireEvent.click(screen.getByRole("button", { name: "Search pupils" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next pupil matches" })); await waitFor(() => expect(pupils).toHaveBeenLastCalledWith(client, userId, schoolId, "QA", 25, expect.any(AbortSignal))); expect(screen.getByRole("button", { name: "Link selected pupil" })).toBeDisabled();
  });
  it("retries an unconfirmed mapping with the same mapping ID and never selects a replacement pupil", async () => {
    save.mockRejectedValueOnce(new GateOperationsError("Mapping outcome unknown")); render(<GateOperationsWorkspace {...props} />); await ready(); await selectPupil(); fireEvent.change(screen.getByLabelText("Device student identifier"), { target: { value: "card:102" } }); fireEvent.click(screen.getByRole("button", { name: "Link selected pupil" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry same gate action" })); await screen.findByRole("status"); expect(save.mock.calls[1][2]).toBe(save.mock.calls[0][2]); expect(createIntent).not.toHaveBeenCalled();
  });
  it("requires a reason before revoking a mapping and retains its history", async () => {
    save.mockResolvedValue({ revoked_at: now }); render(<GateOperationsWorkspace {...props} />); await ready(); fireEvent.click(screen.getByRole("button", { name: `Revoke identifier card:101 on device ${deviceId}` })); const confirm = screen.getByRole("button", { name: "Confirm revocation" });
    expect(confirm).toBeDisabled(); fireEvent.change(screen.getByLabelText("Revocation reason"), { target: { value: "lost" } }); expect(confirm).toBeDisabled(); fireEvent.change(screen.getByLabelText("Revocation reason"), { target: { value: "Card replaced by school" } });
    setup.mockResolvedValue(gateSetup({ mappings: [mapping({ revoked_at: now })] })); fireEvent.click(confirm); await waitFor(() => expect(save).toHaveBeenCalledWith(client, userId, { kind: "revoke_mapping", schoolId, mappingId, reason: "Card replaced by school" }, expect.any(AbortSignal)));
    expect(await screen.findByRole("status")).toHaveTextContent("Existing scan and attendance history is unchanged"); expect(within(screen.getByRole("region", { name: "Gate student mappings" })).getByText("card:101")).toBeInTheDocument();
  });
  it("revokes only the selected device and shows retained mappings as inactive", async () => {
    save.mockResolvedValue({ revoked_at: now }); render(<GateOperationsWorkspace {...props} />); await ready(); fireEvent.click(screen.getByRole("button", { name: "Revoke active device" })); fireEvent.change(screen.getByLabelText("Revocation reason"), { target: { value: "Device installer replaced" } }); setup.mockResolvedValue(gateSetup({ devices: [device({ revoked_at: now })] })); fireEvent.click(screen.getByRole("button", { name: "Confirm revocation" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(client, userId, { kind: "revoke_device", schoolId, deviceId, reason: "Device installer replaced" }, expect.any(AbortSignal))); expect(await screen.findByText(/Device inactive/)).toBeInTheDocument(); expect(screen.getByText("Main school gate · Revoked")).toBeInTheDocument();
  });
  it("renders explicit immutable IN/OUT receipts and routes held events to reviewed correction flow", async () => {
    const review = vi.fn(); render(<GateOperationsWorkspace {...props} onReviewAttendance={review} />); await ready(); const receipts = screen.getByRole("region", { name: "Gate event receipts" });
    expect(within(receipts).getByText("OUT · Held for review")).toBeInTheDocument(); expect(within(receipts).getByText(/not the current attendance register/)).toBeInTheDocument(); expect(within(receipts).getAllByText(/IST/)).toHaveLength(4); expect(within(receipts).getByText(/Receipt attendance: present/)).toBeInTheDocument();
    fireEvent.click(within(receipts).getByRole("button", { name: "Open attendance review" })); expect(review).toHaveBeenCalledOnce(); expect(within(receipts).getByText(/correction does not change these immutable receipts/)).toBeInTheDocument(); expect(within(receipts).queryByRole("button", { name: /approve|resolve|replay|send|scan/i })).not.toBeInTheDocument();
  });
  it("uses separate 100-row mapping and receipt pages without claiming a partial page is the whole history", async () => {
    setup.mockResolvedValueOnce(gateSetup({ mapping_count: 101, mappings: Array.from({ length: 100 }, (_, index) => mapping({ mapping_id: id(index + 100), subject_id: `card:${index}` })) })).mockResolvedValueOnce(gateSetup({ mapping_count: 101, offset: 100 }));
    const firstEvents = gateEvents(); events.mockResolvedValueOnce(gateEvents({ total_count: 101, events: Array.from({ length: 100 }, (_, index) => ({ ...firstEvents.events[0], receipt_id: id(index + 300), event_id: `event:${index}` })) })).mockResolvedValueOnce(gateEvents({ total_count: 101, offset: 100, events: [firstEvents.events[0]] }));
    render(<GateOperationsWorkspace {...props} />); await screen.findByText("1–100 of 101 mappings"); fireEvent.click(screen.getByRole("button", { name: "Next mapping page" })); await screen.findByText("101–101 of 101 mappings"); expect(setup).toHaveBeenLastCalledWith(client, userId, schoolId, 100, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Next gate event page" })); await screen.findByText("101–101 of 101 receipts"); expect(events).toHaveBeenLastCalledWith(client, userId, schoolId, 100, expect.any(AbortSignal));
  });
  it.each(["access", "validation", "conflict"] as const)("clears all data and credentials on a %s write failure", async code => {
    save.mockRejectedValue(new GateOperationsError("Gate access must be checked", code)); render(<GateOperationsWorkspace {...props} />); await ready(); await selectPupil(); fireEvent.change(screen.getByLabelText("Device student identifier"), { target: { value: "card:103" } }); fireEvent.click(screen.getByRole("button", { name: "Link selected pupil" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Gate access must be checked"); expect(screen.queryByRole("region", { name: "Gate event receipts" })).not.toBeInTheDocument(); expect(screen.queryByText(pupil.student_name)).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Retry same gate action" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry gate access" })); await ready();
  });
  it("clears credentials on returning focus and rechecks saved device access", async () => {
    setup.mockResolvedValue(emptySetup()); render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); setup.mockResolvedValue(gateSetup()); fireEvent.click(screen.getByRole("button", { name: "Register device" })); await screen.findByLabelText("Device secret"); const priorLoads = setup.mock.calls.length;
    act(() => window.dispatchEvent(new Event("focus"))); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("one-time secret was cleared"); await waitFor(() => expect(setup.mock.calls.length).toBeGreaterThan(priorLoads));
  });
  it("keeps a new focused-session action guarded when an aborted old write settles late", async () => {
    setup.mockResolvedValue(emptySetup()); const old = pending<{ revoked_at: null }>(), fresh = pending<{ revoked_at: null }>(); save.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" })); const oldSignal = save.mock.calls[0][3] as AbortSignal;
    act(() => window.dispatchEvent(new Event("focus"))); expect(oldSignal.aborted).toBe(true); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" })); const freshSignal = save.mock.calls[1][3] as AbortSignal;
    await act(async () => old.resolve({ revoked_at: null })); expect(freshSignal.aborted).toBe(false); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Registering…" })).toBeDisabled();
    await act(async () => fresh.resolve({ revoked_at: null })); expect(await screen.findByLabelText("Device secret")).toHaveValue(secret); expect(save).toHaveBeenCalledTimes(2);
  });
  it("clears a confirmed secret when the post-save access check fails", async () => {
    setup.mockResolvedValueOnce(emptySetup()); const refresh = pending<GateSetup>(); setup.mockReturnValueOnce(refresh.promise); render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" })); await screen.findByLabelText("Device secret");
    await act(async () => refresh.reject(new GateOperationsError("School access revoked", "access"))); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument(); expect(screen.getByRole("alert")).toHaveTextContent("School access revoked"); expect(screen.queryByRole("button", { name: "Reveal device secret" })).not.toBeInTheDocument();
  });
  it("prevents the attendance-review handoff while an identifier draft is open", async () => {
    const review = vi.fn(); render(<GateOperationsWorkspace {...props} onReviewAttendance={review} />); await ready(); fireEvent.change(screen.getByLabelText("Device student identifier"), { target: { value: "pending-card" } });
    const button = screen.getByRole("button", { name: "Open attendance review" }); expect(button).toBeDisabled(); fireEvent.click(button); expect(review).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Cancel mapping draft" })); expect(button).toBeEnabled();
  });
  it("handles unavailable cryptographic mapping IDs without sending an unsafe replacement", async () => {
    render(<GateOperationsWorkspace {...props} />); await ready(); await selectPupil(); fireEvent.change(screen.getByLabelText("Device student identifier"), { target: { value: "card:104" } }); vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("Unavailable"); }); fireEvent.click(screen.getByRole("button", { name: "Link selected pupil" }));
    expect(screen.getByRole("alert")).toHaveTextContent("secure mapping identifier could not be generated"); expect(save).not.toHaveBeenCalled();
  });
  it("aborts delayed writes on logout and never publishes a late secret", async () => {
    setup.mockResolvedValue(emptySetup()); const result = pending<{ revoked_at: null }>(); save.mockReturnValue(result.promise); render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" })); const signal = save.mock.calls[0][3] as AbortSignal;
    act(() => changed("SIGNED_OUT", null)); expect(signal.aborted).toBe(true); expect(screen.getByRole("alert")).toHaveTextContent("Your sign-in changed"); await act(async () => result.resolve({ revoked_at: null })); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument(); expect(screen.queryByRole("region", { name: "Gate device setup" })).not.toBeInTheDocument();
  });
  it("resets school/account ownership and ignores the old owner's delayed writes", async () => {
    setup.mockResolvedValue(emptySetup()); const result = pending<{ revoked_at: null }>(); save.mockReturnValue(result.promise); const { rerender } = render(<GateOperationsWorkspace {...props} />); await ready(); fillDevice(); fireEvent.click(screen.getByRole("button", { name: "Register device" })); const signal = save.mock.calls[0][3] as AbortSignal;
    setup.mockResolvedValue(gateSetup({ user_id: id(90), school_id: id(91) })); rerender(<GateOperationsWorkspace userId={id(90)} schoolId={id(91)} />); expect(signal.aborted).toBe(true); await ready(); await act(async () => result.resolve({ revoked_at: null })); expect(screen.queryByLabelText("Device secret")).not.toBeInTheDocument(); expect(setup).toHaveBeenLastCalledWith(client, id(90), id(91), 0, expect.any(AbortSignal)); expect(unsubscribe).toHaveBeenCalled();
  });
  it("locks outer navigation and warns before discarding a draft, then unlocks on cleanup", async () => {
    setup.mockResolvedValue(emptySetup()); const busy = vi.fn(); const { unmount } = render(<GateOperationsWorkspace {...props} onBusyChange={busy} />); await ready(); expect(busy).toHaveBeenLastCalledWith(false); fireEvent.change(screen.getByLabelText("Device name"), { target: { value: "Draft gate" } }); expect(busy).toHaveBeenLastCalledWith(true); expect(screen.getByRole("button", { name: "Refresh gate access" })).toBeDisabled();
    const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true); fireEvent.click(screen.getByRole("button", { name: "Cancel setup draft" })); expect(busy).toHaveBeenLastCalledWith(false); unmount(); expect(busy).toHaveBeenLastCalledWith(false);
  });
  it("discards a failed read rather than leaving old student names or actions visible", async () => {
    render(<GateOperationsWorkspace {...props} />); await ready(); setup.mockRejectedValueOnce(new GateOperationsError("School access removed", "access")); fireEvent.click(screen.getByRole("button", { name: "Refresh gate access" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("School access removed"); expect(screen.queryByRole("region", { name: "Gate student mappings" })).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Revoke active device" })).not.toBeInTheDocument(); expect(events.mock.calls.at(-1)![4].aborted).toBe(true);
  });
});
