"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/traders", label: "Trade" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--hl-border)] bg-[var(--background)]">
      <div className="mx-auto flex h-12 max-w-[1200px] items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="var(--hl-green)" strokeWidth="2" />
              <path d="M8 12h8M12 8v8" stroke="var(--hl-green)" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="text-[15px] font-semibold text-[var(--foreground)]">
              Hyperliquid
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
