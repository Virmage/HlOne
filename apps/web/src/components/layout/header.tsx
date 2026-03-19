"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Terminal" },
  { href: "/traders", label: "Traders" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--hl-border)] bg-[var(--hl-nav)]">
      <div className="mx-auto flex h-12 max-w-[1200px] items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
              <path d="M0 0C4 0 8 3.5 12 8C8 12.5 4 16 0 16C4 12 4 4 0 0Z" fill="var(--hl-green)" />
              <path d="M24 0C20 0 16 3.5 12 8C16 12.5 20 16 24 16C20 12 20 4 24 0Z" fill="var(--hl-green)" />
            </svg>
            <span className="text-[15px] font-semibold text-[var(--foreground)]">
              CPYCAT.HL
            </span>
          </Link>
          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "px-3 py-1.5 text-[13px] font-medium transition-colors rounded",
                  pathname === item.href || pathname?.startsWith(item.href + "/")
                    ? "text-[var(--foreground)]"
                    : "text-[var(--hl-muted)] hover:text-[var(--hl-text)]"
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <ConnectButton
          accountStatus="address"
          chainStatus="none"
          showBalance={false}
        />
      </div>
    </header>
  );
}
