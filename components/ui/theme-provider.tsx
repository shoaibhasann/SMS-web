"use client";
import { usePathname } from "next/navigation";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useSyncExternalStore } from "react";
import type { ThemeProviderProps } from "next-themes";

const query = "(prefers-color-scheme: dark)";
const subscribe = (changed: () => void) => {
  const media = window.matchMedia(query);
  media.addListener(changed);
  return () => media.removeListener(changed);
};
const deviceTheme = () => window.matchMedia(query).matches ? "dark" : "light";
const serverTheme = () => "light";
// Runs once from SSR, after next-themes' bootstrap and before the login paints.
const loginBootstrap = `(()=>{if(location.pathname==='/login'){const d=matchMedia('${query}').matches;document.documentElement.classList.toggle('dark',d);document.documentElement.classList.toggle('light',!d);document.documentElement.style.colorScheme=d?'dark':'light';}})();`;

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const isLogin = usePathname() === "/login";
  const systemTheme = useSyncExternalStore(subscribe, deviceTheme, serverTheme);

  // Keep one provider; remounting it on navigation recreates its inline script.
  return (
    <NextThemesProvider
      {...props}
      forcedTheme={isLogin ? systemTheme : props.forcedTheme}
      defaultTheme="system"
      enableSystem
    >
      <script nonce={props.nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: loginBootstrap }} />
      {children}
    </NextThemesProvider>
  );
}
