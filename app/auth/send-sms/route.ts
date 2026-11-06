import { sendGuardianSms } from "@/lib/auth/sms-delivery";

export const runtime = "nodejs";
export const POST = sendGuardianSms;
