"use client";

import { useState } from "react";

export default function LandingPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return (
    <div className="landing">
      {/* ── Nav ────────────────────────────────────────────────── */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 sm:px-10 py-4 bg-[#060a0c]/60 backdrop-blur-md border-b border-white/5">
        <div className="flex items-center gap-2">
          <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
            <path d="M0 0C4 0 8 3.5 12 8C8 12.5 4 16 0 16C4 12 4 4 0 0Z" fill="#00f0ff" />
            <path d="M24 0C20 0 16 3.5 12 8C16 12.5 20 16 24 16C20 12 20 4 24 0Z" fill="#00f0ff" />
          </svg>
          <span className="text-[15px] font-semibold tracking-tight text-white">HLOne</span>
        </div>
        <span className="text-xs font-medium tracking-widest uppercase text-[#00f0ff]/60">Coming Soon</span>
      </nav>

      {/* ── Hero: full-screen video + floating overlay ─────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">
        {/* Video background — replace /landing-demo.mp4 with your video */}
        <video
          autoPlay
          loop
          muted
          playsInline
          className="absolute inset-0 w-full h-full object-cover"
          poster="/landing-poster.jpg"
        >
          <source src="/landing-demo.mp4" type="video/mp4" />
        </video>

        {/* Dark overlay gradient — ensures text readability */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#060a0c]/70 via-[#060a0c]/40 to-[#060a0c]/80" />

        {/* Floating content */}
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
          {/* Logo mark */}
          <div className="flex justify-center mb-8">
            <svg width="56" height="38" viewBox="0 0 24 16" fill="none" className="opacity-90 drop-shadow-[0_0_20px_rgba(0,240,255,0.3)]">
              <path d="M0 0C4 0 8 3.5 12 8C8 12.5 4 16 0 16C4 12 4 4 0 0Z" fill="#00f0ff" />
              <path d="M24 0C20 0 16 3.5 12 8C16 12.5 20 16 24 16C20 12 20 4 24 0Z" fill="#00f0ff" />
            </svg>
          </div>

          <h1 className="text-5xl sm:text-7xl font-bold tracking-tight text-white leading-[1.1] mb-6 drop-shadow-[0_2px_40px_rgba(0,0,0,0.5)]">
            Your Hyperliquid<br />
            <span className="text-[#00f0ff] drop-shadow-[0_0_30px_rgba(0,240,255,0.25)]">Homepage</span>
          </h1>

          <p className="text-lg sm:text-xl text-white/70 max-w-xl mx-auto mb-12 leading-relaxed drop-shadow-[0_1px_10px_rgba(0,0,0,0.5)]">
            One terminal for everything. Perps, options, whale flows, copy trading, signals and more.
          </p>

          {/* Email signup */}
          {!submitted ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!email.includes("@")) return;
                try {
                  await fetch("https://formspree.io/f/mojpbvjv", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email }),
                  });
                  setSubmitted(true);
                } catch { setSubmitted(true); }
              }}
              className="flex flex-col sm:flex-row items-center gap-3 max-w-md mx-auto"
            >
              <input
                type="email"
                placeholder="your@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full sm:flex-1 px-4 py-3 rounded-lg bg-black/40 backdrop-blur-sm border border-white/15 text-white placeholder-white/30 text-sm focus:outline-none focus:border-[#00f0ff]/50 focus:ring-1 focus:ring-[#00f0ff]/25 transition-colors"
              />
              <button
                type="submit"
                className="w-full sm:w-auto px-6 py-3 rounded-lg bg-[#00f0ff] text-[#060a0c] text-sm font-semibold hover:bg-[#00f0ff]/90 transition-colors whitespace-nowrap shadow-[0_0_20px_rgba(0,240,255,0.3)]"
              >
                Get early access
              </button>
            </form>
          ) : (
            <div className="flex items-center justify-center gap-2 text-[#00f0ff] text-sm font-medium drop-shadow-[0_0_10px_rgba(0,240,255,0.3)]">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              You&apos;re on the list. We&apos;ll be in touch.
            </div>
          )}
        </div>

        {/* Scroll hint */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-white/30 z-10">
          <span className="text-[11px] uppercase tracking-widest">Explore</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="animate-bounce">
            <path d="M7 2v10M3 8l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </section>

      {/* ── Features grid ─────────────────────────────────────── */}
      <section className="relative px-6 sm:px-10 py-24 max-w-5xl mx-auto">
        <h2 className="text-2xl sm:text-3xl font-bold text-white text-center mb-4">
          Everything you need. <span className="text-[#00f0ff]">Nothing you don&apos;t.</span>
        </h2>
        <p className="text-[#6a8a94] text-center max-w-lg mx-auto mb-16">
          Built for traders who live on Hyperliquid. Fast, focused, and free.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <FeatureCard
            icon={<ChartIcon />}
            title="Full Trading Terminal"
            description="Place orders, manage positions, set TP/SL — all from one screen with real-time data."
          />
          <FeatureCard
            icon={<WhaleIcon />}
            title="Whale & Smart Money Flow"
            description="See what the top wallets are doing. Large trades, position changes, and funding plays."
          />
          <FeatureCard
            icon={<CopyIcon />}
            title="Copy Trading"
            description="Follow profitable traders with one click. Automatic position mirroring with configurable sizing."
          />
          <FeatureCard
            icon={<PulseIcon />}
            title="Market Signals"
            description="Funding divergence, OI spikes, liquidation clusters — actionable signals, not noise."
          />
          <FeatureCard
            icon={<StackIcon />}
            title="Portfolio Overview"
            description="Track all your positions, PnL history, and account health across one dashboard."
          />
          <FeatureCard
            icon={<BoltIcon />}
            title="Fast. Really Fast."
            description="Optimized for speed. Lazy-loaded panels, cached data, and instant chart switching."
          />
        </div>
      </section>

      {/* ── Bottom CTA ────────────────────────────────────────── */}
      <section className="px-6 sm:px-10 py-24 text-center">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Stop switching tabs.
          </h2>
          <p className="text-[#6a8a94] text-lg mb-10">
            HLOne brings your entire Hyperliquid workflow into one place.
          </p>
          <div className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[#00f0ff]/20 bg-[#00f0ff]/[0.05] text-[#00f0ff] text-sm font-medium">
            <span className="w-2 h-2 rounded-full bg-[#00f0ff] animate-pulse" />
            Coming Soon
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────────── */}
      <footer className="px-6 sm:px-10 py-8 border-t border-white/5 flex items-center justify-between text-[11px] text-[#3a5058]">
        <div className="flex items-center gap-2">
          <svg width="14" height="10" viewBox="0 0 24 16" fill="none">
            <path d="M0 0C4 0 8 3.5 12 8C8 12.5 4 16 0 16C4 12 4 4 0 0Z" fill="#3a5058" />
            <path d="M24 0C20 0 16 3.5 12 8C16 12.5 20 16 24 16C20 12 20 4 24 0Z" fill="#3a5058" />
          </svg>
          <span>HLOne</span>
        </div>
        <span>Built for Hyperliquid</span>
      </footer>
    </div>
  );
}

/* ── Feature card ──────────────────────────────────────────────── */

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="group p-5 rounded-xl border border-white/5 bg-white/[0.02] hover:border-[#00f0ff]/15 hover:bg-[#00f0ff]/[0.03] transition-all duration-300">
      <div className="w-9 h-9 rounded-lg bg-[#00f0ff]/[0.08] flex items-center justify-center text-[#00f0ff] mb-3">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-white mb-1.5">{title}</h3>
      <p className="text-[13px] text-[#6a8a94] leading-relaxed">{description}</p>
    </div>
  );
}

/* ── Icons ─────────────────────────────────────────────────────── */

function ChartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2 14L6 9L10 11L16 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WhaleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 5.5V9L11.5 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="5" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 5V4.5A1.5 1.5 0 018.5 3H13.5A1.5 1.5 0 0115 4.5V11.5A1.5 1.5 0 0113.5 13H11" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PulseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2 9H5L7 4L9 14L11 7L13 9H16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M2 9L9 13L16 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 5L9 9L16 5L9 1L2 5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 13L9 17L16 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M10 2L4 10H9L8 16L14 8H9L10 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
