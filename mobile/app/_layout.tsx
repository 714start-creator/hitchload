import { StripeProvider } from '@stripe/stripe-react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { onNotificationTap, registerPush } from '../src/device';
import { SessionProvider, useSession } from '../src/session';
import { useColors } from '../src/theme';
import { Loading } from '../src/ui';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <Root />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { ready, token, api, mode, t } = useSession();
  const c = useColors();
  const router = useRouter();
  const [stripeKey, setStripeKey] = useState('');

  useEffect(() => {
    api.config().then((cfg) => setStripeKey(cfg.stripePublishableKey)).catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (!token) return;
    registerPush(api).catch(() => undefined);
    return onNotificationTap((orderId) => {
      if (!orderId) return router.push('/notifications');
      router.push(mode === 'driver' ? `/job/${orderId}` : `/order/${orderId}`);
    });
  }, [token, api, mode, router]);

  if (!ready) return <Loading text={t('loading')} />;

  return (
    <StripeProvider publishableKey={stripeKey || 'pk_test_placeholder'} urlScheme="poputka" merchantIdentifier="merchant.ca.poputka">
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.panel },
          headerTintColor: c.ink,
          contentStyle: { backgroundColor: c.bg },
          headerBackTitle: t('close'),
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="client" options={{ headerShown: false }} />
        <Stack.Screen name="driver" options={{ headerShown: false }} />
        <Stack.Screen name="order/[id]" options={{ title: '' }} />
        <Stack.Screen name="job/[id]" options={{ title: '' }} />
        <Stack.Screen name="chat/[id]" options={{ title: t('chat') }} />
        <Stack.Screen name="notifications" options={{ title: t('notifications') }} />
        <Stack.Screen name="onboarding/index" options={{ title: t('onboarding') }} />
        <Stack.Screen name="onboarding/[step]" options={{ title: '' }} />
        <Stack.Screen name="tax" options={{ title: t('taxTitle') }} />
      </Stack>
    </StripeProvider>
  );
}
