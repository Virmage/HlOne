"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import { useAccountInfo } from "@/hooks/use-account-info";

// Lazy-load wallet button to avoid wagmi hooks during SSR
const WalletButton = dynamic(
  () => import("./wallet-button").then(mod => ({ default: mod.WalletButton })),
  {
    ssr: false,
    loading: () => (
      <button className="h-7 px-4 rounded-[10px] text-[11px] font-semibold bg-[var(--hl-accent,var(--hl-green))] text-[var(--background)]">
        Connect
      </button>
    ),
  }
);

const navItems = [
  { href: "/", label: "Terminal" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/studio", label: "Studio" },
  { href: "/security", label: "Security" },
];

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="flex items-center justify-center w-7 h-7 rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] transition-colors"
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

function Logo() {
  const { theme } = useTheme();
  return (
    <img
      src={theme === "light" ? "/logo-light.png" : "/logo-dark.png"}
      alt="HlOne"
      className="h-[22px] sm:h-[28px] w-auto"
    />
  );
}

function AccountDisplay() {
  const info = useAccountInfo();
  if (!info) return null;
  const pnl = info.unrealizedPnl;
  return (
    <div className="hidden sm:flex items-center gap-2.5 text-[11px] tabular-nums mr-1">
      <span className="text-[var(--hl-accent)]">
        <span className="text-[var(--hl-muted)] font-normal">Acct:</span>{" "}
        <span className="font-medium">${info.accountValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      </span>
      <span className={pnl >= 0 ? "text-[var(--hl-green)]" : "text-[var(--hl-red)]"}>
        <span className="text-[var(--hl-muted)] font-normal">uPnL:</span>{" "}
        {pnl >= 0 ? "+" : ""}${pnl.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}

export function Header() {
  const pathname = usePathname();

  // Hide header on landing page
  if (pathname === "/landing") return null;

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--hl-border)] bg-[var(--hl-nav)]">
      <div className="flex h-10 items-center justify-between px-2 sm:px-6 lg:px-8">
        <div className="flex items-center gap-2 sm:gap-5 min-w-0">
          <Link href="/" className="flex items-center shrink-0">
            <Logo />
          </Link>
          {/* Desktop nav — hidden on mobile (bottom tabs used instead) */}
          <div className="hidden sm:block">
          <nav className="nav-pills">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                data-active={pathname === item.href || pathname?.startsWith(item.href + "/")}
                className={cn(
                  "transition-colors",
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
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Theme toggle — desktop only (in Account tab on mobile) */}
          <div className="hidden sm:block">
            <ThemeToggle />
          </div>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
