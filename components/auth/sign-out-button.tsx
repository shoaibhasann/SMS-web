"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/** Local sign-out for error screens that render outside the app shell. */
export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);

  async function signOut() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const { error: authError } = await createClient().auth.signOut({ scope: "local" });
      if (authError) throw authError;
      router.replace("/login");
      router.refresh();
    } catch {
      setError("Sign out failed. Please try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <>
    <button type="button" className={className} onClick={signOut} disabled={pending}>{pending ? "Signing out…" : "Sign out"}</button>
    {error && <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>}
  </>;
}
