// Push v1 step 6: unit tests for the deep-link and banner helpers.
import { isValidDeepLink, shouldSuppressBanner } from "./push-helpers";

describe("isValidDeepLink", () => {
  test("accepts app paths", () => {
    expect(isValidDeepLink("/timeoff")).toBe(true);
    expect(isValidDeepLink("/manager")).toBe(true);
    expect(isValidDeepLink("/")).toBe(true);
  });
  test("rejects anything that is not an app path", () => {
    expect(isValidDeepLink("timeoff")).toBe(false);
    expect(isValidDeepLink("https://northshiftapp.com/timeoff")).toBe(false);
    expect(isValidDeepLink("")).toBe(false);
    expect(isValidDeepLink(null)).toBe(false);
    expect(isValidDeepLink(undefined)).toBe(false);
    expect(isValidDeepLink(123)).toBe(false);
  });
});

describe("shouldSuppressBanner", () => {
  test("suppresses when the ping points at the open screen", () => {
    expect(shouldSuppressBanner("/timeoff", "/timeoff")).toBe(true);
  });
  test("shows the banner for any other screen", () => {
    expect(shouldSuppressBanner("/timeoff", "/manager")).toBe(false);
    expect(shouldSuppressBanner("/manager", "/")).toBe(false);
  });
  test("never suppresses on a bad link or an unknown route", () => {
    expect(shouldSuppressBanner(null, "/timeoff")).toBe(false);
    expect(shouldSuppressBanner("/timeoff", null)).toBe(false);
    expect(shouldSuppressBanner("timeoff", "timeoff")).toBe(false);
  });
});
