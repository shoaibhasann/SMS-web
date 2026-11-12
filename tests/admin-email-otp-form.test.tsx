import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminEmailOtpForm } from "@/components/auth/admin-email-otp-form";

afterEach(() => vi.unstubAllGlobals());

describe("admin email code form", () => {
  it("states the real fifteen-minute throttle window without a misleading short countdown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false }, { status: 429 })));
    render(<AdminEmailOtpForm onBusyChange={() => undefined} onVerified={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "admin@school.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts. Try again in 15 minutes.");
    expect(screen.queryByText(/Try again in \d+s/)).toBeNull();
    expect(screen.getByRole("button", { name: "Send email code" })).toBeEnabled();
  });
});
