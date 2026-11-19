import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { StatusPill } from '../../src/components';
import { money, windowText } from '../../src/format';
import { useLoad, useSession } from '../../src/session';
import type { Earnings, Order } from '../../src/types';
import { Card, Choice, Empty, ErrorBox, Label, P, Route, Row, Screen } from '../../src/ui';

export default function Jobs() {
  const { api, t, lang } = useSession();
  const router = useRouter();
  const [scope, setScope] = useState<'active' | 'history'>('active');
  const { data, error, loading, reload } = useLoad<{ jobs: Order[]; earnings: Earnings }>(
    async () => ({ jobs: await api.jobs(scope), earnings: await api.earnings() }),
    [scope],
    ['order'],
  );
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {data ? (
        <Card>
          <Label>{t('earnings')}</Label>
          <Row between><P muted>{t('earnToday')}</P><P>{money(data.earnings.todayCents)}</P></Row>
          <Row between><P muted>{t('earnWeek')}</P><P>{money(data.earnings.weekCents)}</P></Row>
          <Row between><P muted>{t('earnYear')}</P><P>{money(data.earnings.yearCents)}</P></Row>
          {data.earnings.heldCents ? <Row between><P muted>{t('earnHeld')}</P><P>{money(data.earnings.heldCents)}</P></Row> : null}
        </Card>
      ) : null}
      <Choice value={scope} onChange={setScope} options={[{ value: 'active', label: t('active') }, { value: 'history', label: t('history') }]} />
      <ErrorBox text={error} onRetry={reload} retryLabel={t('retry')} />
      {data && data.jobs.length === 0 ? <Empty text={t('noJobs')} /> : null}
      {data?.jobs.map((o) => (
        <Pressable key={o.id} onPress={() => router.push(`/job/${o.id}`)}>
          <Card highlight={scope === 'active'}>
            <Row between>
              <P small muted>{t('job', { n: o.number })}</P>
              <StatusPill status={o.status} />
            </Row>
            <Route from={o.pickup.city} to={o.dropoff.city} sub={windowText(o.windowStart, o.windowEnd, lang)} />
            <Row between>
              <P small>{o.description || t(`size${o.size}` as 'sizeS')}</P>
              <P>{money(o.status === 'cancelled' ? o.driverCompCents ?? 0 : o.driverNetCents ?? 0)}</P>
            </Row>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
