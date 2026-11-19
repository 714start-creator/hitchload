import { Redirect, Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSession } from '../../src/session';
import { useColors } from '../../src/theme';

const icon = (glyph: string) => ({ color }: { color: string }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;

export default function DriverTabs() {
  const { token, t } = useSession();
  const c = useColors();
  if (!token) return <Redirect href="/sign-in" />;
  return (
    <Tabs screenOptions={{ tabBarActiveTintColor: c.sign, headerStyle: { backgroundColor: c.panel }, headerTintColor: c.ink, tabBarStyle: { backgroundColor: c.panel } }}>
      <Tabs.Screen name="index" options={{ title: t('tabFeed'), headerTitle: t('feedTitle'), tabBarIcon: icon('◎') }} />
      <Tabs.Screen name="jobs" options={{ title: t('tabJobs'), tabBarIcon: icon('▤') }} />
      <Tabs.Screen name="trips" options={{ title: t('tabTrips'), headerTitle: t('myTrips'), tabBarIcon: icon('➜') }} />
      <Tabs.Screen name="profile" options={{ title: t('tabProfile'), tabBarIcon: icon('◉') }} />
    </Tabs>
  );
}
