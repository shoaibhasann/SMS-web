"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

type Turnstile = {
  render: (element: HTMLElement, options: {
    sitekey: string; action: string; theme: string; size: string;
    callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void;
  }) => string;
  remove: (id: string) => void;
};

declare global { interface Window { turnstile?: Turnstile } }

export function PhoneSecurityCheck({ siteKey, onToken }: { siteKey: string; onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const onTokenRef = useRef(onToken);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => { onTokenRef.current = onToken; }, [onToken]);
  useEffect(() => {
    const api = window.turnstile;
    if (!ready || !api || !container.current) return;
    let active = true;
    let id: string | undefined;
    try {
      id = api.render(container.current, {
        sitekey: siteKey, action: "guardian-otp", theme: "auto", size: "flexible",
        callback: (token) => { if (active) onTokenRef.current(token); },
        "expired-callback": () => { if (active) onTokenRef.current(""); },
        "error-callback": () => { if (active) { onTokenRef.current(""); setFailed(true); } },
      });
    } catch {
      queueMicrotask(() => { if (active) { onTokenRef.current(""); setFailed(true); } });
    }
    return () => { active = false; if (id !== undefined) api.remove(id); };
  }, [ready, siteKey]);

  return <div className="min-w-0 space-y-2">
    <Script id="guardian-phone-security" src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
      onReady={() => setReady(true)} onError={() => { onTokenRef.current(""); setFailed(true); }} />
    <div ref={container} aria-label="Mobile sign-in security check" />
    {failed && <p role="alert" className="login-error">The security check could not load. Refresh and try again.</p>}
  </div>;
}
