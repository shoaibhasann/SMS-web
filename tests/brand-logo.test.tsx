import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { BrandLogo } from "@/components/ui/brand-logo";

// The logo file is imported by the component, so a missing or renamed file already fails this import.
it("renders the SMS logo as a decorative square image", () => {
  const image = render(<BrandLogo size={28} />).container.querySelector("img")!;
  expect(image).toHaveAttribute("alt", "");
  expect(image).toHaveAttribute("width", "28");
  expect(image).toHaveAttribute("height", "28");
  expect(image.getAttribute("src")).toContain("sms-logo");
});
