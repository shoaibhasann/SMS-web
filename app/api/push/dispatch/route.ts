import { dispatchNativePush } from "@/lib/notifications/push-dispatch";

export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = dispatchNativePush;
