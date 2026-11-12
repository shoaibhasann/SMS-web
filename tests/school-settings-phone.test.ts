// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateSchoolDetails, type SchoolDetails } from "@/lib/admin/school-settings";

const details: SchoolDetails = { name: "QA School", board: "CBSE", affiliation_no: null, address: null, city: null, state: null, pincode: null, phone: null, email: null, website: null };

describe("school office phone validation", () => {
  it.each(["(0522) 2345678", "(0522)-2345678", "+91 (522) 2345678", "0522-2345678"])("accepts %s as the message promises", (phone) => {
    expect(validateSchoolDetails({ ...details, phone })).toBeNull();
  });

  it.each(["+(91) 1234567", "-0522 2345678", " (05) 2", "(0522) 2345678 ext9"])("still rejects %s", (phone) => {
    expect(validateSchoolDetails({ ...details, phone })).toMatch(/7–15 digits/);
  });
});
