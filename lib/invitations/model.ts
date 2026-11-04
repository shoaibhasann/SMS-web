export type SchoolInvitation = {
  id: string;
  email: string;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

export type IssuedInvitation = Pick<SchoolInvitation, "id" | "expires_at"> & { token: string };

export function invitationStatus(invitation: SchoolInvitation, now: number) {
  if (invitation.accepted_at) return "Accepted";
  if (invitation.revoked_at) return "Revoked";
  return Date.parse(invitation.expires_at) <= now ? "Expired" : "Pending";
}

export function isInvitationList(value: unknown): value is SchoolInvitation[] {
  return Array.isArray(value) && value.every((item: Partial<SchoolInvitation> | null) =>
    item && typeof item.id === "string" && typeof item.email === "string" &&
    typeof item.expires_at === "string" && Number.isFinite(Date.parse(item.expires_at)),
  );
}

export function isIssuedInvitation(value: unknown): value is IssuedInvitation {
  const item = value as Partial<IssuedInvitation> | null;
  return !!item && typeof item.id === "string" && typeof item.token === "string" &&
    /^[a-f0-9]{64}$/.test(item.token) && typeof item.expires_at === "string" &&
    Number.isFinite(Date.parse(item.expires_at));
}
