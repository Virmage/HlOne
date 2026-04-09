import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "HlOne – Hyperliquid Homepage",
  description: "Perps, options and data.",
};

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  // Override root layout padding — landing is full-bleed
  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-8 -mt-6 min-h-screen bg-[#060a0c] text-white">
      {children}
    </div>
  );
}
