"use client";

/**
 * HLOne Studio — Build your own HLOne.
 *
 * Users pick a template, toggle widgets, set branding + fees, then deploy.
 * Live preview on the right (iframe of the terminal with config injected).
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import Link from "next/link";
import { useSafeAccount } from "@/hooks/use-safe-account";
import {
  type StudioConfig,
  type WidgetKey,
  WIDGET_CATALOG,
  MAX_MARKUP_BPS,
  HLONE_PLATFORM_FEE_BPS,
  validateConfig,
  DEFAULT_CONFIG,
} from "@/lib/studio-config";
import { STUDIO_TEMPLATES } from "@/lib/studio-templates";

type Step = "template" | "customize" | "deploy";

export default function StudioPage() {
  const { address, isConnected } = useSafeAccount();
  const [step, setStep] = useState<Step>("template");
  const [config, setConfig] = useState<StudioConfig>(DEFAULT_CONFIG);
  const [deployStatus, setDeployStatus] = useState<"idle" | "paying" | "deploying" | "done" | "error">("idle");
  const [deployError, setDeployError] = useState<string>("");
  const [deployResult, setDeployResult] = useState<{ repoUrl?: string; deployUrl?: string; apiKey?: string; devMode?: boolean; note?: string } | null>(null);

  // Preview mode = env vars not set yet. We detect via the public payments wallet var.
  const isPreviewMode = !process.env.NEXT_PUBLIC_HLONE_PAYMENTS_WALLET;

  const validation = useMemo(() => validateConfig(config), [config]);

  const toggleWidget = (key: WidgetKey) => {
    setConfig(prev => ({
      ...prev,
      widgets: { ...prev.widgets, [key]: !prev.widgets[key] },
    }));
  };

  const update = <K extends keyof StudioConfig>(key: K, value: StudioConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const updateBranding = <K extends keyof StudioConfig["branding"]>(key: K, value: StudioConfig["branding"][K]) => {
    setConfig(prev => ({ ...prev, branding: { ...prev.branding, [key]: value } }));
  };

  const handleDeploy = useCallback(async () => {
    if (!validation.ok || !address) return;
    setDeployStatus("paying");
    setDeployError("");

    try {
      // Step 1: Get payment instructions (or dev-mode skip)
      const instructRes = await fetch("/api/studio/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: validation.config, wallet: address }),
      });
      const instructData = await instructRes.json();

      if (!instructRes.ok) {
        throw new Error(instructData.error || "Payment init failed");
      }

      let sessionId: string = instructData.sessionId;

      // Dev mode: no payments wallet configured, skip payment
      if (instructData.skipPayment) {
        // Fall through to deploy directly
      } else if (instructData.paymentRequired) {
        // Real payment flow: send USDC on Arbitrum
        const { amountUsdc, tokenAddress, chainId, recipient } = instructData;

        const [wagmiCore, wagmiConfig, viem] = await Promise.all([
          import("@wagmi/core"),
          import("@/config/wagmi"),
          import("viem"),
        ]);

        // Switch to Arbitrum if needed
        try {
          await wagmiCore.switchChain(wagmiConfig.config, { chainId });
        } catch (chainErr) {
          console.warn("[studio] Chain switch failed:", (chainErr as Error).message);
        }

        // Build USDC transfer calldata
        const transferData = viem.encodeFunctionData({
          abi: viem.parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
          functionName: "transfer",
          args: [recipient as `0x${string}`, viem.parseUnits(amountUsdc.toString(), 6)],
        });

        setDeployStatus("paying");
        const txHash = await wagmiCore.sendTransaction(wagmiConfig.config, {
          chainId,
          to: tokenAddress as `0x${string}`,
          data: transferData,
          value: BigInt(0),
        });

        // Wait for on-chain confirmation
        await wagmiCore.waitForTransactionReceipt(wagmiConfig.config, {
          chainId,
          hash: txHash,
          timeout: 120_000,
        });

        // Submit txHash to backend for verification
        const verifyRes = await fetch("/api/studio/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config: validation.config, wallet: address, txHash }),
        });
        const verifyData = await verifyRes.json();
        if (!verifyRes.ok || !verifyData.ok) {
          throw new Error(verifyData.error || "Payment verification failed");
        }
        sessionId = verifyData.sessionId;
      }

      // Step 2: deploy
      setDeployStatus("deploying");
      const deployRes = await fetch("/api/studio/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: validation.config, wallet: address, sessionId }),
      });
      const deployData = await deployRes.json();

      if (!deployRes.ok) {
        throw new Error(deployData.error || "Deploy failed");
      }

      setDeployResult(deployData);
      setDeployStatus("done");
    } catch (err) {
      setDeployStatus("error");
      setDeployError((err as Error).message);
    }
  }, [validation, address]);

  return (
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <header className="border-b border-[var(--hl-border)] px-6 py-3 flex items-center justify-between sticky top-0 z-40 bg-[var(--background)]">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-[15px] font-semibold text-[var(--foreground)]">
            HLOne <span className="text-[var(--hl-accent)]">Studio</span>
          </Link>
          <span className="text-[10px] text-[var(--hl-muted)] hidden sm:inline">Build your own HyperLiquid terminal</span>
        </div>
        <nav className="flex items-center gap-1 text-[11px]" aria-label="Studio steps">
          {(["template", "customize", "deploy"] as Step[]).map((s, i) => {
            const isActive = step === s;
            const currentIdx = (["template", "customize", "deploy"] as Step[]).indexOf(step);
            const visited = i <= currentIdx;
            return (
              <div key={s} className="flex items-center">
                {i > 0 && (
                  <span className={`mx-1 text-[10px] ${visited ? "text-[var(--hl-accent)]" : "text-[var(--hl-muted)]"}`}>→</span>
                )}
                <button
                  onClick={() => setStep(s)}
                  className={`px-3 py-1.5 rounded transition-colors ${
                    isActive
                      ? "bg-[var(--hl-accent)] text-[var(--background)] font-medium"
                      : visited
                      ? "text-[var(--hl-accent)] hover:bg-[var(--hl-accent)]/10"
                      : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
                  }`}
                >
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-current/20 mr-1.5 text-[9px] font-bold">
                    {i + 1}
                  </span>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              </div>
            );
          })}
        </nav>
      </header>

      {isPreviewMode && (
        <div className="border-b border-[#f5a524]/40 bg-[#f5a524]/10 px-4 py-2 text-center">
          <div className="text-[11px] text-[#f5a524]">
            <span className="font-semibold">PREVIEW MODE</span> · Studio is live but real deploys are disabled. Explore the flow freely — no payment, no repo fork, no Vercel deploy will happen yet.
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row h-[calc(100vh-49px)]">
        {/* LEFT: Form */}
        <div className="lg:w-[520px] flex-shrink-0 border-r border-[var(--hl-border)] overflow-y-auto">
          {step === "template" && (
            <TemplateStep
              currentConfig={config}
              onPick={(tmpl) => setConfig(tmpl.config)}
              onNext={() => setStep("customize")}
            />
          )}
          {step === "customize" && (
            <CustomizeStep
              config={config}
              toggleWidget={toggleWidget}
              update={update}
              updateBranding={updateBranding}
              onBack={() => setStep("template")}
              onNext={() => setStep("deploy")}
            />
          )}
          {step === "deploy" && (
            <DeployStep
              config={config}
              validation={validation}
              deployStatus={deployStatus}
              deployError={deployError}
              deployResult={deployResult}
              onDeploy={handleDeploy}
              onBack={() => setStep("customize")}
              walletConnected={isConnected}
              isPreviewMode={isPreviewMode}
            />
          )}
        </div>

        {/* RIGHT: Live Preview */}
        <div className="flex-1 min-w-0 bg-[var(--hl-surface)] overflow-hidden">
          <div className="h-full flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--hl-border)] bg-[var(--background)]">
              <div className="text-[11px] text-[var(--hl-muted)]">Live Preview — {config.name}</div>
              <div className="flex items-center gap-2 text-[10px] text-[var(--hl-muted)]">
                <span>{Object.values(config.widgets).filter(Boolean).length} widgets</span>
                <span>·</span>
                <span className="font-mono">{config.branding.accentColor}</span>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <LivePreview config={config} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Template Picker Step ───────────────────────────────────────────────────

function TemplateStep({
  currentConfig,
  onPick,
  onNext,
}: {
  currentConfig: StudioConfig;
  onPick: (t: typeof STUDIO_TEMPLATES[number]) => void;
  onNext: () => void;
}) {
  // Identify which template (if any) is currently selected by matching slug
  const selectedId = STUDIO_TEMPLATES.find(t => t.config.slug === currentConfig.slug)?.id;

  return (
    <div className="p-6 pb-24 lg:pb-6">
      <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Pick a starting template</h2>
      <p className="text-[11px] text-[var(--hl-muted)] mt-1">
        Click to preview each template in the live preview on the right. Pick one to start from, then customize.
      </p>

      <div className="mt-5 space-y-2">
        {STUDIO_TEMPLATES.map(t => {
          const isSelected = t.id === selectedId;
          const widgetCount = Object.values(t.config.widgets).filter(Boolean).length;
          return (
            <button
              key={t.id}
              onClick={() => onPick(t)}
              className={`w-full text-left p-4 rounded-lg border transition-all ${
                isSelected
                  ? "border-[var(--hl-accent)] bg-[var(--hl-accent)]/10 ring-2 ring-[var(--hl-accent)]/30"
                  : "border-[var(--hl-border)] bg-[var(--hl-surface)] hover:border-[var(--hl-accent)]/60 hover:bg-[var(--hl-surface-hover)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: t.config.branding.accentColor }}
                    />
                    <span className="text-[13px] font-semibold text-[var(--foreground)]">{t.name}</span>
                    {isSelected && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--hl-accent)] text-[var(--background)] font-bold uppercase tracking-wide">
                        Previewing
                      </span>
                    )}
                  </div>
                  <div className="text-[10.5px] text-[var(--hl-muted)] mt-0.5">{t.tagline}</div>
                  <div className="text-[10.5px] text-[var(--hl-muted)] mt-2 leading-relaxed">{t.description}</div>
                  {/* Show which categories are enabled to make differences concrete */}
                  <div className="flex flex-wrap gap-1 mt-2.5">
                    {Object.entries(t.config.widgets)
                      .filter(([, on]) => on)
                      .slice(0, 6)
                      .map(([key]) => (
                        <span
                          key={key}
                          className="text-[8.5px] px-1.5 py-0.5 rounded bg-[var(--hl-border)]/40 text-[var(--hl-muted)] font-mono"
                        >
                          {key}
                        </span>
                      ))}
                    {widgetCount > 6 && (
                      <span className="text-[8.5px] text-[var(--hl-muted)]">+{widgetCount - 6} more</span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[14px] font-bold text-[var(--foreground)] tabular-nums">{widgetCount}</div>
                  <div className="text-[8.5px] text-[var(--hl-muted)] uppercase tracking-wide">widgets</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Sticky Continue button */}
      <div className="sticky bottom-0 lg:static pt-4 mt-4 -mx-6 lg:mx-0 px-6 lg:px-0 bg-gradient-to-t from-[var(--background)] via-[var(--background)] to-transparent">
        <button
          onClick={onNext}
          disabled={!selectedId}
          className="w-full py-2.5 rounded text-[13px] font-semibold bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {selectedId
            ? `Continue with "${STUDIO_TEMPLATES.find(t => t.id === selectedId)?.name}" →`
            : "Pick a template to continue"}
        </button>
      </div>
    </div>
  );
}

// ─── Customize Step ─────────────────────────────────────────────────────────

function CustomizeStep({
  config,
  toggleWidget,
  update,
  updateBranding,
  onBack,
  onNext,
}: {
  config: StudioConfig;
  toggleWidget: (k: WidgetKey) => void;
  update: <K extends keyof StudioConfig>(k: K, v: StudioConfig[K]) => void;
  updateBranding: <K extends keyof StudioConfig["branding"]>(k: K, v: StudioConfig["branding"][K]) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const categories = ["core", "flow", "market", "derivatives", "ecosystem"] as const;

  return (
    <div className="p-6 space-y-6">
      {/* Identity */}
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Identity</h3>
        <div className="space-y-3">
          <Field label="Name">
            <input
              value={config.name}
              onChange={e => update("name", e.target.value)}
              maxLength={40}
              placeholder="My HLOne"
              className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)]"
            />
          </Field>
          <Field label="Slug (subdomain / URL)">
            <div className="flex items-center gap-1">
              <input
                value={config.slug}
                onChange={e => update("slug", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32))}
                placeholder="my-hlone"
                className="flex-1 px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)] font-mono"
              />
              <span className="text-[10px] text-[var(--hl-muted)]">.hlone.build</span>
            </div>
          </Field>
          <Field label="Tagline (optional)">
            <input
              value={config.tagline ?? ""}
              onChange={e => update("tagline", e.target.value)}
              maxLength={80}
              placeholder="The whale follower's terminal"
              className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)]"
            />
          </Field>
        </div>
      </section>

      {/* Branding */}
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Branding</h3>
        <div className="space-y-3">
          <Field label="Accent Color">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={config.branding.accentColor}
                onChange={e => updateBranding("accentColor", e.target.value)}
                className="h-8 w-12 rounded cursor-pointer bg-transparent border border-[var(--hl-border)]"
              />
              <input
                value={config.branding.accentColor}
                onChange={e => updateBranding("accentColor", e.target.value)}
                className="flex-1 px-3 py-1.5 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)] font-mono"
              />
            </div>
          </Field>
          <Field label="Twitter / X (optional)">
            <input
              value={config.branding.twitter ?? ""}
              onChange={e => updateBranding("twitter", e.target.value)}
              placeholder="@yourhandle"
              className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)]"
            />
          </Field>
          <Field label="Logo URL (optional)">
            <input
              value={config.branding.logoUrl ?? ""}
              onChange={e => updateBranding("logoUrl", e.target.value)}
              placeholder="https://..."
              className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)]"
            />
          </Field>
        </div>
      </section>

      {/* Default Token + Watchlist */}
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Defaults</h3>
        <div className="space-y-3">
          <Field label="Default Token (shown on load)">
            <input
              value={config.defaultToken}
              onChange={e => update("defaultToken", e.target.value.toUpperCase())}
              placeholder="BTC"
              maxLength={10}
              className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)] font-mono"
            />
          </Field>
          <Field label="Watchlist (comma-separated)">
            <input
              value={config.watchlist.join(", ")}
              onChange={e => update("watchlist", e.target.value.split(",").map(s => s.trim().toUpperCase()).filter(Boolean))}
              placeholder="BTC, ETH, HYPE"
              className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--hl-accent)] font-mono"
            />
          </Field>
        </div>
      </section>

      {/* Widgets */}
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">
          Widgets ({Object.values(config.widgets).filter(Boolean).length} / {WIDGET_CATALOG.length})
        </h3>
        {categories.map(cat => {
          const widgets = WIDGET_CATALOG.filter(w => w.category === cat);
          if (widgets.length === 0) return null;
          return (
            <div key={cat} className="mb-4">
              <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-1.5">{cat}</div>
              <div className="space-y-1">
                {widgets.map(w => {
                  const enabled = config.widgets[w.key] ?? w.defaultOn;
                  return (
                    <label
                      key={w.key}
                      className="flex items-start gap-3 p-2 rounded hover:bg-[var(--hl-surface-hover)] cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleWidget(w.key)}
                        className="mt-0.5 accent-[var(--hl-accent)]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-[var(--foreground)] font-medium">{w.label}</div>
                        <div className="text-[10px] text-[var(--hl-muted)] leading-snug">{w.description}</div>
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                        w.size === "small" ? "bg-[var(--hl-surface)] text-[var(--hl-muted)]" :
                        w.size === "medium" ? "bg-[var(--hl-surface)] text-[var(--hl-muted)]" :
                        "bg-[var(--hl-surface)] text-[var(--hl-muted)]"
                      }`}>
                        {w.size}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>

      {/* Fee info — view only */}
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Fees on your build</h3>
        <div className="rounded bg-[var(--hl-surface)] border border-[var(--hl-border)] p-3 text-[11px] leading-relaxed space-y-1">
          <div className="flex justify-between"><span className="text-[var(--hl-muted)]">HL exchange fee</span><span className="tabular-nums">~0.035%</span></div>
          <div className="flex justify-between"><span className="text-[var(--hl-muted)]">HLOne builder fee</span><span className="tabular-nums">{(HLONE_PLATFORM_FEE_BPS / 100).toFixed(3)}%</span></div>
          <div className="border-t border-[var(--hl-border)] mt-1 pt-1 flex justify-between font-medium">
            <span>Total per trade</span>
            <span className="tabular-nums">~{(3.5 + HLONE_PLATFORM_FEE_BPS).toFixed(1)} bps (~{((3.5 + HLONE_PLATFORM_FEE_BPS) / 100).toFixed(3)}%)</span>
          </div>
        </div>
        <p className="text-[10px] text-[var(--hl-muted)] mt-2 leading-relaxed">
          HL takes their exchange fee + HLOne takes {(HLONE_PLATFORM_FEE_BPS / 100).toFixed(3)}% on every trade. Builder-earns-fee is a future feature — for now, builds are for your own use or sharing without taking a cut.
        </p>
      </section>

      <div className="flex gap-2">
        <button
          onClick={onBack}
          className="py-2.5 px-4 rounded text-[12px] text-[var(--foreground)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)] transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          className="flex-1 py-2.5 rounded text-[13px] font-semibold bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 transition-all"
        >
          Continue to Deploy →
        </button>
      </div>
    </div>
  );
}

// ─── Deploy Step ───────────────────────────────────────────────────────────

function DeployStep({
  config,
  validation,
  deployStatus,
  deployError,
  deployResult,
  onDeploy,
  onBack,
  walletConnected,
  isPreviewMode,
}: {
  config: StudioConfig;
  validation: ReturnType<typeof validateConfig>;
  deployStatus: "idle" | "paying" | "deploying" | "done" | "error";
  deployError: string;
  deployResult: { repoUrl?: string; deployUrl?: string; apiKey?: string; devMode?: boolean; note?: string } | null;
  onDeploy: () => void;
  onBack: () => void;
  walletConnected: boolean;
  isPreviewMode: boolean;
}) {
  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(config, null, 2));
  };

  const downloadJson = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${config.slug || "hlone"}.studio.config.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (deployStatus === "done" && deployResult) {
    const inPreview = deployResult.devMode || isPreviewMode;

    // Preview mode: dry-run success, explain what WOULD happen
    if (inPreview) {
      return (
        <div className="p-6 space-y-5">
          <div className="rounded-lg border border-[#f5a524]/40 bg-[#f5a524]/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[16px]">🧪</span>
              <h2 className="text-[14px] font-semibold text-[#f5a524]">Preview Run Complete</h2>
            </div>
            <p className="text-[11px] text-[var(--foreground)] leading-relaxed">
              Your config passed validation. <span className="font-medium">Nothing was actually deployed</span> because Studio is in preview mode — the team hasn't enabled real deploys yet.
            </p>
          </div>

          <section>
            <h3 className="text-[11px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-2">What would happen on real deploy:</h3>
            <ol className="space-y-2 text-[11px] text-[var(--foreground)] leading-snug">
              <li className="flex gap-2"><span className="text-[var(--hl-accent)] shrink-0 mt-0.5">1.</span><span>You pay <span className="font-mono">50 USDC</span> on Arbitrum (auto-triggered in your wallet)</span></li>
              <li className="flex gap-2"><span className="text-[var(--hl-accent)] shrink-0 mt-0.5">2.</span><span>A private fork of <span className="font-mono">hlone-template</span> is created in your GitHub account</span></li>
              <li className="flex gap-2"><span className="text-[var(--hl-accent)] shrink-0 mt-0.5">3.</span><span>Your <span className="font-mono">studio.config.json</span> is committed to the fork</span></li>
              <li className="flex gap-2"><span className="text-[var(--hl-accent)] shrink-0 mt-0.5">4.</span><span>A Vercel project is created from the fork + env vars baked in</span></li>
              <li className="flex gap-2"><span className="text-[var(--hl-accent)] shrink-0 mt-0.5">5.</span><span>Your terminal goes live at <span className="font-mono">{config.slug}.vercel.app</span> (~90s)</span></li>
              <li className="flex gap-2"><span className="text-[var(--hl-accent)] shrink-0 mt-0.5">6.</span><span>API key issued, tied to your wallet — used for rate limiting + data access</span></li>
            </ol>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-2">Export your config</h3>
            <p className="text-[10.5px] text-[var(--hl-muted)] leading-relaxed mb-2">
              Download the JSON now — you can manually deploy it yourself, or wait until real deploys are enabled and upload it here.
            </p>
            <button
              onClick={downloadJson}
              className="w-full py-2 rounded text-[12px] text-[var(--foreground)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)]"
            >
              Download {config.slug}.studio.config.json
            </button>
          </section>

          <button
            onClick={onBack}
            className="w-full py-2 rounded text-[11px] text-[var(--hl-muted)] hover:text-[var(--foreground)] border border-[var(--hl-border)]"
          >
            ← Back to edit config
          </button>
        </div>
      );
    }

    // Real deploy: actually live
    return (
      <div className="p-6 space-y-5">
        <div className="rounded-lg border border-[var(--hl-green)]/40 bg-[var(--hl-green)]/10 p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[16px]">🎉</span>
            <h2 className="text-[14px] font-semibold text-[var(--hl-green)]">Your terminal is live!</h2>
          </div>
          <p className="text-[11px] text-[var(--foreground)]">
            Deploy confirmed. Your HLOne build is now running. Bookmark everything below.
          </p>
        </div>

        {deployResult.deployUrl && (
          <section>
            <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-1.5">Your terminal URL</div>
            <a
              href={deployResult.deployUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block p-3 rounded border-2 border-[var(--hl-accent)] bg-[var(--hl-accent)]/10 text-[var(--hl-accent)] font-mono text-[11px] hover:brightness-110 transition"
            >
              {deployResult.deployUrl} <span className="opacity-60">→ open</span>
            </a>
            <p className="text-[9px] text-[var(--hl-muted)] mt-1.5">Takes ~90s for first Vercel build to complete. Refresh if blank.</p>
          </section>
        )}

        {deployResult.repoUrl && (
          <section>
            <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-1.5">GitHub repo (source code)</div>
            <a
              href={deployResult.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block p-3 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--foreground)] font-mono text-[11px] hover:bg-[var(--hl-surface-hover)] transition"
            >
              {deployResult.repoUrl}
            </a>
            <p className="text-[9px] text-[var(--hl-muted)] mt-1.5">You own this repo. Edit config/widgets, push, Vercel auto-redeploys.</p>
          </section>
        )}

        {deployResult.apiKey && (
          <section>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide">API Key</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--hl-red)]/20 text-[var(--hl-red)] font-medium">Save this now — shown once</span>
            </div>
            <div className="p-3 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--foreground)] font-mono text-[10px] break-all flex items-center gap-2">
              <span className="flex-1">{deployResult.apiKey}</span>
              <button
                onClick={() => navigator.clipboard.writeText(deployResult.apiKey!)}
                className="text-[10px] px-2 py-1 rounded bg-[var(--hl-accent)] text-[var(--background)] font-medium hover:brightness-110 shrink-0"
              >
                Copy
              </button>
            </div>
            <p className="text-[9px] text-[var(--hl-muted)] mt-1.5">Already baked into your Vercel deploy. Don't share publicly — rate-limited per key.</p>
          </section>
        )}

        <section>
          <h3 className="text-[11px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-2">Next steps</h3>
          <ul className="space-y-1.5 text-[11px] text-[var(--foreground)]">
            <li className="flex gap-2"><span className="text-[var(--hl-muted)]">→</span><span>Open your terminal and do a test trade (HLOne builder fee kicks in automatically)</span></li>
            <li className="flex gap-2"><span className="text-[var(--hl-muted)]">→</span><span>Bookmark or set up a custom domain in Vercel project settings</span></li>
            <li className="flex gap-2"><span className="text-[var(--hl-muted)]">→</span><span>Visit the dashboard to track your usage + (future) earnings</span></li>
          </ul>
        </section>

        <Link
          href="/studio/dashboard"
          className="block text-center py-2.5 rounded text-[12px] font-medium bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)] text-[var(--foreground)]"
        >
          Go to Dashboard →
        </Link>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Fees</h3>
        <div className="space-y-3">
          <div className="rounded bg-[var(--hl-surface)] border border-[var(--hl-border)] p-3 text-[11px] leading-relaxed space-y-1">
            <div className="flex justify-between"><span className="text-[var(--hl-muted)]">HL exchange fee</span><span className="tabular-nums">~0.035%</span></div>
            <div className="flex justify-between"><span className="text-[var(--hl-muted)]">HLOne builder fee</span><span className="tabular-nums">{(HLONE_PLATFORM_FEE_BPS / 100).toFixed(3)}%</span></div>
            <div className="border-t border-[var(--hl-border)] mt-1 pt-1 flex justify-between font-medium">
              <span>Total per trade</span>
              <span className="tabular-nums">~{(3.5 + HLONE_PLATFORM_FEE_BPS).toFixed(1)} bps (~{((3.5 + HLONE_PLATFORM_FEE_BPS) / 100).toFixed(3)}%)</span>
            </div>
          </div>
          <p className="text-[10px] text-[var(--hl-muted)] leading-relaxed">
            Every trade on your build routes the HLOne builder fee to our wallet automatically via HL's builder code system. Users approve HLOne as their builder once (one-time signature), then every subsequent trade is fee-correct. No custody, no delays.
          </p>
        </div>
      </section>

      {/* Validation summary */}
      {!validation.ok && (
        <div className="rounded bg-[var(--hl-red)]/10 border border-[var(--hl-red)]/30 p-3">
          <div className="text-[11px] font-medium text-[var(--hl-red)] mb-1">Fix these before deploy:</div>
          <ul className="text-[10.5px] text-[var(--hl-red)] space-y-0.5 list-disc list-inside">
            {validation.errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {deployError && (
        <div className="rounded bg-[var(--hl-red)]/10 border border-[var(--hl-red)]/30 p-3 text-[11px] text-[var(--hl-red)]">
          {deployError}
        </div>
      )}

      {/* Deploy options */}
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Deploy</h3>
        <button
          onClick={onDeploy}
          disabled={!validation.ok || deployStatus === "paying" || deployStatus === "deploying" || !walletConnected}
          className="w-full py-3 rounded text-[13px] font-semibold bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {!walletConnected
            ? "Connect wallet to deploy"
            : deployStatus === "paying"
            ? "Confirm payment in wallet..."
            : deployStatus === "deploying"
            ? "Forking + deploying..."
            : isPreviewMode
            ? "Run preview (no payment, no deploy)"
            : "Deploy — Pay 50 USDC on Arbitrum"}
        </button>
        {isPreviewMode ? (
          <p className="text-[9px] text-[#f5a524] mt-2 leading-relaxed">
            Preview mode — running this will validate your config and show what would happen. No wallet popup, no payment, no real deploy.
          </p>
        ) : (
          <p className="text-[9px] text-[var(--hl-muted)] mt-2 leading-relaxed">
            Pay once with USDC on Arbitrum (same network you use to deposit to HL). Covers API key + rate limits for ~12 months. Takes ~90 seconds total.
          </p>
        )}
      </section>

      {/* Alt: download JSON */}
      <section>
        <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-2">Or export manually</div>
        <div className="flex gap-2">
          <button
            onClick={copyJson}
            className="flex-1 py-2 rounded text-[11px] text-[var(--foreground)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)]"
          >
            Copy JSON
          </button>
          <button
            onClick={downloadJson}
            className="flex-1 py-2 rounded text-[11px] text-[var(--foreground)] bg-[var(--hl-surface)] hover:bg-[var(--hl-surface-hover)] border border-[var(--hl-border)]"
          >
            Download JSON
          </button>
        </div>
      </section>

      <button
        onClick={onBack}
        className="w-full py-2 rounded text-[11px] text-[var(--hl-muted)] hover:text-[var(--foreground)] border border-[var(--hl-border)]"
      >
        ← Back to Customize
      </button>
    </div>
  );
}

// ─── Live Preview (real terminal iframed) ──────────────────────────────────
// Loads the actual terminal at `/` inside a same-origin iframe and pushes the
// config via postMessage. The terminal's useStudioConfig hook listens for
// STUDIO_CONFIG_UPDATE messages and updates widgets + branding in real-time.

function LivePreview({ config }: { config: StudioConfig }) {
  const enabledWidgets = WIDGET_CATALOG.filter(w => (config.widgets[w.key] ?? w.defaultOn));
  const accent = config.branding.accentColor;

  // Group widgets by category for structured display
  const byCategory = {
    core: enabledWidgets.filter(w => w.category === "core"),
    flow: enabledWidgets.filter(w => w.category === "flow"),
    market: enabledWidgets.filter(w => w.category === "market"),
    derivatives: enabledWidgets.filter(w => w.category === "derivatives"),
    ecosystem: enabledWidgets.filter(w => w.category === "ecosystem"),
  };

  const [iframeReady, setIframeReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Push config on every change
  useEffect(() => {
    if (!iframeReady) return;
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: "STUDIO_CONFIG_UPDATE", config }, window.location.origin);
    } catch (err) {
      console.warn("[preview] postMessage failed:", err);
    }
  }, [config, iframeReady]);

  const handleLoad = () => {
    setIframeReady(true);
    const iframe = iframeRef.current;
    if (iframe?.contentWindow) {
      try {
        iframe.contentWindow.postMessage({ type: "STUDIO_CONFIG_UPDATE", config }, window.location.origin);
      } catch {}
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--hl-surface)]">
      {/* Real terminal iframe — main preview */}
      <div className="flex-[2] min-h-0 bg-[var(--background)] border-b border-[var(--hl-border)] relative overflow-hidden">
        {!iframeReady && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-[var(--background)]">
            <div className="text-[11px] text-[var(--hl-muted)] animate-pulse">Loading live preview...</div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src="/?preview=1"
          title="HLOne Live Preview"
          onLoad={handleLoad}
          className="w-full h-full border-0"
          // sandbox keeps it safe — allow scripts so React runs, but no form submission / top nav
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>

      {/* Below iframe: enabled widgets summary + fee stack (always visible) */}
      <div className="flex-1 min-h-[180px] overflow-y-auto px-4 py-3 bg-[var(--hl-surface)]">
        {/* Branding row */}
        <div className="flex items-center gap-3 mb-3 pb-3 border-b border-[var(--hl-border)]">
          {config.branding.logoUrl ? (
            <img src={config.branding.logoUrl} alt="" className="h-8 w-8 rounded" />
          ) : (
            <div
              className="h-8 w-8 rounded shrink-0"
              style={{ background: `linear-gradient(135deg, ${accent}, ${accent}60)` }}
            />
          )}
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--foreground)] truncate">{config.name || "Untitled"}</div>
            {config.tagline && <div className="text-[10px] text-[var(--hl-muted)] truncate">{config.tagline}</div>}
          </div>
          <div className="ml-auto text-right shrink-0">
            <div className="text-[14px] font-bold text-[var(--foreground)] tabular-nums">{enabledWidgets.length}</div>
            <div className="text-[8px] text-[var(--hl-muted)] uppercase tracking-wide">widgets</div>
          </div>
        </div>

        {/* Enabled widgets pills */}
        <div className="flex flex-wrap gap-1 mb-3">
          {enabledWidgets.map(w => (
            <span
              key={w.key}
              className="text-[9px] px-2 py-0.5 rounded border"
              style={{ color: accent, borderColor: `${accent}40`, background: `${accent}10` }}
            >
              {w.label}
            </span>
          ))}
          {enabledWidgets.length === 0 && (
            <span className="text-[10px] text-[var(--hl-muted)]">No widgets enabled.</span>
          )}
        </div>

        {/* Fee stack */}
        <div className="text-[9px] text-[var(--hl-muted)] uppercase tracking-wide mb-1">Fee stack per trade</div>
        <div className="space-y-0.5 text-[10px] font-mono">
          <FeeRow label="HL exchange fee" value="~0.035%" />
          <FeeRow label="HLOne builder fee" value={`${(HLONE_PLATFORM_FEE_BPS / 100).toFixed(3)}%`} accent={accent} />
        </div>

        {/* Category summary */}
        <div className="mt-3 pt-3 border-t border-[var(--hl-border)] grid grid-cols-5 gap-2 text-center">
          {(["core", "flow", "market", "derivatives", "ecosystem"] as const).map(cat => (
            <div key={cat}>
              <div className="text-[11px] font-semibold text-[var(--foreground)] tabular-nums">
                {byCategory[cat].length}
              </div>
              <div className="text-[8px] text-[var(--hl-muted)] uppercase tracking-wide">{cat}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Preview primitives (legacy mockup, unused; kept for reference) ────────

function _MockPanel_UNUSED({
  label,
  accent,
  height,
  rows = 0,
  compact = false,
  showAxis = false,
}: {
  label: string;
  accent: string;
  height: number;
  rows?: number;
  compact?: boolean;
  showAxis?: boolean;
}) {
  return (
    <div
      className="rounded border bg-[var(--background)] overflow-hidden"
      style={{ borderColor: "var(--hl-border)", height: `${height}px` }}
    >
      <div
        className={`${compact ? "px-2 py-1" : "px-2.5 py-1.5"} border-b flex items-center justify-between`}
        style={{ borderColor: "var(--hl-border)" }}
      >
        <span className={`${compact ? "text-[9px]" : "text-[10px]"} font-medium text-[var(--foreground)] truncate`}>
          {label}
        </span>
        <span className="w-1 h-1 rounded-full" style={{ background: accent }} />
      </div>
      <div className="p-2">
        {showAxis && (
          <div className="w-full h-full relative">
            {/* Mock chart line */}
            <svg viewBox="0 0 100 60" className="w-full h-full">
              <polyline
                fill="none"
                stroke={accent}
                strokeWidth="1"
                points="0,40 10,35 20,38 30,28 40,25 50,20 60,22 70,15 80,18 90,12 100,10"
              />
              <polyline
                fill={`${accent}20`}
                stroke="none"
                points="0,40 10,35 20,38 30,28 40,25 50,20 60,22 70,15 80,18 90,12 100,10 100,60 0,60"
              />
            </svg>
          </div>
        )}
        {!showAxis && rows > 0 && (
          <div className="space-y-1">
            {Array.from({ length: rows }).map((_, i) => (
              <div key={i} className="flex items-center justify-between">
                <div className="h-1 w-1/3 rounded bg-[var(--hl-border)]" />
                <div className="h-1 w-1/4 rounded bg-[var(--hl-border)]" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({ label, active = false, accent }: { label: string; active?: boolean; accent: string }) {
  return (
    <div
      className="text-[9px] px-2 py-1 rounded whitespace-nowrap"
      style={{
        color: active ? accent : "var(--hl-muted)",
        borderBottom: active ? `2px solid ${accent}` : "2px solid transparent",
      }}
    >
      {label}
    </div>
  );
}

function FeeRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-[var(--hl-muted)]">{label}</span>
      <span style={{ color: accent ?? "var(--foreground)" }} className="tabular-nums">
        {value}
      </span>
    </div>
  );
}

// ─── Reusable Field wrapper ────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-1">{label}</div>
      {children}
    </div>
  );
}
