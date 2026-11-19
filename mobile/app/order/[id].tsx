// Customer's order: status, offers and counter-offers, PIN, driver, live map,
// cancellation with the exact split, rating and disputes.
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { RouteMap, StatusPill } from '../../src/components';
import { dollarsToCents, money, windowText } from '../../src/format';
import { useLoad, useSession } from '../../src/session';
import { useColors } from '../../src/theme';
import type { CancelPreview } from '../../src/types';
import { Button, Card, Countdown, ErrorBox, Field, H, Label, Loading, MoneyLines, Notice, P, Photos, Route, Row, Screen, Stars, Steps } from '../../src/ui';

const STEP: Record<string, number> = { open: 0, agreed: 1, picked_up: 2, in_transit: 3, delivered: 4, cancelled: 0 };

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, t, lang, errorMessage } = useSession();
  const c = useColors();
  const router = useRouter();
  const { data: o, error, loading, reload } = useLoad(() => api.order(id), [id], ['order', 'driver_position']);
  const [counter, setCounter] = useState<Record<string, string>>({});
  const [cancel, setCancel] = useState<CancelPreview | null>(null);
  const [stars, setStars] = useState(0);
  const [rated, setRated] = useState(false);
  const [dispute, setDispute] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (!o) return error ? <Screen><ErrorBox text={error} onRetry={reload} retryLabel={t('retry')} /></Screen> : <Loading text={t('loading')} />;

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(errorMessage(e));
      await reload();
    }
  };
  const driverOffers = o.offers.filter((f) => f.by === 'driver' && f.status === 'pending');
  const myCounters = o.offers.filter((f) => f.by === 'client');
  const assigned = o.status === 'agreed' || o.status === 'picked_up' || o.status === 'in_transit';

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: t('order', { n: o.number }) }} />
      <Row between>
        <StatusPill status={o.status} />
        <P small muted>{o.distanceKm} km</P>
      </Row>
      <Route from={o.pickup.address + ', ' + o.pickup.city} to={o.dropoff.address + ', ' + o.dropoff.city} sub={windowText(o.windowStart, o.windowEnd, lang)} />
      {o.status !== 'cancelled' ? <Steps index={STEP[o.status] ?? 0} /> : null}
      <Photos urls={o.photos} />
      {o.paymentError && o.status === 'open' ? <Notice text={t('paymentFailed', { e: o.paymentError })} /> : null}

      {o.status === 'open' ? (
        <Card>
          {o.requestedDriver ? <P>{t('requestSent')}</P> : <Countdown to={o.proUntil} render={(left) => `${t('proWindow')} · ${left}`} />}
          {driverOffers.map((f) => {
            const usedCounter = myCounters.length > 0;
            return (
              <Card key={f.id} highlight>
                <Row between>
                  <P>{t('offerFrom')}</P>
                  <Text style={{ color: c.ink, fontWeight: '800', fontSize: 18 }}>{money(f.amountCents)}</Text>
                </Row>
                <Row>
                  <Button small title={t('accept')} onPress={() => act(() => api.respondOffer(o.id, f.id, 'accept'))} />
                  <Button small kind="secondary" title={t('decline')} onPress={() => act(() => api.respondOffer(o.id, f.id, 'decline'))} />
                </Row>
                {usedCounter ? (
                  <P small muted>{t('counterUsed')}</P>
                ) : (
                  <Row>
                    <Field value={counter[f.id] ?? ''} onChangeText={(s: string) => setCounter({ ...counter, [f.id]: s })} keyboardType="decimal-pad" placeholder="$" style={{ width: 110 }} />
                    <Button small kind="secondary" title={t('counter')} onPress={() => act(() => api.respondOffer(o.id, f.id, 'counter', dollarsToCents(counter[f.id] ?? '') ?? 0))} />
                  </Row>
                )}
              </Card>
            );
          })}
          {myCounters.some((f) => f.status === 'pending') ? <P muted>{t('waitingDriver')}</P> : null}
          <Row between>
            <P muted>{t('yourPrice')}</P>
            <P>{money(o.priceCents)}</P>
          </Row>
          <Button kind="ghost" title={t('cancelFree')} onPress={() => act(() => api.cancel(o.id))} />
        </Card>
      ) : null}

      {o.driver && assigned ? (
        <Card highlight>
          <Label>{t('driver')}</Label>
          <P>{o.driver.name} · ★ {o.driver.rating?.toFixed(1) ?? '—'} · {o.driver.vehicle ?? ''}</P>
          {o.driverPosition ? <RouteMap trips={[]} pickup={o.pickup} dropoff={o.dropoff} driver={o.driverPosition} height={180} /> : null}
          <Button kind="secondary" title={t('chat')} onPress={() => router.push(`/chat/${o.id}`)} />
        </Card>
      ) : null}

      {o.pin && assigned ? (
        <Card>
          <Label>{t('pinTitle')}</Label>
          <Text style={{ color: c.ink, fontSize: 34, letterSpacing: 10, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{o.pin}</Text>
          <P small muted>{t('pinHint')}</P>
        </Card>
      ) : null}

      {o.pickupPhotos.length ? (
        <Card>
          <Label>{t('pickupPhotos')}</Label>
          <Photos urls={o.pickupPhotos.map((p) => p.url)} size={96} />
        </Card>
      ) : null}

      {o.chargedCents ? (
        <Card>
          <MoneyLines
            lines={[[t('yourPrice'), o.agreedCents ?? 0], [t('serviceFee'), o.clientFeeCents ?? 0], ...(o.insuranceCents ? [[t('insuranceLine'), o.insuranceCents] as [string, number]] : [])]}
            total={[t('charged'), o.chargedCents]}
          />
          {o.refundCents ? <Row between><P muted>{t('refunded')}</P><P>{money(o.refundCents)}</P></Row> : null}
        </Card>
      ) : null}

      {o.status === 'agreed' ? (
        cancel ? (
          <Card>
            <H>{t('cancelOrder')}</H>
            <MoneyLines lines={[[t('toDriver'), cancel.driverCents], [t('toPlatform'), cancel.platformCents], [t('feeKept'), cancel.keptFeeCents]]} total={[t('refund'), cancel.refundCents]} />
            <Row>
              <Button kind="danger" title={t('cancelConfirm')} onPress={() => act(async () => { await api.cancel(o.id); setCancel(null); })} />
              <Button kind="ghost" title={t('keepOrder')} onPress={() => setCancel(null)} />
            </Row>
          </Card>
        ) : (
          <Button kind="ghost" title={t('cancelOrder')} onPress={async () => setCancel(await api.cancelPreview(o.id))} />
        )
      ) : null}

      {o.status === 'delivered' && !rated ? (
        <Card>
          <Label>{t('rateDriver')}</Label>
          <Stars value={stars} onChange={setStars} />
          <Button disabled={!stars} title={t('send')} onPress={() => act(async () => { await api.rate(o.id, stars); setRated(true); })} />
        </Card>
      ) : rated ? <P muted>{t('thanks')}</P> : null}

      {o.status !== 'open' ? (
        <Card>
          <Label>{t('openDispute')}</Label>
          <Field value={dispute} onChangeText={setDispute} placeholder={t('disputePh')} multiline />
          <Button kind="secondary" disabled={dispute.trim().length < 5} title={t('send')} onPress={() => act(async () => { await api.dispute(o.id, dispute); setDispute(''); setMsg(t('disputeSent')); })} />
          {msg ? <Notice tone="go" text={msg} /> : null}
        </Card>
      ) : null}
      <ErrorBox text={err} />
    </Screen>
  );
}
