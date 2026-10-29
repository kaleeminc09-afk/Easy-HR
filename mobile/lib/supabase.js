import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// React Native has no localStorage, so without a storage adapter the
// session lived only in memory: every app restart signed the user out.
// AsyncStorage makes sign-in actually stick across restarts (this is the
// mobile equivalent of "remember me" — there is no checkbox because
// persistence is the default, not an option). detectSessionInUrl is a
// web-only behaviour and stays off on native.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
