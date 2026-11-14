// Location reads with a hard timeout. expo-location's
// getCurrentPositionAsync has no timeout of its own: on web, when the
// browser never resolves a position (no GPS, permission dismissed),
// the await hangs forever and clock-in sits on "Verifying GPS
// location..." with no error and no way out — found by the Nov 14
// function test, which hung 90s+ twice. Every location read in the
// app goes through here so a stuck read always fails loudly after
// 10 seconds instead of hanging the core function.
import * as Location from 'expo-location';

export const LOCATION_TIMEOUT_MS = 10000;

export async function getCurrentPosition(timeoutMs = LOCATION_TIMEOUT_MS) {
  let timer = null;
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Location timed out after ${Math.round(timeoutMs / 1000)} seconds. Make sure location is turned on and try again.`
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
