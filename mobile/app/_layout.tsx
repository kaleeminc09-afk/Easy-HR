import { useEffect } from 'react';
import { Stack, SplashScreen } from 'expo-router';
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

  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <Stack screenOptions={screenOptions} />
    </SafeAreaProvider>
  );
}
