import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom exposes the open attribute but does not implement native dialog methods.
if (typeof HTMLDialogElement !== "undefined" && typeof HTMLDialogElement.prototype.showModal !== "function") {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, writable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, writable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
}

afterEach(() => {
  cleanup();
});
