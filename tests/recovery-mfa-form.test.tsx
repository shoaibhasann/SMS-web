import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { UpdatePasswordForm } from "@/app/(auth)/update-password/update-password-form";

const sessionId = "00000000-0000-4000-8000-000000000001";
const factors = [{ id: "00000000-0000-4000-8000-000000000002", friendly_name: "Main phone" }, { id: "00000000-0000-4000-8000-000000000003", friendly_name: "Backup" }];
afterEach(() => vi.unstubAllGlobals());
function enterCode(value = "123456") {
  fireEvent.change(screen.getByLabelText("Six-digit authenticator code"), { target: { value } });
  fireEvent.submit(screen.getByRole("form", { name: "Verify password recovery authenticator" }));
}
describe("MFA-aware password recovery form", () => {
  it("keeps passwords hidden on wrong code, verifies the selected backup, then submits only the bound recovery session", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 422 })).mockResolvedValueOnce(new Response("{}", { status: 200 })).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    render(<UpdatePasswordForm sessionId={sessionId} mfaRequired factors={factors} />);
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Authenticator"), { target: { value: factors[1].id } });
    enterCode(); expect(await screen.findByRole("alert")).toHaveTextContent("not accepted");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Six-digit authenticator code")).toHaveValue("");
    enterCode("654321"); await screen.findByLabelText("New password");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ sessionId, factorId: factors[1].id, code: "654321" });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-strong-pass123" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-new-strong-pass123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Password updated");
    expect(fetch.mock.calls[2][0]).toBe("/auth/recovery/complete");
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({ sessionId, password: "a-new-strong-pass123" });
  });
  it("fails closed when the recovery session changes and does not expose a password form", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    render(<UpdatePasswordForm sessionId={sessionId} mfaRequired factors={factors} />); enterCode();
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer active");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });
  it("clears the draft and returns to verification if MFA becomes required while the password form is open", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"error":"mfa_required"}', { status: 409 })));
    render(<UpdatePasswordForm sessionId={sessionId} factors={factors} />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a-new-strong-pass123" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "a-new-strong-pass123" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));
    await screen.findByLabelText("Six-digit authenticator code");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("security changed");
  });
});
