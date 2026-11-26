// Push notifications, v1 step 1: device token registration.
//
// Native only. Every function here is a no-op on web (the web app has
// no push tokens) and on a simulator/emulator (Expo push tokens need a
// physical device). Nothing here ever throws: token work must never
// block the action that triggered it — a failed registration is a
// silent no-op, and the sender (step 2) treats a missing token as
// "this device cannot be pinged yet", not an error.
//
// Permission is asked only at the value moments, never on first open:
//   - employees: after their first clock-in (GPS home screen, QR scan)
//   - managers: after their first approval (time-off / exception review)
// Callers pass request: true there. Sign-in only refreshes a token
// when permission is already granted (request: false) — it never asks.
//
// The token for this device lives in module memory so sign-out can
// delete exactly this row BEFORE the session is gone: after sign-out
// the RLS delete has no identity and is refused.
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { supabase } from './supabase';

// The token for this device in this session. Kept in memory so sign-out
// can delete exactly this row before the session is gone (after sign-out
// the RLS delete has no identity and is refused).
let currentToken = null;

// Foreground display: a ping that arrives while the app is open still
// shows as a banner. Call once from the root layout; web is a no-op.
// (Effects never run during the static export's prerender, so this is
// safe to call from _layout.tsx.)
export function setupPushNotifications() {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// Register this device for push, saving its Expo token in push_tokens.
// request=true asks the OS for permission, but only when it has never
// been asked (status 'undetermined'); a past 'denied' is never re-asked.
// Returns the token string, or null when push is unavailable or not
// granted. Never throws.
export async function ensurePushToken({ request = false } = {}) {
  try {
    if (Platform.OS === 'web') return null;
    if (!Device.isDevice) return null;
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (status !== 'granted') {
      if (!request || status !== 'undetermined') return null;
      const { status: asked } = await Notifications.requestPermissionsAsync();
      status = asked;
      if (status !== 'granted') return null;
    }
    const projectId = Constants?.expoConfig?.extra?.eas?.projectId;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: tokenData } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = tokenData?.data;
    if (!token) return null;
    const { data: prof } = await supabase
      .from('profiles').select('business_id').eq('id', user.id).maybeSingle();
    const { error } = await supabase.from('push_tokens').upsert([{
      user_id: user.id,
      business_id: prof?.business_id || null,
      token,
      platform: Platform.OS,
      is_active: true,
      last_seen_at: new Date().toISOString(),
    }], { onConflict: 'user_id,token' });
    if (error) return null;
    currentToken = token;
    return token;
  } catch {
    return null;
  }
}

// Delete this device's token row. Call BEFORE sign-out: after sign-out
// the RLS delete has no identity and is refused. No-op on web, and a
// no-op when no token was registered this session. Never throws.
export async function removePushToken() {
  try {
    if (Platform.OS === 'web') return;
    if (!currentToken) return;
    await supabase.from('push_tokens').delete().eq('token', currentToken);
    currentToken = null;
  } catch {
    // Push cleanup never blocks sign-out.
  }
}
