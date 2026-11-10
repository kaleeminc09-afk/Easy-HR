// NorthShift — unit tests for the Stripe webhook helpers (verify.ts).
// Run with: npm test   (from the mobile/ folder)

import { createHmac } from "crypto";
import {
  verifyStripeSignature,
  priceIdToPlan,
  priceIdsFromEnv,
  stripeTsToIso,
  PRICE_IDS,
} from "./verify.ts";

function sign(raw: string, t: number, secret: string): string {
  return createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
}

describe("verifyStripeSignature", () => {
  const SECRET = "whsec_dummy_test_secret";
  const RAW = JSON.stringify({ id: "evt_test_1", type: "invoice.paid" });
  const NOW = 1792000000;

  test("a correctly signed header verifies", async () => {
    const t = NOW;
    const header = `t=${t},v1=${sign(RAW, t, SECRET)}`;
    await expect(verifyStripeSignature(RAW, header, SECRET, 300, NOW)).resolves.toBe(true);
  });

  test("a second v1 signature also verifies (key rotation)", async () => {
    const t = NOW;
    const header = `t=${t},v1=deadbeef,v1=${sign(RAW, t, SECRET)}`;
    await expect(verifyStripeSignature(RAW, header, SECRET, 300, NOW)).resolves.toBe(true);
  });

  test("wrong secret fails", async () => {
    const t = NOW;
    const header = `t=${t},v1=${sign(RAW, t, "whsec_wrong_secret")}`;
    await expect(verifyStripeSignature(RAW, header, SECRET, 300, NOW)).resolves.toBe(false);
  });

  test("tampered body fails", async () => {
    const t = NOW;
    const header = `t=${t},v1=${sign(RAW, t, SECRET)}`;
    await expect(verifyStripeSignature(RAW + " ", header, SECRET, 300, NOW)).resolves.toBe(false);
  });

  test("stale timestamp fails", async () => {
    const t = NOW - 1000;
    const header = `t=${t},v1=${sign(RAW, t, SECRET)}`;
    await expect(verifyStripeSignature(RAW, header, SECRET, 300, NOW)).resolves.toBe(false);
  });

  test("missing or malformed header fails", async () => {
    await expect(verifyStripeSignature(RAW, null, SECRET, 300, NOW)).resolves.toBe(false);
    await expect(verifyStripeSignature(RAW, "t=abc,v1=00", SECRET, 300, NOW)).resolves.toBe(false);
    await expect(verifyStripeSignature(RAW, `t=${NOW}`, SECRET, 300, NOW)).resolves.toBe(false);
  });
});

describe("priceIdToPlan", () => {
  test("maps the three test price IDs to their plans", () => {
    expect(priceIdToPlan("price_1UaLUr4CKkTxZIvG3uTcrG9J", PRICE_IDS)).toBe("starter");
    expect(priceIdToPlan("price_1UaLUs4CKkTxZIvGBBM0gZpe", PRICE_IDS)).toBe("growth");
    expect(priceIdToPlan("price_1UaLUu4CKkTxZIvG08wFKSfS", PRICE_IDS)).toBe("business");
    expect(priceIdToPlan("price_unknown", PRICE_IDS)).toBeNull();
    expect(priceIdToPlan(null, PRICE_IDS)).toBeNull();
  });

  test("environment overrides win over the test defaults", () => {
    const ids = priceIdsFromEnv((k) => (k === "STRIPE_PRICE_STARTER" ? "price_live_starter" : undefined));
    expect(ids.starter).toBe("price_live_starter");
    expect(ids.growth).toBe(PRICE_IDS.growth);
  });
});

describe("stripeTsToIso", () => {
  test("converts unix seconds to ISO, null on bad input", () => {
    expect(stripeTsToIso(1792000000)).toBe(new Date(1792000000 * 1000).toISOString());
    expect(stripeTsToIso(null)).toBeNull();
    expect(stripeTsToIso(undefined)).toBeNull();
  });
});
