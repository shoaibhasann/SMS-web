import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { guardianInvitationUrl, issueGuardianPhoneInvitation, listGuardianInvitations, reinviteGuardianAccess } from "@/lib/guardian-invitations/admin";
import { isInvitationList } from "@/lib/invitations/model";

const phone = "+919876540001";
const issued = { id: "invitation", token: "a".repeat(64), expires_at: "2099-11-06T12:00:00Z" };
const phoneRow = { id: issued.id, email: null, phone, created_at: "2099-11-03T12:00:00Z", expires_at: issued.expires_at, accepted_at: null, revoked_at: null };

function clientResult(data: unknown, error: { code: string; message?: string } | null = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, client: { rpc } as unknown as SupabaseClient };
}

describe("guardian phone invitation client", () => {
  it("uses the scoped phone invitation RPC with a canonical Indian number", async () => {
    const { client, rpc } = clientResult(issued);
    await expect(issueGuardianPhoneInvitation(client, "school", "student", "98765 40001")).resolves.toEqual(issued);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("issue_guardian_phone_invitation", {
      p_school_id: "school", p_student_id: "student", p_phone: phone,
    });
  });

  it("rejects an invalid number before requesting an invitation", async () => {
    const { client, rpc } = clientResult(issued);
    await expect(issueGuardianPhoneInvitation(client, "school", "student", "+12025550100")).rejects.toThrow("valid Indian mobile");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts phone-only guardian history without weakening the shared teacher email validator", async () => {
    const emailRow = { ...phoneRow, email: "family@example.test", phone: null };
    const { client } = clientResult([phoneRow, emailRow]);
    await expect(listGuardianInvitations(client, "school", "student")).resolves.toEqual([phoneRow, emailRow]);
    expect(isInvitationList([phoneRow])).toBe(false);
    expect(isInvitationList([emailRow])).toBe(true);
  });

  it.each([
    { ...phoneRow, email: "other@example.test" },
    { ...phoneRow, phone: null },
    { ...phoneRow, phone: "+12025550100" },
    { ...phoneRow, expires_at: "bad" },
  ])("rejects ambiguous or malformed guardian history (%j)", async (row) => {
    const { client } = clientResult([row]);
    await expect(listGuardianInvitations(client, "school", "student")).rejects.toThrow("Invitation history could not be loaded");
  });

  it("retains phone-only re-invitations and keeps bearer tokens in fragments", async () => {
    const { client } = clientResult({ ...issued, email: null, phone });
    const invitation = await reinviteGuardianAccess(client, "school", "student", "revocation");
    expect(invitation.phone).toBe(phone);
    const link = new URL(guardianInvitationUrl(invitation.token, "https://sms.example.test", "phone"));
    expect(link.pathname).toBe("/guardian-mobile-invite");
    expect(link.search).toBe("");
    expect(link.hash).toBe(`#token=${issued.token}`);
    expect(guardianInvitationUrl(issued.token, link.origin)).toBe(`${link.origin}/guardian-invite#token=${issued.token}`);
  });

  it("returns a safe collision error without exposing database diagnostics", async () => {
    const { client } = clientResult(null, { code: "22023", message: "private user identifier" });
    await expect(issueGuardianPhoneInvitation(client, "school", "student", phone)).rejects.toThrow("existing guardian verify");
  });
});
