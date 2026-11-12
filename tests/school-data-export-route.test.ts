// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/school-data/export/route";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getSession: vi.fn(), refreshSession: vi.fn(), getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

const school = "b9a7d887-c9aa-4f27-9c9e-40365238befa";
const calls: { args: Record<string, unknown>; token: string }[] = [];
const request = () => new Request(`https://school.example/api/school-data/export?school=${school}`);
const session = (token: string, secondsLeft: number) => ({ access_token: token, expires_at: Math.floor(Date.now() / 1000) + secondsLeft });

beforeEach(() => {
  vi.resetAllMocks();
  calls.length = 0;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://fixture.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_fixture");
  mocks.getUser.mockResolvedValue({ data: { user: { id: "admin", is_anonymous: false } }, error: null });
  mocks.createClient.mockResolvedValue({
    auth: { getSession: mocks.getSession, refreshSession: mocks.refreshSession, getUser: mocks.getUser },
    rpc: (_name: string, args: Record<string, unknown>) => ({
      setHeader: (_header: string, value: string) => ({
        abortSignal: async () => {
          calls.push({ args, token: value });
          return { data: args.p_dataset === "manifest" ? [{ name: "files", order_key: "source,source_id" }, { name: "schools", order_key: "id" }] : [], error: null };
        },
      }),
    }),
  });
});

describe("school data export route", () => {
  it("refreshes a session that could expire mid-stream and uses the new token for every page", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("old-token", 100) } });
    mocks.refreshSession.mockResolvedValue({ data: { session: session("fresh-token", 3600) }, error: null });

    const response = await GET(request());
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(mocks.getUser).toHaveBeenCalledWith("fresh-token");
    expect(calls.map(({ args }) => args)).toEqual([
      { p_school_id: school, p_dataset: "manifest", p_after: null },
      { p_school_id: school, p_dataset: "files", p_after: null },
      { p_school_id: school, p_dataset: "schools", p_after: null },
    ]);
    expect(new Set(calls.map(({ token }) => token))).toEqual(new Set(["Bearer fresh-token"]));
  });

  it("keeps a long-lived session and rejects a failed refresh", async () => {
    mocks.getSession.mockResolvedValue({ data: { session: session("long-token", 3600) } });
    const ok = await GET(request());
    await ok.arrayBuffer();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    expect(calls[0].token).toBe("Bearer long-token");

    mocks.getSession.mockResolvedValue({ data: { session: session("old-token", 60) } });
    mocks.refreshSession.mockResolvedValue({ data: { session: null }, error: new Error("refresh failed") });
    expect((await GET(request())).status).toBe(401);
  });
});
