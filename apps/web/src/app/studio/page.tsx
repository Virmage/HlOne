"use client";

/**
 * HLOne Studio — Build your own HLOne.
 *
 * Users pick a template, toggle widgets, set branding + fees, then deploy.
 * Live preview on the right (iframe of the terminal with config injected).
 */

import { useState, useMemo, useCallback, useEffect } from "react";
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
  const [deployResult, setDeployResult] = useState<{ repoUrl?: string; deployUrl?: string; apiKey?: string } | null>(null);

  // Auto-set builder wallet from connected address
  useEffect(() => {
    if (isConnected && address && config.fees.builderWallet === "0x0000000000000000000000000000000000000000") {
      setConfig(prev => ({ ...prev, fees: { ...prev.fees, builderWallet: address as `0x${string}` } }));
    }
  }, [isConnected, address, config.fees.builderWallet]);

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

  const updateFees = <K extends keyof StudioConfig["fees"]>(key: K, value: StudioConfig["fees"][K]) => {
    setConfig(prev => ({ ...prev, fees: { ...prev.fees, [key]: value } }));
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
        <div className="flex items-center gap-2 text-[11px]">
          {(["template", "customize", "deploy"] as Step[]).map((s, i) => (
            <button
              key={s}
              onClick={() => setStep(s)}
              className={`px-3 py-1 rounded transition-colors ${
                step === s
                  ? "bg-[var(--hl-accent)] text-[var(--background)] font-medium"
                  : "text-[var(--hl-muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-col lg:flex-row h-[calc(100vh-49px)]">
        {/* LEFT: Form */}
        <div className="lg:w-[520px] flex-shrink-0 border-r border-[var(--hl-border)] overflow-y-auto">
          {step === "template" && (
            <TemplateStep
              onPick={(tmpl) => {
                setConfig(tmpl.config);
                setStep("customize");
              }}
            />
          )}
          {step === "customize" && (
            <CustomizeStep
              config={config}
              toggleWidget={toggleWidget}
              update={update}
              updateBranding={updateBranding}
              updateFees={updateFees}
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

function TemplateStep({ onPick }: { onPick: (t: typeof STUDIO_TEMPLATES[number]) => void }) {
  return (
    <div className="p-6">
      <h2 className="text-[16px] font-semibold text-[var(--foreground)]">Pick a starting template</h2>
      <p className="text-[11px] text-[var(--hl-muted)] mt-1">
        Start from a template and customize, or pick Default for the full experience.
      </p>

      <div className="mt-5 space-y-2">
        {STUDIO_TEMPLATES.map(t => (
          <button
            key={t.id}
            onClick={() => onPick(t)}
            className="w-full text-left p-4 rounded-lg border border-[var(--hl-border)] bg-[var(--hl-surface)] hover:border-[var(--hl-accent)] hover:bg-[var(--hl-surface-hover)] transition-colors group"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: t.config.branding.accentColor }}
                  />
                  <span className="text-[13px] font-semibold text-[var(--foreground)]">{t.name}</span>
                </div>
                <div className="text-[10.5px] text-[var(--hl-muted)] mt-0.5">{t.tagline}</div>
                <div className="text-[10.5px] text-[var(--hl-muted)] mt-2 leading-relaxed">{t.description}</div>
              </div>
              <div className="text-[9px] text-[var(--hl-muted)] text-right">
                {Object.values(t.config.widgets).filter(Boolean).length} widgets
              </div>
            </div>
          </button>
        ))}
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
  updateFees,
  onNext,
}: {
  config: StudioConfig;
  toggleWidget: (k: WidgetKey) => void;
  update: <K extends keyof StudioConfig>(k: K, v: StudioConfig[K]) => void;
  updateBranding: <K extends keyof StudioConfig["branding"]>(k: K, v: StudioConfig["branding"][K]) => void;
  updateFees: <K extends keyof StudioConfig["fees"]>(k: K, v: StudioConfig["fees"][K]) => void;
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

      {/* Fees */}
      <section>
        <h3 className="text-[12px] font-semibold text-[var(--hl-accent)] uppercase tracking-wider mb-3">Builder Fee</h3>
        <p className="text-[10.5px] text-[var(--hl-muted)] mb-3 leading-relaxed">
          Your markup is added on top of HL's exchange fee + HLOne's 0.005% platform fee. Pays directly to your wallet on every trade. Max {MAX_MARKUP_BPS / 100}%.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={MAX_MARKUP_BPS}
            step={1}
            value={config.fees.markupBps}
            onChange={e => updateFees("markupBps", parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--hl-accent)]"
          />
          <div className="text-[11px] tabular-nums font-mono w-24 text-right">
            <span className="text-[var(--foreground)]">{config.fees.markupBps} bps</span>
            <span className="text-[var(--hl-muted)] ml-1">({(config.fees.markupBps / 100).toFixed(3)}%)</span>
          </div>
        </div>
      </section>

      <button
        onClick={onNext}
        className="w-full py-2.5 rounded text-[13px] font-semibold bg-[var(--hl-accent)] text-[var(--background)] hover:brightness-110 transition-all"
      >
        Continue to Deploy →
      </button>
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
}: {
  config: StudioConfig;
  validation: ReturnType<typeof validateConfig>;
  deployStatus: "idle" | "paying" | "deploying" | "done" | "error";
  deployError: string;
  deployResult: { repoUrl?: string; deployUrl?: string; apiKey?: string } | null;
  onDeploy: () => void;
  onBack: () => void;
  walletConnected: boolean;
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
    return (
      <div className="p-6">
        <h2 className="text-[16px] font-semibold text-[var(--foreground)]">🎉 Deployed!</h2>
        <p className="text-[11px] text-[var(--hl-muted)] mt-1">
          Your HLOne build is live. Bookmark these links.
        </p>

        <div className="mt-5 space-y-3">
          {deployResult.deployUrl && (
            <div>
              <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-1">Your terminal</div>
              <a
                href={deployResult.deployUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-3 rounded border border-[var(--hl-accent)] bg-[var(--hl-accent)]/10 text-[var(--hl-accent)] font-mono text-[11px] hover:brightness-110 transition"
              >
                {deployResult.deployUrl} →
              </a>
            </div>
          )}
          {deployResult.repoUrl && (
            <div>
              <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-1">GitHub repo</div>
              <a
                href={deployResult.repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block p-3 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--foreground)] font-mono text-[11px] hover:bg-[var(--hl-surface-hover)] transition"
              >
                {deployResult.repoUrl}
              </a>
            </div>
          )}
          {deployResult.apiKey && (
            <div>
              <div className="text-[10px] text-[var(--hl-muted)] uppercase tracking-wide mb-1">API Key (save this!)</div>
              <div className="p-3 rounded border border-[var(--hl-border)] bg-[var(--hl-surface)] text-[var(--foreground)] font-mono text-[10px] break-all">
                {deployResult.apiKey}
              </div>
              <p className="text-[9px] text-[var(--hl-muted)] mt-1">Already set as NEXT_PUBLIC_HLONE_API_KEY in your Vercel deploy.</p>
            </div>
          )}
        </div>

        <Link
          href="/studio/dashboard"
          className="block mt-6 text-center py-2 rounded text-[12px] text-[var(--hl-muted)] hover:text-[var(--foreground)] border border-[var(--hl-border)]"
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
            <div className="flex justify-between"><span className="text-[var(--hl-muted)]">HLOne platform fee</span><span className="tabular-nums">{HLONE_PLATFORM_FEE_BPS / 100}%</span></div>
            <div className="flex justify-between"><span className="text-[var(--foreground)]">Your builder markup</span><span className="tabular-nums text-[var(--hl-accent)]">{(config.fees.markupBps / 100).toFixed(3)}%</span></div>
            <div className="border-t border-[var(--hl-border)] mt-1 pt-1 flex justify-between font-medium">
              <span>Total per trade</span>
              <span className="tabular-nums">{(3.5 + HLONE_PLATFORM_FEE_BPS + config.fees.markupBps).toFixed(1)} bps ({((3.5 + HLONE_PLATFORM_FEE_BPS + config.fees.markupBps) / 100).toFixed(3)}%)</span>
            </div>
          </div>
          <Field label={`Builder Markup (0 – ${MAX_MARKUP_BPS} bps = ${MAX_MARKUP_BPS / 100}%)`}>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={MAX_MARKUP_BPS}
                step={1}
                value={config.fees.markupBps}
                onChange={e => {/* NOTE: direct state mutation would cause re-render loop; see parent updateFees */}}
                className="flex-1 accent-[var(--hl-accent)]"
                disabled
              />
              <span className="text-[11px] tabular-nums font-mono w-12 text-right">{config.fees.markupBps} bps</span>
            </div>
            <p className="text-[9px] text-[var(--hl-muted)] mt-1">Edit in Customize → Fees section.</p>
          </Field>
          <Field label="Payout wallet">
            <input
              value={config.fees.builderWallet}
              readOnly
              className="w-full px-3 py-2 bg-[var(--hl-surface)] border border-[var(--hl-border)] rounded text-[11px] text-[var(--foreground)] outline-none font-mono"
            />
            <p className="text-[9px] text-[var(--hl-muted)] mt-1">
              {walletConnected ? "Auto-filled from your connected wallet. Your builder markup pays directly here on every trade." : "Connect wallet to auto-fill."}
            </p>
          </Field>
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
            : "Deploy — Pay 50 USDC on Arbitrum"}
        </button>
        <p className="text-[9px] text-[var(--hl-muted)] mt-2 leading-relaxed">
          Pay once with USDC on Arbitrum (same network you use to deposit to HL). Covers API key + rate limits for ~12 months. Then it's just the fee split: 0.005% to HLOne, {(config.fees.markupBps / 100).toFixed(3)}% to your wallet on every trade.
        </p>
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

// ─── Live Preview (iframe) ──────────────────────────────────────────────────

function LivePreview({ config }: { config: StudioConfig }) {
  // Post config to iframe on config change
  useEffect(() => {
    const iframe = document.getElementById("studio-preview-iframe") as HTMLIFrameElement | null;
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: "STUDIO_CONFIG_UPDATE", config }, "*");
    } catch {}
  }, [config]);

  // Re-inject on iframe load
  const handleLoad = () => {
    const iframe = document.getElementById("studio-preview-iframe") as HTMLIFrameElement | null;
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage({ type: "STUDIO_CONFIG_UPDATE", config }, "*");
    } catch {}
  };

  return (
    <iframe
      id="studio-preview-iframe"
      src="/"
      onLoad={handleLoad}
      title="HLOne Preview"
      className="w-full h-full border-0"
    />
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
