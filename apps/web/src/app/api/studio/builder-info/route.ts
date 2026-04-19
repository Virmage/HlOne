/**
 * GET /api/studio/builder-info?apiKey=...
 *
 * Returns metadata about a Studio build: which builder wallet, markup, slug, etc.
 * Used by builder deploys on startup to configure their trading panel with the
 * right builder address + fee.
 */

import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const apiKey = url.searchParams.get("apiKey");

    if (!apiKey || !apiKey.startsWith("hlone_")) {
      return NextResponse.json({ error: "Missing or invalid apiKey" }, { status: 401 });
    }

    // TODO: look up real build record
    // Dev stub:
    const hloneWallet = process.env.HLONE_BUILDER_WALLET ?? "0x0000000000000000000000000000000000000000";

    return NextResponse.json({
      deployId: "dev_stub",
      slug: "dev",
      name: "Dev Build",
      builderWallet: "0x0000000000000000000000000000000000000000",
      markupBps: 10,
      hloneFeeBps: 0.5,
      hloneBuilderWallet: hloneWallet,
      // The builder's deploy should set its HL builder fee to (hloneFeeBps + markupBps) / 100 = %
      // with `builder` field pointing to HLONE's wallet — HLOne's infra then forwards the markup
      // portion to the builder's wallet via a scheduled sweep.
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
