import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import ActivatePage from "@/app/(dashboard)/activate/page";

const { rpc, router } = vi.hoisted(() => ({ rpc: vi.fn(), router: { replace: vi.fn(), refresh: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc }) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
beforeEach(() => { vi.clearAllMocks(); rpc.mockResolvedValue({ data: null, error: null }); });

it("tells a Google-signed-in Student how to get an app password, without changing activation", async () => {
  render(<ActivatePage />);
  fireEvent.click(screen.getByRole("button", { name: /Student/ }));
  expect(screen.getByText(/Signed in with Google\? To use the SMS Android app, set a password/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Admission number"), { target: { value: " ADM-1 " } });
  fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "2012-04-01" } });
  expect(screen.getByLabelText("Registered mobile")).toHaveAttribute("autocomplete", "tel");
  fireEvent.change(screen.getByLabelText("Registered mobile"), { target: { value: "9876543210" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify & activate account" }));
  await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/dashboard"));
  expect(rpc).toHaveBeenCalledWith("activate_student", { p_admission_no: "ADM-1", p_dob: "2012-04-01", p_mobile: "9876543210" });
});

it("tells a Guardian the invitation may be for an email or a mobile number, and keeps the Teacher copy email-only", () => {
  render(<ActivatePage />);
  expect(screen.getByText("Ask your school to send you an invitation link. Open the link and sign in using the email address your school invited.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Parent/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Guardian/ }));
  expect(screen.getByText(/verify the same email address or mobile number the school invited/)).toBeInTheDocument();
  expect(screen.queryByText(/sign in using the email address your school invited/)).not.toBeInTheDocument();
});

it.each(["+91 98765 43210", "+919876543210", "09876543210", "98765-43210"])("sends Student mobile %s as the registered 10-digit number", async (typed) => {
  render(<ActivatePage />);
  fireEvent.click(screen.getByRole("button", { name: /Student/ }));
  fireEvent.change(screen.getByLabelText("Admission number"), { target: { value: "ADM-1" } });
  fireEvent.change(screen.getByLabelText("Date of birth"), { target: { value: "2012-04-01" } });
  fireEvent.change(screen.getByLabelText("Registered mobile"), { target: { value: typed } });
  fireEvent.click(screen.getByRole("button", { name: "Verify & activate account" }));
  await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith("activate_student", { p_admission_no: "ADM-1", p_dob: "2012-04-01", p_mobile: "9876543210" }));
});

it("tells a phone-only Guardian to set an app password on the website before using the Android app", () => {
  render(<ActivatePage />);
  fireEvent.click(screen.getByRole("button", { name: /^Guardian/ }));
  expect(screen.getByText(/Signed in with a mobile number\? To use the SMS Android app, set an app password in Account settings → guardian contact settings, then sign in to the app with your mobile number and that password\./)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Teacher/ }));
  expect(screen.queryByText(/set an app password/)).not.toBeInTheDocument();
});
