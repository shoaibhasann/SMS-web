import "./globals.css";
import { ThemeProvider } from "@/components/ui/theme-provider";

export const metadata = { title: "SMS | School Management System", description: "School Management System" };
export default function RootLayout({children}:{children:React.ReactNode}){
  return <html lang="en" suppressHydrationWarning><body><ThemeProvider attribute="class" defaultTheme="system" enableSystem>{children}</ThemeProvider></body></html>;
}
