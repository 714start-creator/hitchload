import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { StatusPill } from '../../src/components';
import { money, windowText } from '../../src/format';
import { useLoad, useSession } from '../../src/session';
import { Card, Empty, ErrorBox, P, Route, Row, Screen } from '../../src/ui';

export default function Orders() {
  const { api, t, lang } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(() => api.orders(), [], ['order']);
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <ErrorBox text={error} onRetry={reload} retryLabel={t('retry')} />
      {data && data.length === 0 ? <Empty text={t('noOrders')} /> : null}
      {data?.map((o) => {
        const pendingOffers = o.offers.filter((f) => f.by === 'driver' && f.status === 'pending').length;
        return (
          <Pressable key={o.id} onPress={() => router.push(`/order/${o.id}`)}>
            <Card highlight={o.status !== 'open' && o.status !== 'delivered' && o.status !== 'cancelled'}>
              <Row between>
                <P small muted>{t('order', { n: o.number })}</P>
                <StatusPill status={o.status} />
              </Row>
              <Route from={o.pickup.city} to={o.dropoff.city} sub={windowText(o.windowStart, o.windowEnd, lang)} />
              <Row between>
                <P small>{o.description || '—'}</P>
                <P>{money(o.chargedCents ?? o.priceCents)}</P>
              </Row>
              {pendingOffers ? <P small style={{ fontWeight: '700' }}>{t('offerFrom')}: {pendingOffers}</P> : null}
            </Card>
          </Pressable>
        );
      })}
    </Screen>
  );
}
