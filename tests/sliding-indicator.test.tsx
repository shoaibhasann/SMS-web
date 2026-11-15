import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlidingIndicator } from "@/components/ui/sliding-indicator";

// jsdom has no layout: place "One" at x=4 and "Two" at x=120, both 4px from the top.
const layout = { offsetLeft: (el: HTMLElement) => (el.textContent === "Two" ? 120 : 4), offsetTop: () => 4, offsetWidth: (el: HTMLElement) => (el.textContent === "Two" ? 90 : 100), offsetHeight: () => 44 };
const originals = Object.fromEntries(Object.keys(layout).map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]));

function Tabs({ initial = "One" }: { initial?: string }) {
  const [view, setView] = useState(initial);
  return (
    <div role="group" aria-label="Views">
      <SlidingIndicator className="rounded-lg bg-blue-600" />
      {["One", "Two"].map((value) => <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}>{value}</button>)}
    </div>
  );
}

describe("SlidingIndicator", () => {
  beforeEach(() => {
    for (const [key, read] of Object.entries(layout)) {
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get(this: HTMLElement) { return read(this); } });
    }
  });
  afterEach(() => {
    for (const [key, descriptor] of Object.entries(originals)) if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  });

  it("sits behind the pressed button, then slides to the newly pressed one", async () => {
    const { container } = render(<Tabs />);
    const group = screen.getByRole("group", { name: "Views" });
    const indicator = container.querySelector<HTMLElement>("[data-sliding-indicator]")!;

    expect(indicator).toHaveAttribute("aria-hidden", "true");
    expect(group).toHaveAttribute("data-slider", "ready");
    expect(indicator).toHaveAttribute("data-ready");
    expect(indicator.style.transform).toBe("translate(4px, 4px)");
    expect(indicator.style.width).toBe("100px");
    expect(indicator.style.height).toBe("44px");

    fireEvent.click(screen.getByRole("button", { name: "Two" }));
    await waitFor(() => expect(indicator.style.transform).toBe("translate(120px, 4px)"));
    expect(indicator.style.width).toBe("90px");
    expect(indicator).toHaveAttribute("data-ready");
    expect(screen.getByRole("button", { name: "Two" })).toHaveAttribute("aria-pressed", "true");
  });

  it("stays hidden while no button is pressed", () => {
    const { container } = render(<Tabs initial="" />);
    expect(container.querySelector("[data-sliding-indicator]")).not.toHaveAttribute("data-ready");
    expect(screen.getByRole("group", { name: "Views" })).toHaveAttribute("data-slider", "ready");
  });
});
