"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";

// Lazy-load wallet button to avoid wagmi hooks during SSR
const WalletButton = dynamic(
  () => import("./wallet-button").then(mod => ({ default: mod.WalletButton })),
  {
    ssr: false,
    loading: () => (
      <button className="h-7 px-3 rounded-md text-[11px] font-medium bg-[var(--hl-green)] text-[var(--background)]">
        Connect
      </button>
    ),
  }
);

const navItems = [
  { href: "/dashboard", label: "Terminal" },
  { href: "/traders", label: "Traders" },
  { href: "/portfolio", label: "Portfolio" },
];

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="flex items-center justify-center w-7 h-7 rounded-md border border-[var(--hl-border)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] transition-colors"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--hl-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--hl-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--hl-border)] bg-[var(--hl-nav)]">
      <div className="flex h-10 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3 sm:gap-6">
          <Link href="/" className="flex items-center gap-1.5 shrink-0">
            <svg width="20" height="14" viewBox="0 0 24 16" fill="none">
              <path d="M0 0C4 0 8 3.5 12 8C8 12.5 4 16 0 16C4 12 4 4 0 0Z" fill="var(--hl-green)" />
              <path d="M24 0C20 0 16 3.5 12 8C16 12.5 20 16 24 16C20 12 20 4 24 0Z" fill="var(--hl-green)" />
            </svg>
            <span className="text-[13px] font-semibold text-[var(--foreground)]">
              HLOne
            </span>
          </Link>
          <nav className="flex items-center gap-0">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "px-1.5 sm:px-2.5 py-1 text-[11px] sm:text-[12px] font-medium transition-colors rounded",
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
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
