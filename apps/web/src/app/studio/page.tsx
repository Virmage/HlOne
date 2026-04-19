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
  onNext,
}: {
  config: StudioConfig;
  toggleWidget: (k: WidgetKey) => void;
  update: <K extends keyof StudioConfig>(k: K, v: StudioConfig[K]) => void;
  updateBranding: <K extends keyof StudioConfig["branding"]>(k: K, v: StudioConfig["branding"][K]) => void;
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
            : "Deploy — Pay 50 USDC on Arbitrum"}
        </button>
        <p className="text-[9px] text-[var(--hl-muted)] mt-2 leading-relaxed">
          Pay once with USDC on Arbitrum (same network you use to deposit to HL). Covers API key + rate limits for ~12 months.
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

// ─── Live Preview (mockup) ──────────────────────────────────────────────────
// Renders a visual mockup of the terminal layout with branding applied.
// We use a mockup instead of iframing the real terminal because:
//   (a) X-Frame-Options blocks same-origin iframes site-wide
//   (b) loading the full terminal is heavy + noisy for a preview
//   (c) a clean mockup makes the layout/branding easier to evaluate

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

  return (
    <div
      className="h-full overflow-y-auto"
      style={{
        // Set the accent color as a CSS variable for this preview
        ["--preview-accent" as string]: accent,
      }}
    >
      {/* Mock header */}
      <div
        className="px-4 py-2.5 border-b flex items-center justify-between"
        style={{ borderColor: "var(--hl-border)", background: "var(--background)" }}
      >
        <div className="flex items-center gap-2">
          {config.branding.logoUrl ? (
            <img src={config.branding.logoUrl} alt="" className="h-5 w-5 rounded" />
          ) : (
            <div
              className="h-5 w-5 rounded"
              style={{ background: `linear-gradient(135deg, ${accent}, ${accent}80)` }}
            />
          )}
          <div>
            <div className="text-[13px] font-semibold text-[var(--foreground)] leading-none">{config.name || "Untitled"}</div>
            {config.tagline && (
              <div className="text-[9px] text-[var(--hl-muted)] mt-0.5 leading-none">{config.tagline}</div>
            )}
          </div>
        </div>
        <div className="text-[10px] text-[var(--hl-muted)] font-mono">
          {config.defaultToken} · {config.watchlist.length} tokens
        </div>
      </div>

      {/* Mock ticker bar (if enabled) */}
      {(config.widgets.tickerBar ?? true) && (
        <div
          className="px-4 py-1.5 border-b overflow-hidden"
          style={{ borderColor: "var(--hl-border)", background: "var(--hl-surface)" }}
        >
          <div className="flex items-center gap-4 text-[9px] font-mono whitespace-nowrap">
            {config.watchlist.slice(0, 8).map(t => (
              <div key={t} className="flex items-center gap-1">
                <span className="text-[var(--foreground)] font-medium">{t}</span>
                <span className="text-[var(--hl-muted)]">—</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mock main area: Chart + right column */}
      <div className="p-3 grid grid-cols-[1fr_180px] gap-2">
        {/* Left: Chart */}
        <div className="space-y-2">
          {(config.widgets.priceChart ?? true) && (
            <MockPanel label="Price Chart" accent={accent} height={180} showAxis />
          )}
          {(config.widgets.positionsPanel ?? true) && (
            <MockPanel label="Positions & Orders" accent={accent} height={80} rows={3} />
          )}
        </div>
        {/* Right column: Trade panel + OB */}
        <div className="space-y-2">
          {(config.widgets.tradingPanel ?? true) && (
            <MockPanel label="Trade" accent={accent} height={130} compact />
          )}
          {(config.widgets.orderBook ?? true) && (
            <MockPanel label="Order Book" accent={accent} height={100} rows={6} compact />
          )}
        </div>
      </div>

      {/* Mock tabs + below-fold widgets */}
      {(byCategory.flow.length > 0 || byCategory.market.length > 0 || byCategory.derivatives.length > 0 || byCategory.ecosystem.length > 0) && (
        <div className="px-3 pb-3">
          <div className="border-t border-[var(--hl-border)] pt-3">
            <div className="flex items-center gap-3 text-[10px] mb-2 overflow-x-auto">
              {byCategory.flow.length > 0 && (
                <Tab label="Signals / Whales" active accent={accent} />
              )}
              {byCategory.derivatives.length > 0 && <Tab label="Options Flow" accent={accent} />}
              {byCategory.ecosystem.length > 0 && <Tab label="Ecosystem" accent={accent} />}
              {byCategory.market.length > 0 && <Tab label="Market / News" accent={accent} />}
            </div>

            {/* Active tab: flow widgets */}
            {byCategory.flow.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {byCategory.flow.map(w => (
                  <MockPanel key={w.key} label={w.label} accent={accent} height={70} rows={3} compact />
                ))}
              </div>
            )}
          </div>

          {/* All enabled widgets summary */}
          <div className="mt-4 pt-3 border-t border-[var(--hl-border)]">
            <div className="text-[9px] text-[var(--hl-muted)] uppercase tracking-wide mb-2">
              All enabled widgets · {enabledWidgets.length} of {WIDGET_CATALOG.length}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {enabledWidgets.map(w => (
                <span
                  key={w.key}
                  className="text-[9px] px-2 py-0.5 rounded border"
                  style={{
                    color: accent,
                    borderColor: `${accent}40`,
                    background: `${accent}10`,
                  }}
                >
                  {w.label}
                </span>
              ))}
              {enabledWidgets.length === 0 && (
                <span className="text-[10px] text-[var(--hl-muted)]">No widgets enabled. Pick at least one.</span>
              )}
            </div>
          </div>

          {/* Fee summary */}
          <div className="mt-4 pt-3 border-t border-[var(--hl-border)]">
            <div className="text-[9px] text-[var(--hl-muted)] uppercase tracking-wide mb-1.5">Fee stack</div>
            <div className="space-y-0.5 text-[10px] font-mono">
              <FeeRow label="HL exchange fee" value="~0.035%" />
              <FeeRow label="HLOne builder fee" value={`${(HLONE_PLATFORM_FEE_BPS / 100).toFixed(3)}%`} accent={accent} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Preview primitives ────────────────────────────────────────────────────

function MockPanel({
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
