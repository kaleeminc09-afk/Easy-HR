import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Stack, SplashScreen, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import WebSidebar from '../components/WebSidebar';
import WebAssistant from '../components/WebAssistant';
import { supabase } from '../lib/supabase';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  Inter_800ExtraBold,
} from '@expo-google-fonts/inter';
import { Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { colors } from '../lib/theme';
import { SafeAreaProvider } from 'react-native-safe-area-context';

SplashScreen.preventAutoHideAsync();

// Sand theme motion — one shared transition for every screen.
// slide_from_right = the native push feel; 220ms keeps it snappy, not floaty.
// contentStyle kills the flash visible behind sand screens mid-transition.
// headerShown: false because every screen renders its own custom header.
const screenOptions = {
  headerShown: false,
  animation: 'slide_from_right',
  animationDuration: 220,
  gestureEnabled: true,
  contentStyle: { backgroundColor: colors.background },
} as const;

export default function RootLayout() {
  const router = useRouter();
  const [session, setSession] = useState<any>(null);

  // Session for the web shell: the toolbar and floating Assistant
  // only render on web while signed in. Mirrors the session
  // subscription in app/index.js.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);
  const [loaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    Sora_800ExtraBold,
  });

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  // Invite-link accept: an invited employee taps the Supabase invite email,
  // which redirects to northshift://invite carrying session tokens. Sign them
  // in from those tokens and land on Profile, where Change Password sets
  // their first password. Password-recovery links work the same way and land
  // on Reset Password, where the new password is set. Any other link is
  // left alone.
  useEffect(() => {
    const handleUrl = async (url: string | null) => {
      if (!url) return;
      const isInvite = url.startsWith('northshift://invite') || url.includes('type=invite');
      // Web (manager web app): a recovery link lands on the web app as
      // https://app.northshiftapp.com/reset-password?code=... — no
      // northshift:// scheme and no type=recovery param. Treat any
      // /reset-password URL carrying a code as a recovery link; the
      // exchange below signs the user in before the screen renders.
      // detectSessionInUrl (web only, lib/supabase.js) also picks the
      // code up, so this is a belt-and-braces path, not the only one.
      const isRecovery = url.startsWith('northshift://reset-password') || url.includes('type=recovery')
        || (url.includes('/reset-password') && (url.includes('code=') || url.includes('access_token=')));
      const target = isInvite ? '/profile' : isRecovery ? '/reset-password' : null;
      if (!target) return;
      try {
        const hash = url.split('#')[1] || '';
        const hashParams = new URLSearchParams(hash);
        const access_token = hashParams.get('access_token');
        const refresh_token = hashParams.get('refresh_token');
        if (access_token && refresh_token) {
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          if (!error) { router.replace(target); return; }
        }
        const query = url.split('?')[1]?.split('#')[0] || '';
        const code = new URLSearchParams(query).get('code');
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (!error) router.replace(target);
        }
      } catch {
        // Not a usable invite/recovery link; leave the session alone.
      }
    };
    Linking.getInitialURL().then(handleUrl);
    const sub = Linking.addEventListener('url', (e) => handleUrl(e.url));
    return () => sub.remove();
  }, []);

  if (!loaded) return null;

  // Web shell: a signed-in web session gets the right toolbar and the
  // floating Assistant next to the Stack. Native, and web with no
  // session (sign-in / reset-password screens), render exactly as
  // before — the shell only wraps authenticated web use.
  if (Platform.OS === 'web' && session) {
    return (
      <SafeAreaProvider>
        <View style={styles.webShell}>
          <View style={styles.webContent}>
            <Stack screenOptions={screenOptions} />
            <WebAssistant />
          </View>
          <WebSidebar />
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <Stack screenOptions={screenOptions} />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  // Row layout: the app content flexes, the toolbar holds a fixed
  // 220px on the right. WebAssistant anchors to webContent, so the
  // floating button and its panel sit over the content, clear of
  // the toolbar.
  webShell: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  webContent: { flex: 1 },
});
