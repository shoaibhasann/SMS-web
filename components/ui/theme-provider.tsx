"use client";
import { usePathname } from "next/navigation";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const isLogin = usePathname() === "/login";

  // A separate scope keeps login on System without overwriting saved workspace choices.
  return (
    <NextThemesProvider
      {...props}
      key={isLogin ? "login-system" : "workspace"}
      storageKey={isLogin ? "sms-login-system" : props.storageKey}
      defaultTheme="system"
      enableSystem
    >
      {children}
    </NextThemesProvider>
  );
}
