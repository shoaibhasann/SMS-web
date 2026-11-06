import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneSecurityCheck } from "@/components/auth/phone-security-check";

vi.mock("next/script", () => ({ default: ({ onReady, onError }: { onReady: () => void; onError: () => void }) => <>
  <button type="button" onClick={onReady}>Load security SDK</button>
  <button type="button" onClick={onError}>Fail security SDK</button>
</> }));
type Options = Parameters<NonNullable<Window["turnstile"]>["render"]>[1];
let options: Options;
const remove = vi.fn();
const renderWidget = vi.fn((_element: HTMLElement, value: Options) => { options = value; return "widget-one"; });
beforeEach(() => { vi.clearAllMocks(); window.turnstile = { render: renderWidget, remove }; });
afterEach(() => { delete window.turnstile; });

describe("phone security check", () => {
  it("forwards successful proof and clears expired proof without exposing the OTP", () => {
    const onToken = vi.fn();
    render(<PhoneSecurityCheck siteKey="public-key" onToken={onToken} />);
    expect(renderWidget).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Load security SDK" }));
    expect(options.sitekey).toBe("public-key");
    expect(options.action).toBe("guardian-otp");
    act(() => { options.callback("proof"); options["expired-callback"](); });
    expect(onToken.mock.calls).toEqual([["proof"], [""]]);
  });

  it("removes its widget on unmount and ignores callbacks from the retired challenge", () => {
    const onToken = vi.fn();
    const view = render(<PhoneSecurityCheck siteKey="public-key" onToken={onToken} />);
    fireEvent.click(screen.getByRole("button", { name: "Load security SDK" }));
    view.unmount();
    expect(remove).toHaveBeenCalledExactlyOnceWith("widget-one");
    act(() => { options.callback("late-proof"); options["expired-callback"](); options["error-callback"](); });
    expect(onToken).not.toHaveBeenCalled();
  });

  it("uses the current handler after a parent update and clears failed proof", () => {
    const oldHandler = vi.fn();
    const nextHandler = vi.fn();
    const view = render(<PhoneSecurityCheck siteKey="public-key" onToken={oldHandler} />);
    fireEvent.click(screen.getByRole("button", { name: "Load security SDK" }));
    view.rerender(<PhoneSecurityCheck siteKey="public-key" onToken={nextHandler} />);
    act(() => { options.callback("current-proof"); options["error-callback"](); });
    expect(oldHandler).not.toHaveBeenCalled();
    expect(nextHandler.mock.calls).toEqual([["current-proof"], [""]]);
    expect(screen.getByRole("alert")).toHaveTextContent("security check could not load");
  });

  it("fails closed when the loaded SDK cannot render a challenge", async () => {
    const onToken = vi.fn();
    renderWidget.mockImplementationOnce(() => { throw new Error("private SDK diagnostic"); });
    render(<PhoneSecurityCheck siteKey="public-key" onToken={onToken} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load security SDK" })); });
    expect(onToken).toHaveBeenCalledExactlyOnceWith("");
    expect(screen.getByRole("alert")).toHaveTextContent("security check could not load");
    expect(screen.queryByText("private SDK diagnostic")).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });
});
