// The order form: addresses, size, photos, value and insurance, loading window, price.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { navigate, useApp, useLocation } from '../lib/app';
import { CardForm } from '../lib/card';
import { ErrorSummary, isPhone, useFormErrors, type Errors } from '../lib/form';
import { dollarsToCents, locale, maskPhone, money, type PlaceValue } from '../lib/format';
import type { Quote, Size } from '../lib/types';
import { Button, Card, DateTimeInput, ErrorBox, FeeBox, Field, Notice, PageHead, PhotoUpload, PlaceInput, SizePicker, TripCard, isoDay, localToIso } from '../lib/ui';

interface Draft {
  pickup: PlaceValue | null;
  dropoff: PlaceValue | null;
  size: Size;
  description: string;
  photos: { key: string; url: string }[];
  value: string;
  insured: boolean;
  /** loading window, "YYYY-MM-DDTHH:MM" local */
  loadFrom: string;
  loadTo: string;
  /** optional delivery window */
  deliverFrom: string;
  deliverBy: string;
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

/** Old drafts kept date + from + to. */
type OldDraft = Partial<Draft> & { date?: string; from?: string; to?: string };

export function NewOrder() {
  const { t, me, refreshMe } = useApp();
  const { query } = useLocation();
  const tripId = query.get('trip');
  const saved = useMemo(loadDraft, []) as OldDraft | null;
  const day = query.get('date') || saved?.date || isoDay(0);
  const [d, setD] = useState<Draft>(() => ({
    pickup: saved?.pickup ?? null,
    dropoff: saved?.dropoff ?? null,
    size: (query.get('size') as Size) || saved?.size || 'M',
    description: saved?.description ?? '',
    photos: saved?.photos ?? [],
    value: saved?.value ?? '200',
    insured: saved?.insured ?? false,
    loadFrom: (!query.get('date') && saved?.loadFrom) || `${day}T${saved?.from ?? '10:00'}`,
    loadTo: (!query.get('date') && saved?.loadTo) || `${day}T${saved?.to ?? '18:00'}`,
    deliverFrom: saved?.deliverFrom ?? '',
    deliverBy: saved?.deliverBy ?? '',
    recipientName: saved?.recipientName ?? '',
    recipientPhone: saved?.recipientPhone ?? '',
    price: saved?.price ?? '',
  }));
  const f = useFormErrors();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((x) => ({ ...x, [k]: v }));
    f.clear(k);
    if (k === 'loadFrom' || k === 'loadTo' || k === 'deliverFrom' || k === 'deliverBy') for (const x of ['loadFrom', 'loadTo', 'deliverFrom', 'deliverBy']) f.clear(x);
  };
  useEffect(() => saveDraft(d), [d]);

  const [rules, setRules] = useState<{ cancelLateHours: number; insuranceRate: number; insuranceMinCents: number; clientFeeRate: number } | null>(null);
  useEffect(() => void api.config().then((c) => setRules(c.rules)).catch(() => undefined), []);

  const windowStart = localToIso(d.loadFrom);
  const windowEnd = localToIso(d.loadTo);
  const deliveryStart = localToIso(d.deliverFrom);
  const deliveryEnd = localToIso(d.deliverBy);
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
      api.quote({ pickup: d.pickup!, dropoff: d.dropoff!, size: d.size, declaredValueCents: valueCents, insured: d.insured, windowStart: windowStart ?? undefined, windowEnd: windowEnd ?? undefined, deliveryEnd: deliveryEnd ?? undefined })
        .then(setQuote).catch(() => setQuote(null));
    }, 300);
  }, [d.pickup, d.dropoff, d.size, valueCents, d.insured, windowStart, windowEnd, deliveryEnd]);

  const trip = tripId ? quote?.trips.find((x) => x.tripId === tripId) ?? null : null;
  const priceCents = trip ? trip.priceCents : dollarsToCents(d.price) ?? quote?.suggestedPriceCents ?? 0;
  const feeCents = Math.round(priceCents * (rules?.clientFeeRate ?? 0.05));
  const insCents = d.insured && quote ? quote.insuranceCents : 0;
  const [error, setError] = useState<unknown>(null);
  const [needCard, setNeedCard] = useState(false);

  const fromCity = query.get('from') ?? '';
  const toCity = query.get('to') ?? '';
  const labels: Record<string, string> = {
    pickup: t('pickup'), dropoff: t('dropoff'), description: t('what'), value: t('value'), loadFrom: t('loadStart'), loadTo: t('loadEnd'), deliverFrom: t('deliverFrom'), deliverBy: t('deliverBy'),
    recipientPhone: t('recipientPhone'), price: t('yourPrice').replace(/, \$$/, ''),
  };

  function validate(): Errors {
    const v = dollarsToCents(d.value);
    const e: Errors = {
      pickup: !d.pickup ? t('errPlace') : '',
      dropoff: !d.dropoff ? t('errPlace') : '',
      description: d.description.trim().length < 3 ? t('errWhat') : '',
      value: v === null || v === undefined || v < 0 ? t('errValue') : '',
      loadFrom: !windowStart ? t('errRequired') : '',
      loadTo: !windowEnd ? t('errRequired') : '',
      deliverFrom: '',
      deliverBy: d.deliverFrom && !deliveryEnd ? t('errDeliverByNeeded') : '',
      recipientPhone: d.recipientPhone && !isPhone(d.recipientPhone) ? t('errPhone') : '',
      price: !trip && priceCents < 500 ? t('errPrice') : '',
    };
    if (windowStart && windowEnd) {
      const s = new Date(windowStart).getTime();
      const en = new Date(windowEnd).getTime();
      if (en <= s) e.loadTo = t('errWindowOrder');
      else if (en < Date.now() + 15 * 60_000) e.loadTo = t('errWindowPast');
      else if (s > Date.now() + 30 * 86_400_000 || en > Date.now() + 31 * 86_400_000) e.loadTo = t('errTooFar');
      if (deliveryEnd && new Date(deliveryEnd).getTime() <= s) e.deliverBy = t('errDeliverByEarly');
      if (deliveryStart && deliveryEnd && deliveryStart >= deliveryEnd) e.deliverFrom = t('errDeliverOrder');
      else if (deliveryStart && new Date(deliveryStart).getTime() < s) e.deliverFrom = t('errDeliverBeforeLoad');
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
        ...(deliveryEnd ? { deliveryEnd, ...(deliveryStart ? { deliveryStart } : {}) } : {}),
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
      const code = (e as { code?: string }).code;
      if (f.fromServer(e, { bad_window: 'loadTo', bad_delivery: 'deliverBy', invalid_phone: 'recipientPhone', price_out_of_range: 'price' }, {
        pickup: 'pickup', dropoff: 'dropoff', description: 'description', declaredValueCents: 'value', windowStart: 'loadFrom', windowEnd: 'loadTo', deliveryStart: 'deliverFrom', deliveryEnd: 'deliverBy', recipientPhone: 'recipientPhone', priceCents: 'price',
      }, code === 'bad_window' ? t('errWindowServer') : undefined)) return;
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
              {d.insured && rules ? t('insuranceNote', {
                rate: (rules.insuranceRate * 100).toFixed(1).replace(/\.0$/, ''), min: money(rules.insuranceMinCents),
                value: money(valueCents), amount: money(Math.max(rules.insuranceMinCents, Math.round(valueCents * rules.insuranceRate))),
              }) : t('noInsuranceNote')}
            </p>
          </Card>

          <Card>
            <span className="label">{t('loadingWindow')}</span>
            <div className="stack dt-stack">
              <DateTimeInput idPrefix="load-from" name="loadFrom" error={f.errors.loadFrom} label={t('loadStart')} value={d.loadFrom} min={isoDay(0)}
                onChange={(v) => { set('loadFrom', v); if (v && localToIso(v)! >= (localToIso(d.loadTo) ?? '')) set('loadTo', `${v.slice(0, 10)}T${String(Math.min(23, Number(v.slice(11, 13)) + 8)).padStart(2, '0')}:${v.slice(14)}`); }} />
              <DateTimeInput idPrefix="load-to" name="loadTo" error={f.errors.loadTo} label={t('loadEnd')} value={d.loadTo} min={d.loadFrom.slice(0, 10) || isoDay(0)} onChange={(v) => set('loadTo', v)} />
            </div>
            <p className="small muted">{t('loadWindowHint')}</p>
            <TzNote pickup={d.pickup} start={windowStart} end={windowEnd} />
          </Card>

          <Card>
            <span className="label">{t('deliveryWindow')}</span>
            <div className="stack dt-stack">
              <DateTimeInput idPrefix="deliver-from" name="deliverFrom" error={f.errors.deliverFrom} label={t('deliverFrom')} value={d.deliverFrom} min={d.loadFrom.slice(0, 10) || isoDay(0)} optional onChange={(v) => set('deliverFrom', v)} />
              <DateTimeInput idPrefix="deliver-by" name="deliverBy" error={f.errors.deliverBy} label={t('deliverBy')} value={d.deliverBy} min={d.loadFrom.slice(0, 10) || isoDay(0)} optional onChange={(v) => set('deliverBy', v)} />
            </div>
            <p className="small muted">{t('deliveryHint')}</p>
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
