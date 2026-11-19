// Driver feed: open orders nearby and along published routes, with lock reasons.
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable } from 'react-native';
import { currentPosition } from '../../src/device';
import { money, windowText } from '../../src/format';
import { useLoad, useSession } from '../../src/session';
import { Button, Card, Countdown, Empty, ErrorBox, Notice, P, Pill, Route, Row, Screen } from '../../src/ui';

export default function Feed() {
  const { api, me, t, lang, refreshMe } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(() => api.feed(), [], ['order', 'notification']);

  useEffect(() => {
    currentPosition().then((p) => p && api.location(p.lat, p.lng)).catch(() => undefined);
    refreshMe();
  }, [api, refreshMe]);

  const status = me?.driver?.status ?? 'none';
  if (status !== 'approved') {
    return (
      <Screen refreshing={loading} onRefresh={() => { refreshMe(); reload(); }}>
        {status === 'pending' ? <Notice text={t('pendingReview')} /> : null}
        {status === 'paused' ? <Notice text={t('paused', { reason: me?.driver?.pausedReason ?? '' })} /> : null}
        {status === 'none' || status === 'draft' || status === 'rejected' ? <P>{t('notApproved')}</P> : null}
        <Button title={status === 'none' ? t('becomeDriver') : t('continueSetup')} onPress={async () => {
          if (status === 'none') await api.startDriver();
          router.push('/onboarding');
        }} />
      </Screen>
    );
  }

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <ErrorBox text={error} onRetry={reload} retryLabel={t('retry')} />
      {data && data.items.length === 0 ? <Empty text={t('feedEmpty')} /> : null}
      {data?.items.map((o) => {
        const e = o.eligibility!;
        const counter = o.offers.find((f) => f.by === 'client' && f.status === 'pending');
        return (
          <Pressable key={o.id} onPress={() => router.push(`/job/${o.id}`)}>
            <Card highlight={e.requestedToMe || e.onMyTrip}>
              <Row between>
                <Pill text={o.intercity ? `${o.distanceKm} km` : t('kmAway', { n: e.distanceToPickupKm ?? '?' })} />
                {e.requestedToMe ? <Pill tone="go" text={t('requestToYou')} /> : e.onMyTrip ? <Pill tone="go" text={t('onYourTrip')} /> : null}
              </Row>
              <Route from={o.pickup.city} to={o.dropoff.city} sub={`${o.pickup.address} → ${o.dropoff.address}`} />
              <P small muted>{windowText(o.windowStart, o.windowEnd, lang)}</P>
              <Row between>
                <P small>{t(`size${o.size}` as 'sizeS')}{o.description ? ` · ${o.description}` : ''}</P>
                <P style={{ fontWeight: '800' }}>{money(o.priceCents)}</P>
              </Row>
              <P small muted>{t('cargoValue', { v: money(o.declaredValueCents) })}{o.insured ? ` · ${t('insured')}` : ''}</P>
              {e.lockReason === 'pro_window' && e.opensAt ? <Countdown to={e.opensAt} render={(left) => t('lockedPro', { t: left })} /> : null}
              {e.lockReason === 'cargo_limit' ? <Notice text={t('lockedCargo', { limit: money(me?.driver?.cargoLimitCents ?? 0) })} /> : null}
              {counter ? <P style={{ fontWeight: '700' }}>{t('clientOffers')}: {money(counter.amountCents)}</P> : null}
            </Card>
          </Pressable>
        );
      })}
    </Screen>
  );
}
