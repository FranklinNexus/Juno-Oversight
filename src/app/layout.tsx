import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Juno Oversight HUD",
  description: "Tactical command HUD for real-time surveillance.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full bg-[var(--bg-base)] text-[var(--text-porcelain)] font-sans">
        {children}
      </body>
    </html>
  );
}
