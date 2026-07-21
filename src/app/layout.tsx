import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kaan | Achievement Reports",
  description: "Arabic-first social media achievement reporting dashboard",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
