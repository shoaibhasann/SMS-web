"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * The 404 page stays static: reading the session on the server would make every route dynamic,
 * because Next renders the root not-found element with each page. getSession() only reads the cookie.
 */
export function HomeLink({ className }: { className?: string }) {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let active = true;
    createClient().auth.getSession().then(({ data }) => { if (active) setSignedIn(Boolean(data.session)); }, () => {});
    return () => { active = false; };
  }, []);
  return <Link href={signedIn ? "/dashboard" : "/login"} className={className}>
    {signedIn ? "Go to your dashboard" : "Sign in"} <ArrowRight size={18} aria-hidden="true" />
  </Link>;
}

/** Steps back through browser history; with nothing to go back to (a fresh tab) it is a plain link to "/". */
export function GoBackLink({ className }: { className?: string }) {
  return (
    <Link href="/" className={className} onClick={(event) => {
      // Modified clicks keep normal link behaviour (open "/" in a new tab or window).
      if (window.history.length < 2 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      window.history.back();
    }}>
      <ArrowLeft size={18} aria-hidden="true" /> Go back
    </Link>
  );
}
