// New order: addresses, size, value + optional insurance, loading window, price,
// and the drivers already going that way (intercity).
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { PlaceInput, RouteMap, sizeOrder } from '../../src/components';
import { takeAndUpload } from '../../src/device';
import { buildWindow, dayTime, dollarsToCents, money, time, type PlaceValue } from '../../src/format';
import { useSession } from '../../src/session';
import { useColors } from '../../src/theme';
import type { Quote, Size } from '../../src/types';
import { Button, Card, Check, Choice, ErrorBox, Field, H, Label, MoneyLines, Notice, P, Pill, Row, Screen } from '../../src/ui';

export default function NewOrder() {
  const { api, token, me, t, lang, errorMessage } = useSession();
  const c = useColors();
  const router = useRouter();
  const [pickup, setPickup] = useState<PlaceValue | null>(null);
  const [dropoff, setDropoff] = useState<PlaceValue | null>(null);
  const [size, setSize] = useState<Size>('L');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<{ key: string; uri: string }[]>([]);
  const [value, setValue] = useState('500');
  const [insured, setInsured] = useState(false);
  const [day, setDay] = useState<'0' | '1' | '2'>('0');
  const [from, setFrom] = useState('10:00');
  const [to, setTo] = useState('18:00');
  const [price, setPrice] = useState<string | null>(null);
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelHours, setCancelHours] = useState(24);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.config().then((cfg) => setCancelHours(cfg.rules.cancelLateHours)).catch(() => undefined);
  }, [api]);

  const window = useMemo(() => buildWindow(Number(day), from, to), [day, from, to]);
  const valueCents = dollarsToCents(value) ?? 0;

  useEffect(() => {
    if (!pickup || !dropoff) return setQuote(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api
        .quote({ pickup, dropoff, size, declaredValueCents: valueCents, insured, windowStart: window?.start, windowEnd: window?.end })
        .then((q) => {
          setQuote(q);
          setError(null);
        })
        .catch((e) => setError(errorMessage(e)));
    }, 400);
  }, [api, pickup, dropoff, size, valueCents, insured, window?.start, window?.end, errorMessage]);

  const priceCents = price !== null ? dollarsToCents(price) : quote?.suggestedPriceCents ?? null;
  const fee = priceCents ? Math.round(priceCents * (quote?.rates.clientFee ?? 0.05)) : 0;
  const premium = insured && quote ? quote.insuranceCents : 0;
  const ready = Boolean(pickup && dropoff && window && priceCents && priceCents >= 500);
  const profileReady = Boolean(me?.name && me?.email && me?.termsAccepted && me?.card);

  async function submit(tripId?: string) {
    if (!profileReady) {
      router.push('/client/profile');
      return;
    }
    if (!pickup || !dropoff || !window) return;
    setError(null);
    try {
      const o = await api.createOrder({
        pickup, dropoff, size, description, photoKeys: photos.map((p) => p.key), declaredValueCents: valueCents, insured,
        windowStart: window.start, windowEnd: window.end,
        ...(tripId ? { tripId } : { priceCents: priceCents ?? undefined }),
        ...(recipientName ? { recipientName } : {}),
        ...(recipientPhone ? { recipientPhone } : {}),
      });
      setDescription('');
      setPhotos([]);
      setPrice(null);
      router.push(`/order/${o.id}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const highlight = new Set(quote?.trips.map((x) => x.tripId) ?? []);

  return (
    <Screen>
      {!profileReady ? <Notice text={t('needProfile')} /> : null}
      <Card>
        <PlaceInput label={t('from')} value={pickup} onChange={setPickup} />
        <PlaceInput label={t('to')} value={dropoff} onChange={setDropoff} />
        <Label>{t('size')}</Label>
        <Choice value={size} onChange={setSize} options={sizeOrder.map((s) => ({ value: s, label: s, sub: t(`size${s}` as 'sizeS') }))} />
        <Field label={t('what')} value={description} onChangeText={setDescription} placeholder={t('whatPh')} multiline />
        <Label>{t('photos')}</Label>
        <Row wrap>
          {photos.map((p) => (
            <Pressable key={p.key} onLongPress={() => setPhotos(photos.filter((x) => x.key !== p.key))}>
              <Image source={{ uri: p.uri }} style={{ width: 64, height: 64, borderRadius: 8 }} />
            </Pressable>
          ))}
          {photos.length < 6 ? (
            <Button small kind="secondary" title={t('addPhoto')} onPress={async () => {
              try {
                const r = await takeAndUpload(api, token ?? '', 'order', 'library');
                if (r) setPhotos([...photos, r]);
              } catch (e) {
                setError(errorMessage(e));
              }
            }} />
          ) : null}
        </Row>
        <Field label={t('value')} value={value} onChangeText={setValue} keyboardType="decimal-pad" />
        <Check label={t('insurance')} value={insured} onChange={setInsured} />
        <P small muted>
          {insured && quote
            ? t('insuranceNote', { rate: (quote.rates.insurance * 100).toFixed(1), min: money(quote.rates.insuranceMinCents) })
            : t('noInsuranceNote')}
        </P>
      </Card>

      <Card>
        <Label>{t('loadingWindow')}</Label>
        <Choice value={day} onChange={setDay} options={[{ value: '0', label: t('today') }, { value: '1', label: t('tomorrow') }, { value: '2', label: t('dayAfter') }]} />
        <Row>
          <Field label={t('fromTime')} value={from} onChangeText={setFrom} keyboardType="numbers-and-punctuation" maxLength={5} />
          <Field label={t('toTime')} value={to} onChangeText={setTo} keyboardType="numbers-and-punctuation" maxLength={5} />
        </Row>
        {!window ? <P small style={{ color: c.red }}>HH:MM</P> : <P small muted>{dayTime(window.start, lang)}–{time(window.end, lang)}</P>}
      </Card>

      <Card>
        <Label>{t('recipient')}</Label>
        <Row>
          <Field placeholder={t('recipientName')} value={recipientName} onChangeText={setRecipientName} />
          <Field placeholder={t('recipientPhone')} value={recipientPhone} onChangeText={setRecipientPhone} keyboardType="phone-pad" />
        </Row>
        <P small muted>{t('recipientNote')}</P>
      </Card>

      <Card>
        <Field
          label={t('yourPrice')}
          value={price ?? (quote ? String(quote.suggestedPriceCents / 100) : '')}
          onChangeText={setPrice}
          keyboardType="decimal-pad"
        />
        {quote ? (
          <Row between>
            <P small muted>{t('suggested', { price: money(quote.suggestedPriceCents), km: quote.distanceKm })}</P>
            {price !== null ? <Button small kind="ghost" title={`↺ ${money(quote.suggestedPriceCents)}`} onPress={() => setPrice(null)} /> : null}
          </Row>
        ) : null}
        {priceCents ? (
          <MoneyLines
            lines={[[t('yourPrice'), priceCents], [t('serviceFee'), fee], ...(premium ? [[t('insuranceLine'), premium] as [string, number]] : [])]}
            total={[t('youPay'), priceCents + fee + premium]}
          />
        ) : null}
        <P small muted>{t('chargedWhen')}</P>
        <P small muted>{t('cancelTermsText', { h: cancelHours })}</P>
        <Button title={t('postOrder')} disabled={!ready} onPress={() => submit()} />
        <ErrorBox text={error} />
      </Card>

      {quote?.intercity ? (
        <Card>
          <H>{t('trips')}</H>
          <P small muted>{t('tripsHint')}</P>
          <RouteMap trips={quote.trips.map((x) => ({ id: x.tripId, stops: x.stops }))} highlight={highlight} pickup={pickup} dropoff={dropoff} />
          {quote.trips.length === 0 ? <P muted>{t('noTrips')}</P> : null}
          {quote.trips.map((x) => (
            <Card key={x.tripId} highlight={x.fitsWindow}>
              <Row between>
                <P>
                  {x.driver.name} · ★ {x.driver.rating?.toFixed(1) ?? '—'} · {x.driver.vehicle}
                </P>
                <Pill text={x.driver.tier === 'pro' ? t('tierPro') : t('tierBasic')} tone={x.driver.tier === 'pro' ? 'done' : 'plain'} />
              </Row>
              <P small>{x.stops.map((s) => s.city).join(' → ')}</P>
              <P small muted>
                {t('departs', { time: dayTime(x.departAt, lang) })} · {t('picksUp', { time: time(x.pickupEta, lang) })} · {t('arrives', { time: time(x.dropoffEta, lang) })}
              </P>
              {x.fitsWindow ? <Pill tone="go" text={t('fitsWindow')} /> : null}
              <View>
                <Button title={t('sendWithDriver', { price: money(x.priceCents + Math.round(x.priceCents * 0.05) + premium) })} disabled={!pickup || !dropoff || !window} onPress={() => submit(x.tripId)} />
              </View>
            </Card>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
