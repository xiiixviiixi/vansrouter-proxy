import { describe, it, expect, afterEach } from "vitest";
import { buildHeadroomProxyArgs, isHeadroomProxyOnly } from "../../src/lib/headroom/process.js";

const MANAGED_ENV = [
  "HEADROOM_PROXY_ONLY",
  "HEADROOM_LIMIT_CONCURRENCY",
  "HEADROOM_MAX_CONNECTIONS",
  "HEADROOM_MAX_KEEPALIVE",
  "HEADROOM_KEEPALIVE_EXPIRY",
  "HEADROOM_COMPRESSION_MAX_WORKERS",
  "HEADROOM_ANTHROPIC_PRE_UPSTREAM_CONCURRENCY",
];
const savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function useDeterministicConcurrency() {
  process.env.HEADROOM_LIMIT_CONCURRENCY = "8";
  process.env.HEADROOM_MAX_CONNECTIONS = "16";
  process.env.HEADROOM_MAX_KEEPALIVE = "4";
  process.env.HEADROOM_KEEPALIVE_EXPIRY = "10";
  process.env.HEADROOM_COMPRESSION_MAX_WORKERS = "1";
  process.env.HEADROOM_ANTHROPIC_PRE_UPSTREAM_CONCURRENCY = "2";
}

describe("headroom managed proxy profile", () => {
  it("forces the lightweight loopback profile in proxy-only mode", () => {
    process.env.HEADROOM_PROXY_ONLY = "true";
    useDeterministicConcurrency();

    const args = buildHeadroomProxyArgs({ port: 8787, codeAware: true, kompress: true });

    expect(isHeadroomProxyOnly()).toBe(true);
    expect(args.slice(0, 5)).toEqual(["proxy", "--host", "127.0.0.1", "--port", "8787"]);
    expect(args).toEqual(expect.arrayContaining([
      "--no-telemetry",
      "--stateless",
      "--no-ccr",
      "--no-cache",
      "--no-rate-limit",
      "--no-subscription-tracking",
      "--disable-kompress",
      "--disable-kompress-fallback",
      "--workers", "1",
      "--limit-concurrency", "8",
      "--max-connections", "16",
      "--max-keepalive", "4",
      "--keepalive-expiry", "10",
      "--compression-max-workers", "1",
      "--anthropic-pre-upstream-concurrency", "2",
    ]));
    expect(args).not.toContain("--code-aware");
  });

  it("keeps explicit extras behavior outside proxy-only mode", () => {
    delete process.env.HEADROOM_PROXY_ONLY;
    useDeterministicConcurrency();

    const args = buildHeadroomProxyArgs({ port: "oops", codeAware: true, kompress: false });

    expect(isHeadroomProxyOnly()).toBe(false);
    expect(args).toEqual(expect.arrayContaining(["--port", "8787", "--code-aware", "--disable-kompress"]));
    expect(args).not.toContain("--disable-kompress-fallback");
  });
});
