import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable } from 'react-native';
import { dayTime } from '../src/format';
import { useLoad, useSession } from '../src/session';
import { Card, Empty, P, Screen } from '../src/ui';

export default function Notifications() {
  const { api, lang, mode } = useSession();
  const router = useRouter();
  const { data, loading, reload } = useLoad(() => api.notifications(), [], ['notification']);
  useEffect(() => {
    const top = data?.[0];
    if (top && !top.read) api.markRead(top.id).catch(() => undefined);
  }, [data, api]);
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {data && data.length === 0 ? <Empty text="—" /> : null}
      {data?.map((n) => (
        <Pressable key={n.id} disabled={!n.orderId} onPress={() => router.push(mode === 'driver' ? `/job/${n.orderId}` : `/order/${n.orderId}`)}>
          <Card highlight={!n.read}>
            <P style={{ fontWeight: '700' }}>{n.title}</P>
            <P>{n.body}</P>
            <P small muted>{dayTime(n.createdAt, lang)}</P>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
