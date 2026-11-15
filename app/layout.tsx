import "./globals.css";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/ui/theme-provider";

const sora = localFont({
  src: "./fonts/Sora-Variable.ttf",
  weight: "100 800",
  display: "swap",
  variable: "--font-sms",
});

export const metadata = { title: "SMS | School Management System", description: "School Management System" };
export const viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#f5f7fb" }, { media: "(prefers-color-scheme: dark)", color: "#0b1020" }] };
export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en" className={sora.variable} suppressHydrationWarning><body><ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>{children}</ThemeProvider></body></html>;
}
