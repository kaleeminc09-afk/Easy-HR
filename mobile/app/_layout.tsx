import { useEffect } from 'react';
import { Stack, SplashScreen, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
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
  // which redirects to easyhr://invite carrying session tokens. Sign them
  // in from those tokens and land on Profile, where Change Password sets
  // their first password. Any other link is left alone.
  useEffect(() => {
    const handleUrl = async (url: string | null) => {
      if (!url) return;
      const isInvite = url.startsWith('easyhr://invite') || url.includes('type=invite');
      if (!isInvite) return;
      try {
        const hash = url.split('#')[1] || '';
        const hashParams = new URLSearchParams(hash);
        const access_token = hashParams.get('access_token');
        const refresh_token = hashParams.get('refresh_token');
        if (access_token && refresh_token) {
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          if (!error) { router.replace('/profile'); return; }
        }
        const query = url.split('?')[1]?.split('#')[0] || '';
        const code = new URLSearchParams(query).get('code');
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (!error) router.replace('/profile');
        }
      } catch {
        // Not a usable invite link; leave the session alone.
      }
    };
    Linking.getInitialURL().then(handleUrl);
    const sub = Linking.addEventListener('url', (e) => handleUrl(e.url));
    return () => sub.remove();
  }, []);

  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <Stack screenOptions={screenOptions} />
    </SafeAreaProvider>
  );
}
