// Driver's view of an order: take / offer / answer a counter / decline a booking;
// once assigned: head out, pickup photos, depart, deliver by PIN, or drop.
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { StatusPill } from '../../src/components';
import { currentPosition, takeAndUpload, watchDriverPosition } from '../../src/device';
import { directionsUrl, dollarsToCents, money, windowText } from '../../src/format';
import { ApiError } from '../../src/api';
import { useLoad, useSession } from '../../src/session';
import { Button, Card, Countdown, ErrorBox, Field, Label, Loading, Notice, P, Photos, Route, Row, Screen, Stars, Steps } from '../../src/ui';

const STEP: Record<string, number> = { open: 0, agreed: 1, picked_up: 2, in_transit: 3, delivered: 4, cancelled: 0 };

export default function JobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, token, me, t, lang, errorMessage } = useSession();
  const router = useRouter();
  const { data: o, error, loading, reload } = useLoad(() => api.driverOrder(id), [id], ['order']);
  const [offer, setOffer] = useState('');
  const [photos, setPhotos] = useState<{ key: string; uri: string }[]>([]);
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [dropReason, setDropReason] = useState('');
  const [showDrop, setShowDrop] = useState(false);
  const [stars, setStars] = useState(0);
  const [rated, setRated] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const mine = o?.driverNetCents !== undefined && o?.eligibility === null;
  const active = mine && (o?.status === 'agreed' || o?.status === 'picked_up' || o?.status === 'in_transit');

  useEffect(() => {
    if (!active) return;
    let stop: (() => void) | undefined;
    watchDriverPosition(api).then((s) => (stop = s));
    return () => stop?.();
  }, [active, api]);

  if (!o) return error ? <Screen><ErrorBox text={error} onRetry={reload} retryLabel={t('retry')} /></Screen> : <Loading text={t('loading')} />;

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'wrong_pin') setErr(t('wrongPin', { n: (e.details as { attemptsLeft?: number })?.attemptsLeft ?? 0 }));
      else setErr(errorMessage(e));
    }
    await reload();
  };
  const addPhoto = async (purpose: 'pickup' | 'delivery') => {
    try {
      const r = await takeAndUpload(api, token ?? '', purpose, 'camera');
      if (r) setPhotos([...photos, r]);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };
  const e = o.eligibility;
  const myOffer = o.offers.find((f) => f.by === 'driver');
  const counter = o.offers.find((f) => f.by === 'client' && f.status === 'pending');
  const net = (cents: number) => cents - Math.round(cents * 0.05);
  const target = o.status === 'agreed' ? o.pickup : o.dropoff;

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: t('job', { n: o.number }) }} />
      <Row between>
        <StatusPill status={o.status} />
        <P small muted>{o.distanceKm} km</P>
      </Row>
      <Route from={`${o.pickup.address}, ${o.pickup.city}`} to={`${o.dropoff.address}, ${o.dropoff.city}`} sub={windowText(o.windowStart, o.windowEnd, lang)} />
      <P>{t(`size${o.size}` as 'sizeS')}{o.description ? ` · ${o.description}` : ''}</P>
      <P small muted>{t('cargoValue', { v: money(o.declaredValueCents) })}{o.insured ? ` · ${t('insured')}` : ''}{o.client?.name ? ` · ${o.client.name} ★ ${o.client.rating?.toFixed(1) ?? '—'}` : ''}</P>
      <Photos urls={o.photos} size={96} />

      {e && o.status === 'open' ? (
        <Card highlight={e.canTake}>
          {e.lockReason === 'pro_window' && e.opensAt ? <Countdown to={e.opensAt} render={(left) => t('lockedPro', { t: left })} /> : null}
          {e.lockReason === 'cargo_limit' ? <Notice text={t('lockedCargo', { limit: money(me?.driver?.cargoLimitCents ?? 0) })} /> : null}
          {e.canTake ? (
            <>
              <Button title={t('take', { price: money(o.priceCents) })} onPress={() => act(async () => { await api.take(o.id); })} />
              <P small muted>{t('youGet', { price: money(net(o.priceCents)) })}</P>
              {e.requestedToMe ? (
                <Button kind="ghost" title={t('declineRequest')} onPress={() => act(async () => { await api.declineRequest(o.id); router.back(); })} />
              ) : counter ? (
                <Card>
                  <P>{t('clientOffers')}: {money(counter.amountCents)}</P>
                  <Row>
                    <Button small title={t('accept')} onPress={() => act(() => api.answerCounter(o.id, 'accept'))} />
                    <Button small kind="secondary" title={t('decline')} onPress={() => act(() => api.answerCounter(o.id, 'decline'))} />
                  </Row>
                </Card>
              ) : myOffer ? (
                <P muted>{t('offerSent', { price: money(myOffer.amountCents) })}</P>
              ) : (
                <Row>
                  <Field value={offer} onChangeText={setOffer} keyboardType="decimal-pad" placeholder="$" style={{ width: 110 }} />
                  <Button small kind="secondary" title={t('propose')} disabled={!dollarsToCents(offer)} onPress={() => act(() => api.offer(o.id, dollarsToCents(offer) ?? 0))} />
                </Row>
              )}
            </>
          ) : null}
        </Card>
      ) : null}

      {mine ? (
        <>
          {o.status !== 'cancelled' ? <Steps index={STEP[o.status] ?? 0} /> : null}
          <Row between>
            <P>{t('youGet', { price: money(o.driverNetCents ?? 0) })}</P>
            {active ? <Button small kind="secondary" title={t('openNav')} onPress={() => Linking.openURL(directionsUrl(target.lat, target.lng))} /> : null}
          </Row>
          {o.recipientName ? <P small muted>{t('recipientName')}: {o.recipientName}</P> : null}
          {active ? <Button kind="secondary" title={t('chat')} onPress={() => router.push(`/chat/${o.id}`)} /> : null}

          {o.status === 'agreed' ? (
            <Card>
              {!o.enRouteAt ? <Button kind="secondary" title={t('headingOut')} onPress={() => act(() => api.enRoute(o.id))} /> : null}
              <Label>{t('pickupStep')}</Label>
              <P small muted>{t('pickupHint')}</P>
              <Photos urls={photos.map((p) => p.uri)} />
              <Button kind="secondary" title={t('takePhoto')} onPress={() => addPhoto('pickup')} />
              <Field label={t('pickupNote')} value={note} onChangeText={setNote} multiline />
              <Button
                title={t('pickupStep')}
                disabled={photos.length === 0}
                onPress={() => act(async () => {
                  const pos = await currentPosition().catch(() => null);
                  await api.pickup(o.id, photos.map((p) => p.key), note || undefined, pos ?? undefined);
                  setPhotos([]);
                })}
              />
              {showDrop ? (
                <Card>
                  <Notice text={t('dropWarn')} />
                  <Field label={t('dropReason')} value={dropReason} onChangeText={setDropReason} />
                  <Button kind="danger" title={t('dropJob')} disabled={dropReason.trim().length < 3} onPress={() => act(async () => { await api.drop(o.id, dropReason); router.back(); })} />
                </Card>
              ) : (
                <Button kind="ghost" title={t('dropJob')} onPress={() => setShowDrop(true)} />
              )}
            </Card>
          ) : null}

          {o.status === 'picked_up' ? <Button title={t('depart')} onPress={() => act(() => api.depart(o.id))} /> : null}

          {o.status === 'picked_up' || o.status === 'in_transit' ? (
            <Card>
              <Field label={t('enterPin')} value={pin} onChangeText={(s: string) => setPin(s.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" maxLength={4} />
              <Photos urls={photos.map((p) => p.uri)} />
              <Button small kind="secondary" title={t('takePhoto')} onPress={() => addPhoto('delivery')} />
              <Button title={t('deliver')} disabled={pin.length !== 4} onPress={() => act(async () => { await api.deliver(o.id, pin, photos.map((p) => p.key)); setPhotos([]); })} />
            </Card>
          ) : null}

          {o.payoutHeldReason ? (
            <Notice text={t('payoutHeld', { reason: o.payoutHeldReason })} />
          ) : null}
          {o.payoutHeldReason === 'tax_info_missing' ? <Button title={t('taxTitle')} onPress={() => router.push('/tax')} /> : null}

          {o.status === 'delivered' && !rated ? (
            <Card>
              <Label>{t('rateClient')}</Label>
              <Stars value={stars} onChange={setStars} />
              <Button disabled={!stars} title={t('send')} onPress={() => act(async () => { await api.rate(o.id, stars); setRated(true); })} />
            </Card>
          ) : null}
        </>
      ) : null}
      <ErrorBox text={err} />
    </Screen>
  );
}
