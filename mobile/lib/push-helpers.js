// Push v1 step 6: pure helpers for deep-linking and banner
// suppression. No native imports, so Jest can test them directly
// (lib/push.js itself pulls in expo-notifications and AsyncStorage,
// which Jest cannot load).

// A deep link is a path inside the app — "/timeoff", "/manager",
// "/subscription". Anything else (a full URL, an empty string, a
// non-string) is not a screen we can open.
export function isValidDeepLink(url) {
  return typeof url === "string" && url.startsWith("/");
}

// A ping that arrives while the app is already showing the screen
// it points to is not a banner — the user is looking at it. The
// sender still logs the notification; only the in-app banner is
// suppressed.
export function shouldSuppressBanner(notificationUrl, currentRoute) {
  return isValidDeepLink(notificationUrl) && notificationUrl === currentRoute;
}
