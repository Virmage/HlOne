"use client";

import { useState } from "react";

export default function LandingPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  return (
    <div className="landing h-screen overflow-hidden">
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

      {/* ── Full-screen video + floating overlay ──────────────── */}
      <section className="relative h-screen flex flex-col items-center justify-center overflow-hidden">
        {/* Video background */}
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

        {/* Dark overlay */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#060a0c]/70 via-[#060a0c]/40 to-[#060a0c]/80" />

        {/* Floating content */}
        <div className="relative z-10 max-w-3xl mx-auto text-center px-6">
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
      </section>
    </div>
  );
}
