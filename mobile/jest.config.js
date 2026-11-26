// Jest config for Easy HR bot-logic tests.
// Run with: npm test   (from the mobile/ folder)
// Push v1 step 6: lib/ joined the roots so the pure push helpers
// (lib/push-helpers.js, no native imports) are unit-tested too.
// App screens stay out — they need the native runtime, not Jest.
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/supabase/functions", "<rootDir>/lib"],
  testMatch: ["**/*.test.ts", "**/*.test.js"],
  // esbuild-jest covers .js too, so the lib helpers (ESM import /
  // export) run under Jest. (The "ock(" Babel landmine does not
  // apply here — neither helper file contains that substring.)
  transform: { "^.+\\.[tj]sx?$": "esbuild-jest" },
};
