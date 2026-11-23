// Customer's orders: list, detail (offers, trips on the route, PIN, chat, cancel, rating, dispute) and the /o/:id resolver.
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Link, navigate, useApp, useLoad, useLocation, useNow } from '../lib/app';
import { CardForm } from '../lib/card';
import { Chat } from '../lib/chat';
import { dayTime, dollarsToCents, money, windowText } from '../lib/format';
import { RouteMap } from '../lib/map';
import type { CancelPreview, Order, TripOption } from '../lib/types';
import { Button, Card, Countdown, Empty, ErrorBox, FeeBox, Field, Loading, Notice, PageHead, RequireAuth, RouteLine, Stars, StatusPill, Steps, TripCard, DeliveryLine } from '../lib/ui';

export function Orders() {
  return <RequireAuth><OrdersList /></RequireAuth>;
}

function OrdersList() {
  const { t, lang, onLive } = useApp();
  const { data, error, loading, reload } = useLoad(() => api.orders(), []);
  useEffect(() => onLive((e) => { if (e.type === 'order') void reload(); }), [onLive, reload]);
  return (
    <div className="page">
      <div className="row between">
        <PageHead title={t('myOrders')} />
        <Link to="/send/new" className="btn primary">{t('postOrder')}</Link>
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} onRetry={reload} />
      {data && data.length === 0 ? <Empty>{t('noOrders')}</Empty> : null}
      <div className="list">
        {data?.map((o) => (
          <Link key={o.id} to={`/orders/${o.id}`} className="card link-card">
            <div className="row between">
              <span className="small muted">{t('orderN', { n: o.number })} · {o.intercity ? t('intercity') : t('local')} · {o.distanceKm} km</span>
              <StatusPill status={o.status} />
            </div>
            <RouteLine from={o.pickup.city} to={o.dropoff.city} sub={windowText(o.windowStart, o.windowEnd, lang)} />
            {o.paymentError && o.status === 'open' ? <p className="small err">{t('payFailShort')}</p> : null}
            <div className="row between small">
              <span className="muted">{o.description || t(`size${o.size}`)}</span>
              <b className="money">{money(o.chargedCents ?? o.agreedCents ?? o.priceCents)}</b>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function OrderPage({ id }: { id: string }) {
  return <RequireAuth><OrderDetail id={id} /></RequireAuth>;
}

function OrderDetail({ id }: { id: string }) {
  const { t, lang, onLive, err } = useApp();
  const { query } = useLocation();
  const { data: o, error, reload } = useLoad(() => api.order(id), [id]);
  const [actErr, setActErr] = useState<string | null>(null);
  const [cardFixed, setCardFixed] = useState(false);
  const now = useNow(o?.status === 'open');
  useEffect(() => onLive((e) => {
    if ((e.type === 'order' || e.type === 'driver_position') && e.data?.orderId === id) void reload();
  }), [onLive, reload, id]);

  if (!o) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const act = async (fn: () => Promise<unknown>) => {
    setActErr(null);
    try {
      await fn();
    } catch (e) {
      setActErr(err(e));
    }
    await reload();
  };
  const driverOffers = o.offers.filter((f) => f.by === 'driver' && f.status === 'pending');
  const counterUsed = o.offers.some((f) => f.by === 'client');
  const assigned = o.status === 'agreed' || o.status === 'picked_up' || o.status === 'in_transit';
  const requestActive = o.requestedDriver && o.requestExpiresAt && new Date(o.requestExpiresAt).getTime() > now;

  return (
    <div className="page">
      <PageHead title={t('orderN', { n: o.number })} back="/orders" />
      <div className="split">
        <div className="stack">
          <Card hl={assigned}>
            <div className="row between">
              <span className="small muted">{o.intercity ? t('intercity') : t('local')} · {o.distanceKm} km · {t(`size${o.size}`)}</span>
              <StatusPill status={o.status} />
            </div>
            <RouteLine from={`${o.pickup.address}, ${o.pickup.city}`} to={`${o.dropoff.address}, ${o.dropoff.city}`} sub={`${t('loadingWindow')}: ${windowText(o.windowStart, o.windowEnd, lang)}`} />
            <DeliveryLine o={o} />
            {o.status !== 'cancelled' ? <Steps status={o.status} /> : null}
            {o.description ? <p>{o.description}</p> : null}
            {o.photos.length ? <div className="thumbs">{o.photos.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="thumb"><img src={u} alt="" /></a>)}</div> : null}
            <p className="small muted">{t('value').replace(/, \$$/, '')}: {money(o.declaredValueCents)}{o.insured ? ` · ${t('insuranceLine')} ✓` : ''}</p>
          </Card>
          {o.paymentError && o.status === 'open' ? <PaymentProblem code={o.paymentError} onFixed={async () => { setCardFixed(true); await reload(); }} /> : null}
          {cardFixed && !o.paymentError ? <Notice tone="go">{t('payFixed')}</Notice> : null}

          {o.status === 'open' ? (
            <Card>
              {requestActive ? <p>{t('requestSent', { left: '' })} <Countdown to={o.requestExpiresAt!} now={now} /></p>
                : new Date(o.proUntil).getTime() > now ? <p className="small muted">{t('proWindow', { left: '' })} <Countdown to={o.proUntil} now={now} /></p>
                : <p className="muted">{t('waitingDriver')}</p>}
              {driverOffers.map((f) => <OfferBox key={f.id} order={o} offerId={f.id} amount={f.amountCents} counterUsed={counterUsed} act={act} />)}
              {o.offers.some((f) => f.by === 'client' && f.status === 'pending') ? <p className="small muted">{t('yourCounter', { price: money(o.offers.find((f) => f.by === 'client' && f.status === 'pending')!.amountCents) })}</p> : null}
              <div className="row between"><span className="muted">{t('yourPrice').replace(/, \$$/, '')}</span><b className="money">{money(o.priceCents)}</b></div>
              <Button kind="ghost" small onClick={() => act(() => api.cancel(o.id))}>{t('cancelFree')}</Button>
            </Card>
          ) : null}

          {o.status === 'open' && o.intercity && !requestActive ? <TripsForOrder order={o} highlight={query.get('trip')} act={act} /> : null}

          {o.driver && assigned ? (
            <Card hl>
              <span className="label">{t('driver')}</span>
              <p><b>{o.driver.name}</b> · {o.driver.rating ? `★ ${o.driver.rating.toFixed(1)}` : t('newDriver')} · {o.driver.vehicle ?? ''} · {t('jobs', { n: o.driver.completedJobs })}</p>
              {o.driverPosition ? (
                <>
                  <RouteMap routes={[]} points={[{ ...o.pickup, label: o.pickup.city, kind: 'from' }, { ...o.dropoff, label: o.dropoff.city, kind: 'to' }, { ...o.driverPosition, label: t('driver'), kind: 'driver' }]} height={220} />
                  <p className="small muted">{t('driverPosition', { time: dayTime(o.driverPosition.at, lang) })}</p>
                </>
              ) : null}
            </Card>
          ) : null}

          {o.pin && assigned ? (
            <Card>
              <span className="label">{t('pinTitle')}</span>
              <div className="pin" id="order-pin">{o.pin}</div>
              <p className="small muted">{t('pinText')}</p>
            </Card>
          ) : null}

          {o.pickupPhotos.length ? (
            <Card>
              <span className="label">{t('photosPickup')}</span>
              <div className="thumbs">{o.pickupPhotos.map((p) => <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="thumb"><img src={p.url} alt={p.stage} /></a>)}</div>
            </Card>
          ) : null}
        </div>

        <div className="stack sticky">
          {o.chargedCents ? (
            <Card>
              <FeeBox rows={[[t('yourPrice').replace(/, \$$/, ''), o.agreedCents ?? 0], [t('serviceFee', { rate: 5 }), o.clientFeeCents ?? 0, true], ...(o.insuranceCents ? [[t('insuranceLine'), o.insuranceCents, true] as [string, number, boolean]] : [])]} total={[t('charged'), o.chargedCents]} />
              {o.refundCents ? <div className="row between small"><span className="muted">{t('refunded')}</span><span className="money">{money(o.refundCents)}</span></div> : null}
            </Card>
          ) : null}
          {o.status === 'agreed' ? <CancelBox order={o} act={act} /> : null}
          {o.driver && o.status !== 'open' && o.status !== 'cancelled' ? <Chat orderId={o.id} closed={o.status === 'delivered'} /> : null}
          {o.status === 'delivered' ? <RateBox orderId={o.id} label={t('rateDriver')} /> : null}
          {o.status !== 'open' && o.status !== 'cancelled' ? <DisputeBox orderId={o.id} /> : null}
          {actErr ? <Notice tone="bad">{actErr}</Notice> : null}
        </div>
      </div>
    </div>
  );
}

function OfferBox({ order, offerId, amount, counterUsed, act }: { order: Order; offerId: string; amount: number; counterUsed: boolean; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useApp();
  const [counter, setCounter] = useState('');
  return (
    <div className="card hl offer">
      <div className="row between"><span>{t('offerFrom', { driver: t('driver') })}</span><b className="money big">{money(amount)}</b></div>
      <div className="row">
        <Button kind="primary" small onClick={() => act(() => api.respondOffer(order.id, offerId, 'accept'))}>{t('accept')}</Button>
        <Button small onClick={() => act(() => api.respondOffer(order.id, offerId, 'decline'))}>{t('decline')}</Button>
      </div>
      {counterUsed ? <p className="small muted">{t('counterUsed')}</p> : (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void act(() => api.respondOffer(order.id, offerId, 'counter', dollarsToCents(counter) ?? 0)); }}>
          <input aria-label={t('counter')} inputMode="decimal" placeholder="$" value={counter} onChange={(e) => setCounter(e.target.value)} style={{ width: 110 }} />
          <Button small type="submit" disabled={!dollarsToCents(counter)}>{t('sendCounter')}</Button>
        </form>
      )}
    </div>
  );
}

function TripsForOrder({ order, highlight, act }: { order: Order; highlight: string | null; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useApp();
  const [trips, setTrips] = useState<TripOption[] | null>(null);
  useEffect(() => {
    api.quote({ pickup: order.pickup, dropoff: order.dropoff, size: order.size, declaredValueCents: order.declaredValueCents, insured: order.insured, windowStart: order.windowStart, windowEnd: order.windowEnd })
      .then((q) => setTrips(q.trips)).catch(() => setTrips([]));
  }, [order.id, order.pickup, order.dropoff, order.size, order.declaredValueCents, order.insured, order.windowStart, order.windowEnd]);
  if (!trips || trips.length === 0) return null;
  const sorted = [...trips].sort((a, b) => Number(b.tripId === highlight) - Number(a.tripId === highlight));
  return (
    <div className="stack" id="trips-for-order">
      <h2 className="h3">{t('driverOnRoute')}</h2>
      {sorted.map((tr) => (
        <TripCard key={tr.tripId} trip={tr} from={order.pickup.city} to={order.dropoff.city} highlight={tr.tripId === highlight}
          action={<Button kind="primary" small onClick={() => act(() => api.requestTrip(order.id, tr.tripId))}>{t('askDriver')}</Button>} />
      ))}
    </div>
  );
}

function CancelBox({ order, act }: { order: Order; act: (f: () => Promise<unknown>) => Promise<void> }) {
  const { t } = useApp();
  const [p, setP] = useState<CancelPreview | null>(null);
  if (!p) return <Button kind="ghost" onClick={async () => setP(await api.cancelPreview(order.id))}>{t('cancelOrder')}</Button>;
  return (
    <Card>
      <h3>{t('cancelPreview')}</h3>
      <FeeBox rows={[[t('keepDriver'), p.driverCents], [t('keepPlatform'), p.platformCents], [t('keptFee'), p.keptFeeCents, true]]} total={[t('refundToCard'), p.refundCents]} />
      <div className="row">
        <Button kind="danger" onClick={() => act(async () => { await api.cancel(order.id); setP(null); })}>{t('confirmCancel')}</Button>
        <Button kind="ghost" onClick={() => setP(null)}>{t('keepOrder')}</Button>
      </div>
    </Card>
  );
}

/** The client's card was declined when a driver confirmed: say why, what it means and fix it right here. */
function PaymentProblem({ code, onFixed }: { code: string; onFixed: () => unknown }) {
  const { t, me, refreshMe } = useApp();
  const [open, setOpen] = useState(false);
  const known = ['insufficient_funds', 'expired_card', 'incorrect_cvc', 'authentication_required', 'lost_card', 'stolen_card', 'pickup_card', 'do_not_honor', 'generic_decline', 'card_declined', 'processing_error', 'card_velocity_exceeded', 'card_missing'];
  const reason = t(`payReason_${known.includes(code) ? code : 'other'}` as 'payReason_other');
  return (
    <div className="card pay-problem" role="alert" id="payment-problem">
      <h3>{t('payFailTitle')}</h3>
      <p><b>{t('payReasonLabel')}</b> {reason}</p>
      <p>{t('payFailText')}</p>
      <ul className="small">
        <li>{t('payFix1')}</li>
        <li>{t('payFix2')}</li>
        <li>{t('payFix3')}</li>
      </ul>
      {me?.card ? <p className="small muted">{t('payCardOnFile', { card: `${me.card.brand.toUpperCase()} •••• ${me.card.last4}` })}</p> : null}
      {open ? (
        <CardForm onSaved={async () => { await refreshMe(); setOpen(false); await onFixed(); }} />
      ) : <Button kind="primary" id="replace-card" onClick={() => setOpen(true)}>{t('replaceCard')}</Button>}
    </div>
  );
}

export function RateBox({ orderId, label }: { orderId: string; label: string }) {
  const { t, err } = useApp();
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done) return <Notice tone="go">{t('rated')}</Notice>;
  return (
    <Card>
      <span className="label">{label}</span>
      <Stars value={stars} onChange={setStars} />
      <Field label={t('comment')}><input value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} /></Field>
      <Button kind="primary" disabled={!stars} onClick={async () => {
        try {
          await api.rate(orderId, stars, comment || undefined);
          setDone(true);
        } catch (e) {
          if ((e as ApiError).code === 'already_rated') setDone(true);
          else setError(err(e));
        }
      }}>{t('sendRating')}</Button>
      {error ? <p className="small err">{error}</p> : null}
    </Card>
  );
}

export function DisputeBox({ orderId }: { orderId: string }) {
  const { t, err } = useApp();
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sent) return <Notice tone="go">{t('problemSent')}</Notice>;
  return (
    <details className="card">
      <summary>{t('problem')}</summary>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={t('problemPh')} maxLength={1000} />
      <Button disabled={text.trim().length < 5} onClick={async () => {
        try {
          await api.dispute(orderId, text);
          setSent(true);
        } catch (e) {
          setError(err(e));
        }
      }}>{t('send')}</Button>
      {error ? <p className="small err">{error}</p> : null}
    </details>
  );
}

/** Links in notifications and emails point here; open the customer or the driver view. */
export function OrderLink({ id }: { id: string }) {
  const { query } = useLocation();
  return (
    <RequireAuth>
      <Resolve id={id} trip={query.get('trip')} />
    </RequireAuth>
  );
}

function Resolve({ id, trip }: { id: string; trip: string | null }) {
  const [failed, setFailed] = useState<unknown>(null);
  useEffect(() => {
    api.order(id)
      .then(() => navigate(`/orders/${id}${trip ? `?trip=${trip}#trips-for-order` : ''}`, true))
      .catch(() => api.driverOrder(id).then(() => navigate(`/driver/jobs/${id}`, true)).catch(setFailed));
  }, [id, trip]);
  return failed ? <ErrorBox error={failed} /> : <Loading />;
}
