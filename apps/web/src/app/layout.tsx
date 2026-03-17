import type { Metadata } from "next";
import { Providers } from "@/components/layout/providers";
import { Header } from "@/components/layout/header";
import "./globals.css";

export const metadata: Metadata = {
  title: "CPYCAT.HL",
  description: "Copy top Hyperliquid traders automatically",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body
        className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased"
      >
        <Providers>
          <Header />
          <main className="mx-auto max-w-[1200px] px-6 py-8">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
