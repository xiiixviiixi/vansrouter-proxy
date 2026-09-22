import { NextResponse } from "next/server";
import { findPython310, getInstalledHeadroomExtras, HEADROOM_COMPRESSION_EXTRAS } from "@/lib/headroom/detect";
import { installHeadroomExtras, uninstallHeadroomExtras, getInstallLogTail, isHeadroomProxyOnly } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    // `?log=1` returns the live install/uninstall log tail for progress polling.
    if (new URL(req.url).searchParams.get("log") === "1") {
      return NextResponse.json({ log: getInstallLogTail() });
    }
    const python = findPython310();
    const status = getInstalledHeadroomExtras(python);
    if (isHeadroomProxyOnly()) {
      return NextResponse.json({
        available: [],
        proxyOnly: true,
        installed: status.installed,
        version: status.version,
        extras: { code: false, ml: false },
      });
    }
    return NextResponse.json({
      available: HEADROOM_COMPRESSION_EXTRAS,
      proxyOnly: false,
      ...status,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    if (isHeadroomProxyOnly()) {
      return NextResponse.json({ error: "Optional Headroom extras are disabled in proxy-only runtime", code: "PROXY_ONLY" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body?.extras) ? body.extras : [];
    const result = await installHeadroomExtras(requested);
    return NextResponse.json(result);
  } catch (error) {
    const status = error.code === "NOT_INSTALLED" || error.code === "NO_PYTHON" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}

export async function DELETE(req) {
  try {
    if (isHeadroomProxyOnly()) {
      return NextResponse.json({ error: "Optional Headroom extras are disabled in proxy-only runtime", code: "PROXY_ONLY" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({}));
    const requested = Array.isArray(body?.extras) ? body.extras : [];
    const result = await uninstallHeadroomExtras(requested);
    return NextResponse.json(result);
  } catch (error) {
    const status = error.code === "NO_PYTHON" || error.code === "INVALID_EXTRAS" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
