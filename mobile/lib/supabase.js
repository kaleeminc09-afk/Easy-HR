import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// React Native has no localStorage, so without a storage adapter the
// session lived only in memory: every app restart signed the user out.
// AsyncStorage makes sign-in actually stick across restarts (this is the
// mobile equivalent of "remember me" — there is no checkbox because
// persistence is the default, not an option).
//
// Web note (manager web app, step 1): AsyncStorage 2.x ships a web
// implementation backed by window.localStorage, so the SAME adapter
// persists the session in the browser too — no separate web storage
// adapter and no new dependency. Verified against the installed
// 2.2.0 build (lib/commonjs/AsyncStorage.js reads/writes localStorage
// on web). detectSessionInUrl is web-only: on the web app, Supabase
// password-recovery / invite links land as a real URL carrying ?code=
// (or #access_token), and supabase-js must pick that up and exchange
// it for a session. On native it stays off — deep links are handled
// by _layout.tsx (northshift://invite, northshift://reset-password).
// auth-js itself guards detectSessionInUrl behind isBrowser(), so
// that flag is safe during the static export's server render.
//
// SSR guard — this is what makes `expo export --platform web` work at
// all: Expo's static export prerenders every route in Node, where
// there is no window, and the Supabase client recovers the stored
// session at construction time (storage.getItem). An unguarded
// AsyncStorage adapter crashes that prerender with "window is not
// defined" — verified: baseline 87981f7 fails the export the same way,
// before any of this patch. On the server the adapter answers "no
// stored session" and drops writes; in the browser it delegates to
// AsyncStorage exactly as before, and the client recovers the session
// on hydration. Native never prerenders, so it uses AsyncStorage
// directly, unchanged.
const webStorage = {
  getItem: (key) => (typeof window === 'undefined' ? Promise.resolve(null) : AsyncStorage.getItem(key)),
  setItem: (key, value) => (typeof window === 'undefined' ? Promise.resolve() : AsyncStorage.setItem(key, value)),
  removeItem: (key) => (typeof window === 'undefined' ? Promise.resolve() : AsyncStorage.removeItem(key)),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: Platform.OS === 'web' ? webStorage : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});
