// The order form: addresses, size, photos, value and insurance, loading window, price.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { navigate, useApp, useLocation } from '../lib/app';
import { CardForm } from '../lib/card';
import { ErrorSummary, isPhone, useFormErrors, type Errors } from '../lib/form';
import { dollarsToCents, locale, maskPhone, money, type PlaceValue } from '../lib/format';
import type { Quote, Size } from '../lib/types';
import { Button, Card, ErrorBox, FeeBox, Field, Notice, PageHead, PhotoUpload, PlaceInput, SizePicker, TripCard, isoDay } from '../lib/ui';

interface Draft {
  pickup: PlaceValue | null;
  dropoff: PlaceValue | null;
  size: Size;
  description: string;
  photos: { key: string; url: string }[];
  value: string;
  insured: boolean;
  date: string;
  from: string;
  to: string;
  recipientName: string;
  recipientPhone: string;
  price: string;
}

const DRAFT_KEY = 'hl.orderDraft';
const loadDraft = (): Partial<Draft> | null => {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
  } catch {
    return null;
  }
};
const saveDraft = (d: Draft) => {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch {
    /* ignore */
  }
};

function localIso(date: string, hm: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const h = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m || !h) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(h[1]), Number(h[2])).toISOString();
}

export function NewOrder() {
  const { t, me, refreshMe } = useApp();
  const { query } = useLocation();
  const tripId = query.get('trip');
  const saved = useMemo(loadDraft, []);
  const [d, setD] = useState<Draft>(() => ({
    pickup: saved?.pickup ?? null,
    dropoff: saved?.dropoff ?? null,
    size: (query.get('size') as Size) || saved?.size || 'M',
    description: saved?.description ?? '',
    photos: saved?.photos ?? [],
    value: saved?.value ?? '200',
    insured: saved?.insured ?? false,
    date: query.get('date') || saved?.date || isoDay(0),
    from: saved?.from ?? '10:00',
    to: saved?.to ?? '18:00',
    recipientName: saved?.recipientName ?? '',
    recipientPhone: saved?.recipientPhone ?? '',
    price: saved?.price ?? '',
  }));
  const f = useFormErrors();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => { setD((x) => ({ ...x, [k]: v })); f.clear(k); if (k === 'date' || k === 'from' || k === 'to') { f.clear('date'); f.clear('from'); f.clear('to'); } };
  useEffect(() => saveDraft(d), [d]);

  const [rules, setRules] = useState<{ cancelLateHours: number; insuranceRate: number; insuranceMinCents: number; clientFeeRate: number } | null>(null);
  useEffect(() => void api.config().then((c) => setRules(c.rules)).catch(() => undefined), []);

  const windowStart = localIso(d.date, d.from);
  const windowEnd = localIso(d.date, d.to);
  const valueCents = dollarsToCents(d.value) ?? 0;

  // quote whenever the route, size, value or window changes
  const [quote, setQuote] = useState<Quote | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!d.pickup || !d.dropoff) {
      setQuote(null);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.quote({ pickup: d.pickup!, dropoff: d.dropoff!, size: d.size, declaredValueCents: valueCents, insured: d.insured, windowStart: windowStart ?? undefined, windowEnd: windowEnd ?? undefined })
        .then(setQuote).catch(() => setQuote(null));
    }, 300);
  }, [d.pickup, d.dropoff, d.size, valueCents, d.insured, windowStart, windowEnd]);

  const trip = tripId ? quote?.trips.find((x) => x.tripId === tripId) ?? null : null;
  const priceCents = trip ? trip.priceCents : dollarsToCents(d.price) ?? quote?.suggestedPriceCents ?? 0;
  const feeCents = Math.round(priceCents * (rules?.clientFeeRate ?? 0.05));
  const insCents = d.insured && quote ? quote.insuranceCents : 0;
  const [error, setError] = useState<unknown>(null);
  const [needCard, setNeedCard] = useState(false);

  const fromCity = query.get('from') ?? '';
  const toCity = query.get('to') ?? '';
  const labels: Record<string, string> = {
    pickup: t('pickup'), dropoff: t('dropoff'), description: t('what'), value: t('value'), date: t('loadDate'), from: t('loadFrom'), to: t('loadTo'),
    recipientPhone: t('recipientPhone'), price: t('yourPrice').replace(/, \$$/, ''),
  };

  function validate(): Errors {
    const v = dollarsToCents(d.value);
    const e: Errors = {
      pickup: !d.pickup ? t('errPlace') : '',
      dropoff: !d.dropoff ? t('errPlace') : '',
      description: d.description.trim().length < 3 ? t('errWhat') : '',
      value: v === null || v === undefined || v < 0 ? t('errValue') : '',
      date: !d.date ? t('errRequired') : '',
      from: !d.from ? t('errRequired') : '',
      to: !d.to ? t('errRequired') : '',
      recipientPhone: d.recipientPhone && !isPhone(d.recipientPhone) ? t('errPhone') : '',
      price: !trip && priceCents < 500 ? t('errPrice') : '',
    };
    if (!e.date && !e.from && !e.to && windowStart && windowEnd) {
      if (windowEnd <= windowStart) e.to = t('errWindowOrder');
      else if (new Date(windowEnd).getTime() < Date.now() + 15 * 60_000) e.to = t('errWindowPast');
    }
    return e;
  }

  async function submit() {
    setError(null);
    if (!f.check(validate())) return;
    if (!me) {
      navigate(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
      return;
    }
    if (!me.card) {
      setNeedCard(true);
      return;
    }
    try {
      const o = await api.createOrder({
        pickup: d.pickup, dropoff: d.dropoff, size: d.size, description: d.description, photoKeys: d.photos.map((p) => p.key),
        declaredValueCents: valueCents, insured: d.insured, windowStart, windowEnd,
        ...(trip ? { tripId: trip.tripId } : { priceCents }),
        ...(d.recipientName ? { recipientName: d.recipientName } : {}),
        ...(d.recipientPhone ? { recipientPhone: d.recipientPhone } : {}),
      });
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch {
        /* ignore */
      }
      navigate(`/orders/${o.id}`);
    } catch (e) {
      if ((e as { code?: string }).code === 'card_required') setNeedCard(true);
      if (f.fromServer(e, { bad_window: 'to', invalid_phone: 'recipientPhone', price_out_of_range: 'price' }, {
        pickup: 'pickup', dropoff: 'dropoff', description: 'description', declaredValueCents: 'value', windowStart: 'from', windowEnd: 'to', recipientPhone: 'recipientPhone', priceCents: 'price',
      }, (e as { code?: string }).code === 'bad_window' ? t('errWindowServer') : undefined)) return;
      setError(e);
    }
  }

  return (
    <div className="page">
      <PageHead title={t('newOrderTitle')} back={fromCity && toCity ? `/send?${new URLSearchParams({ from: fromCity, to: toCity })}` : undefined} />
      <div className="split">
        <div className="stack">
          <Card>
            <PlaceInput idPrefix="pickup" name="pickup" error={f.errors.pickup} label={t('pickup')} value={d.pickup} onChange={(p) => set('pickup', p)} defaultCity={fromCity} />
            <PlaceInput idPrefix="dropoff" name="dropoff" error={f.errors.dropoff} label={t('dropoff')} value={d.dropoff} onChange={(p) => set('dropoff', p)} defaultCity={toCity} />
            <Field label={t('size')}><SizePicker value={d.size} onChange={(s) => set('size', s)} /></Field>
            <Field name="description" error={f.errors.description} label={t('what')}><input id="description" value={d.description} placeholder={t('whatPh')} maxLength={500} onChange={(e) => set('description', e.target.value)} /></Field>
            {me ? <PhotoUpload purpose="order" keys={d.photos} onChange={(k) => set('photos', k)} label={t('addPhotos')} /> : null}
          </Card>

          <Card>
            <div className="grid2">
              <Field name="value" error={f.errors.value} label={t('value')}><input id="value" inputMode="decimal" value={d.value} onChange={(e) => set('value', e.target.value)} /></Field>
              <label className="check align-end">
                <input id="insured" type="checkbox" checked={d.insured} onChange={(e) => set('insured', e.target.checked)} />
                <span>{t('insurance')}</span>
              </label>
            </div>
            <p className="small muted">
              {d.insured && rules ? t('insuranceNote', { rate: (rules.insuranceRate * 100).toFixed(1).replace(/\.0$/, ''), min: money(rules.insuranceMinCents) }) : t('noInsuranceNote')}
            </p>
          </Card>

          <Card>
            <span className="label">{t('loadingWindow')}</span>
            <div className="grid3">
              <Field name="date" error={f.errors.date} label={t('loadDate')}><input id="date" type="date" value={d.date} min={isoDay(0)} onChange={(e) => set('date', e.target.value)} /></Field>
              <Field name="from" error={f.errors.from} label={t('loadFrom')}><input id="from" type="time" value={d.from} onChange={(e) => set('from', e.target.value)} /></Field>
              <Field name="to" error={f.errors.to} label={t('loadTo')}><input id="to" type="time" value={d.to} onChange={(e) => set('to', e.target.value)} /></Field>
            </div>
            <TzNote pickup={d.pickup} start={windowStart} end={windowEnd} />
          </Card>

          <Card>
            <span className="label">{t('recipient')}</span>
            <div className="grid2">
              <Field label={t('recipientName')}><input id="recipient-name" value={d.recipientName} onChange={(e) => set('recipientName', e.target.value)} /></Field>
              <Field name="recipientPhone" error={f.errors.recipientPhone} label={t('recipientPhone')}><input id="recipient-phone" inputMode="tel" value={d.recipientPhone} onChange={(e) => set('recipientPhone', maskPhone(e.target.value))} /></Field>
            </div>
            <p className="small muted">{t('recipientNote')}</p>
          </Card>
        </div>

        <div className="stack sticky">
          {tripId && trip ? (
            <>
              <Notice tone="go">{t('withTrip', { driver: trip.driver.name ?? '' })}. {t('withTripNote', { min: 30 })}</Notice>
              <TripCard trip={trip} from={`${d.pickup?.city}`} to={`${d.dropoff?.city}`} />
            </>
          ) : null}
          <Card hl>
            {!trip ? (
              <Field name="price" error={f.errors.price} label={t('yourPrice')} hint={quote ? t('suggested', { price: money(quote.suggestedPriceCents), km: quote.distanceKm }) : undefined}>
                <input id="price" inputMode="decimal" value={d.price || (quote ? (quote.suggestedPriceCents / 100).toFixed(0) : '')} onChange={(e) => set('price', e.target.value)} />
              </Field>
            ) : null}
            <FeeBox
              rows={[
                [t('yourPrice').replace(/, \$$/, ''), priceCents],
                [t('serviceFee', { rate: Math.round((rules?.clientFeeRate ?? 0.05) * 100) }), feeCents, true],
                ...(insCents ? [[t('insuranceLine'), insCents, true] as [string, number, boolean]] : []),
              ]}
              total={[t('youPay'), priceCents + feeCents + insCents]}
            />
            <p className="small muted">{t('chargedWhen')}</p>
            {needCard && me && !me.card ? (
              <div className="stack">
                <h3>{t('needCard')}</h3>
                <CardForm onSaved={async () => {
                  await refreshMe();
                  setNeedCard(false);
                }} />
              </div>
            ) : (
              <>
                <ErrorSummary errors={f.errors} labels={labels} />
                <Button kind="primary" id="submit-order" onClick={submit}>
                  {trip ? t('submitTripOrder', { driver: trip.driver.name ?? '' }) : me ? t('submitOrder') : `${t('signIn')} · ${t('submitOrder')}`}
                </Button>
              </>
            )}
            <ErrorBox error={error} />
            {rules ? <p className="small muted">{t('cancelRules', { h: rules.cancelLateHours })}</p> : null}
          </Card>
        </div>
      </div>
    </div>
  );
}

const ZONES: Record<string, string> = {
  BC: 'America/Vancouver', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg', ON: 'America/Toronto', QC: 'America/Toronto',
  NB: 'America/Moncton', NS: 'America/Halifax', PE: 'America/Halifax', NL: 'America/St_Johns', YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit',
};

/** If the device is in another time zone than the pickup, show the window in pickup-local time too. */
function TzNote({ pickup, start, end }: { pickup: PlaceValue | null; start: string | null; end: string | null }) {
  const { t, lang } = useApp();
  if (!pickup || !start || !end) return null;
  const zone = ZONES[pickup.province];
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone) return null;
  const fmt = (tz: string, iso: string, withDay: boolean) => new Intl.DateTimeFormat(locale(lang), { ...(withDay ? { month: 'short', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  if (fmt(zone, start, true) === fmt(mine, start, true)) return null;
  return <p className="small notice">{t('tzNote', { tz: mine, city: pickup.city, local: `${fmt(zone, start, true)}–${fmt(zone, end, false)}` })}</p>;
}
