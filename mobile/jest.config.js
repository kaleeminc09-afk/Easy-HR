// Jest config for Easy HR bot-logic tests.
// Run with: npm test   (from the mobile/ folder)
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/supabase/functions"],
  testMatch: ["**/*.test.ts"],
  transform: { "^.+\\.tsx?$": "esbuild-jest" },
};
