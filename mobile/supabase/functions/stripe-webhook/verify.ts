// NorthShift — Stripe webhook helpers (pure, no Deno/Supabase imports).
// Unit-tested in verify.test.ts with plain Jest (same pattern as
// hr-ai-bot/logic.ts). index.ts is the thin Deno serve() wrapper around
// these, so the deployed webhook and the tests run the same code.

// TEST-mode price IDs, created 2026-11-10. Live mode MUST override them
// with the STRIPE_PRICE_STARTER / _GROWTH / _BUSINESS secrets — never
// edit these to live IDs in the repo.
export const PRICE_IDS: Record<string, string> = {
  starter: "price_1UaLUr4CKkTxZIvG3uTcrG9J",
  growth: "price_1UaLUs4CKkTxZIvGBBM0gZpe",
  business: "price_1UaLUu4CKkTxZIvG08wFKSfS",
};

export const PLAN_LIMITS: Record<string, number> = { starter: 5, growth: 15, business: 40 };

export function priceIdsFromEnv(getEnv: (k: string) => string | undefined): Record<string, string> {
  return {
    starter: getEnv("STRIPE_PRICE_STARTER") || PRICE_IDS.starter,
    growth: getEnv("STRIPE_PRICE_GROWTH") || PRICE_IDS.growth,
    business: getEnv("STRIPE_PRICE_BUSINESS") || PRICE_IDS.business,
  };
}

export function priceIdToPlan(priceId: string | null | undefined, priceIds: Record<string, string>): string | null {
  if (!priceId) return null;
  for (const [plan, id] of Object.entries(priceIds)) if (id === priceId) return plan;
  return null;
}

export function stripeTsToIso(sec: number | null | undefined): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  return new Date(sec * 1000).toISOString();
}

// Verify a Stripe webhook signature (Stripe-Signature header) with
// HMAC-SHA256 over "<timestamp>.<raw body>". Uses WebCrypto so the same
// code runs under Deno and Node. Returns false on any malformed input,
// a missing scheme, or a timestamp older than toleranceSec. Stripe may
// send several v1 signatures (key rotation) — any one matching passes.
export async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string,
  toleranceSec = 300,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!sigHeader || !secret) return false;
  const tMatch = sigHeader.match(/(?:^|,)t=(\d+)/);
  const v1s = [...sigHeader.matchAll(/(?:^|,)v1=([0-9a-fA-F]+)/g)].map((m) => m[1]);
  if (!tMatch || v1s.length === 0) return false;
  const t = Number(tMatch[1]);
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1s.some((v1) => {
    if (v1.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
    return diff === 0;
  });
}
