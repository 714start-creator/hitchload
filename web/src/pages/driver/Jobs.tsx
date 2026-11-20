// Driver's jobs list and one job: take / offer, then pickup with photos, delivery by PIN.
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Link, navigate, useApp, useLoad, useNow } from '../../lib/app';
import { Chat } from '../../lib/chat';
import { directionsUrl, dollarsToCents, money, windowText } from '../../lib/format';
import { Button, Card, Countdown, Empty, ErrorBox, Field, Loading, Notice, PageHead, PhotoUpload, RequireAuth, RouteLine, StatusPill, Steps } from '../../lib/ui';
import { RateBox, DisputeBox } from '../Orders';
import { DriverNav } from './Feed';

export function Jobs() {
  return <RequireAuth><JobsList /></RequireAuth>;
}

function JobsList() {
  const { t, lang } = useApp();
  const [scope, setScope] = useState<'active' | 'history'>('active');
  const { data, error, loading, reload } = useLoad(() => api.jobs(scope), [scope]);
  return (
    <div className="page">
      <PageHead title={t('myJobs')} />
      <DriverNav />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={scope === 'active'} onClick={() => setScope('active')}>{t('activeJobs')}</button>
        <button role="tab" aria-selected={scope === 'history'} onClick={() => setScope('history')}>{t('history')}</button>
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} onRetry={reload} />
      {data?.length === 0 ? <Empty>{t('noJobs')}</Empty> : null}
      <div className="list">
        {data?.map((o) => (
          <Link key={o.id} to={`/driver/jobs/${o.id}`} className="card link-card">
            <div className="row between"><span className="small muted">{t('orderN', { n: o.number })}</span><StatusPill status={o.status} /></div>
            <RouteLine from={o.pickup.city} to={o.dropoff.city} sub={windowText(o.windowStart, o.windowEnd, lang)} />
            <div className="row between small"><span className="muted">{t('youGet')}</span><b className="money">{money(o.driverNetCents ?? 0)}</b></div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function Job({ id }: { id: string }) {
  return <RequireAuth><JobPage id={id} /></RequireAuth>;
}

function JobPage({ id }: { id: string }) {
  const { t, lang, err, onLive, me } = useApp();
  const { data: o, error, reload } = useLoad(() => api.driverOrder(id), [id]);
  const [actErr, setActErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [offer, setOffer] = useState('');
  const [photos, setPhotos] = useState<{ key: string; url: string }[]>([]);
  const [pin, setPin] = useState('');
  const [drop, setDrop] = useState<string | null>(null);
  const now = useNow(o?.eligibility?.lockReason === 'pro_window');
  useEffect(() => onLive((e) => { if (e.type === 'order' && e.data?.orderId === id) void reload(); }), [onLive, reload, id]);

  const mine = o ? o.driverNetCents !== undefined && o.eligibility === null : false;
  const active = mine && (o?.status === 'agreed' || o?.status === 'picked_up' || o?.status === 'in_transit');

  // share position with the customer while the job is active and this page is open
  useEffect(() => {
    if (!active || !('geolocation' in navigator)) return;
    let last = 0;
    const w = navigator.geolocation.watchPosition((p) => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      void api.location(p.coords.latitude, p.coords.longitude).catch(() => undefined);
    }, () => undefined, { enableHighAccuracy: false, maximumAge: 60_000 });
    return () => navigator.geolocation.clearWatch(w);
  }, [active]);

  if (!o) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading />;

  const act = async (fn: () => Promise<unknown>) => {
    setActErr(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'wrong_pin') setActErr(t('wrongPin', { left: (e.details as { attemptsLeft?: number })?.attemptsLeft ?? 0 }));
      else setActErr(err(e));
    }
    await reload();
  };
  const e = o.eligibility;
  const myOffer = o.offers.find((f) => f.by === 'driver');
  const counter = o.offers.find((f) => f.by === 'client' && f.status === 'pending');
  const net = (c: number) => c - Math.round(c * 0.05);
  const target = o.status === 'agreed' ? o.pickup : o.dropoff;

  return (
    <div className="page">
      <PageHead title={t('orderN', { n: o.number })} back={mine ? '/driver/jobs' : '/driver'} />
      <div className="split">
        <div className="stack">
          <Card hl={active}>
            <div className="row between">
              <span className="small muted">{o.intercity ? t('intercity') : t('local')} · {o.distanceKm} km · {t(`size${o.size}`)}</span>
              <StatusPill status={o.status} />
            </div>
            <RouteLine from={`${o.pickup.address}, ${o.pickup.city}`} to={`${o.dropoff.address}, ${o.dropoff.city}`} sub={`${t('loadingWindow')}: ${windowText(o.windowStart, o.windowEnd, lang)}`} />
            {mine && o.status !== 'cancelled' ? <Steps status={o.status} /> : null}
            {o.description ? <p>{o.description}</p> : null}
            <p className="small muted">{t('value').replace(/, \$$/, '')}: {money(o.declaredValueCents)}{o.insured ? ` · ${t('insuranceLine')} ✓` : ''}{o.client?.name ? ` · ${o.client.name}${o.client.rating ? ` ★ ${o.client.rating.toFixed(1)}` : ''}` : ''}</p>
            {o.photos.length ? <div className="thumbs">{o.photos.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" className="thumb"><img src={u} alt="" /></a>)}</div> : null}
            {active ? <a className="btn small" href={directionsUrl(target.lat, target.lng)} target="_blank" rel="noreferrer">{t('navigate')} → {target.city}</a> : null}
            {mine && o.recipientName ? <p className="small">{t('contactRecipient')}: {o.recipientName}</p> : null}
          </Card>

          {e && o.status === 'open' ? (
            <Card hl={e.canTake}>
              {e.lockReason === 'pro_window' && e.opensAt ? <Notice>{t('lockedPro', { left: '' })} <Countdown to={e.opensAt} now={now} /></Notice> : null}
              {e.lockReason === 'cargo_limit' ? <Notice tone="bad">{t('lockedCargo')}</Notice> : null}
              {e.lockReason === 'client_payment' ? <Notice tone="bad">{t('lockedClientPayment')}</Notice> : null}
              {e.sizeWarning ? <Notice>{t('sizeWarn')}</Notice> : null}
              {e.canTake ? (
                <>
                  <div className="row between"><span className="muted">{t('youGet')}</span><b className="money big">{money(net(o.priceCents))}</b></div>
                  <p className="small muted">{t('driverFee', { rate: 5 })}</p>
                  <Button kind="primary" id="take" onClick={() => act(() => api.take(o.id))}>{t('takeFor', { price: money(o.priceCents) })}</Button>
                  {e.requestedToMe ? (
                    <Button kind="ghost" onClick={() => act(async () => { await api.declineRequest(o.id); navigate('/driver'); })}>{t('declineRequest')}</Button>
                  ) : counter ? (
                    <div className="card">
                      <p>{t('clientOffers', { price: money(counter.amountCents) })}</p>
                      <div className="row">
                        <Button small kind="primary" onClick={() => act(() => api.answerCounter(o.id, 'accept'))}>{t('accept')}</Button>
                        <Button small onClick={() => act(() => api.answerCounter(o.id, 'decline'))}>{t('decline')}</Button>
                      </div>
                    </div>
                  ) : myOffer ? (
                    <p className="small muted">{t('yourOffer', { price: money(myOffer.amountCents) })}</p>
                  ) : (
                    <form className="row" onSubmit={(ev) => { ev.preventDefault(); void act(async () => { await api.offer(o.id, dollarsToCents(offer) ?? 0); setMsg(t('offerSent')); }); }}>
                      <input aria-label={t('offerPrice')} placeholder={t('offerPrice')} inputMode="decimal" value={offer} onChange={(ev) => setOffer(ev.target.value)} style={{ maxWidth: 200 }} />
                      <Button small type="submit" disabled={!dollarsToCents(offer)}>{t('offer')}</Button>
                    </form>
                  )}
                </>
              ) : null}
            </Card>
          ) : null}

          {mine && o.status === 'agreed' ? (
            <Card>
              {!o.enRouteAt ? <Button id="en-route" onClick={() => act(() => api.enRoute(o.id))}>{t('enRoute')}</Button> : null}
              <p className="small muted">{t('pickupHint')}</p>
              <PhotoUpload id="pickup-photos" purpose="pickup" keys={photos} onChange={setPhotos} label={t('addPhotos')} />
              <Button kind="primary" id="picked-up" disabled={photos.length === 0} onClick={() => act(async () => { await api.pickup(o.id, photos.map((p) => p.key)); setPhotos([]); })}>{t('pickedUp')}</Button>
              {drop === null ? <Button kind="ghost" small onClick={() => setDrop('')}>{t('dropJob')}</Button> : (
                <div className="card">
                  <Notice>{t('dropWarn')}</Notice>
                  <Field label={t('dropReason')}><input value={drop} onChange={(ev) => setDrop(ev.target.value)} /></Field>
                  <div className="row">
                    <Button kind="danger" disabled={drop.trim().length < 3} onClick={() => act(async () => { await api.drop(o.id, drop); navigate('/driver'); })}>{t('dropJob')}</Button>
                    <Button kind="ghost" onClick={() => setDrop(null)}>{t('cancel')}</Button>
                  </div>
                </div>
              )}
            </Card>
          ) : null}

          {mine && o.status === 'picked_up' ? <Button kind="primary" id="depart" onClick={() => act(() => api.depart(o.id))}>{t('depart')}</Button> : null}

          {mine && (o.status === 'picked_up' || o.status === 'in_transit') ? (
            <Card>
              <Field label={t('enterPin')}><input id="pin" inputMode="numeric" maxLength={4} value={pin} onChange={(ev) => setPin(ev.target.value.replace(/\D/g, '').slice(0, 4))} className="pin-input" /></Field>
              <PhotoUpload id="delivery-photos" purpose="delivery" keys={photos} onChange={setPhotos} label={t('photosDelivery')} />
              <Button kind="primary" id="deliver" disabled={pin.length !== 4} onClick={() => act(async () => { await api.deliver(o.id, pin, photos.map((p) => p.key)); setPhotos([]); setPin(''); })}>{t('deliver')}</Button>
            </Card>
          ) : null}
        </div>

        <div className="stack sticky">
          {mine ? (
            <Card>
              <div className="row between"><span>{t('youGet')}</span><b className="money big">{money(o.driverNetCents ?? 0)}</b></div>
              {o.driverCompCents ? <div className="row between small"><span className="muted">{t('cancelOrder')}</span><span className="money">{money(o.driverCompCents)}</span></div> : null}
              {o.payoutHeldReason ? <Notice>{t('payoutHeld', { reason: o.payoutHeldReason })}</Notice> : null}
              {o.payoutHeldReason === 'tax_info_missing' || (o.payoutHeldReason && !me?.driver?.taxInfo) ? <Link to="/driver/tax" className="btn small">{t('taxTitle')}</Link> : null}
            </Card>
          ) : null}
          {mine && o.status !== 'cancelled' ? <Chat orderId={o.id} closed={o.status === 'delivered'} /> : null}
          {mine && o.status === 'delivered' ? <RateBox orderId={o.id} label={t('rateClient')} /> : null}
          {mine && o.status !== 'open' && o.status !== 'cancelled' ? <DisputeBox orderId={o.id} /> : null}
          {msg ? <Notice tone="go">{msg}</Notice> : null}
          {actErr ? <Notice tone="bad">{actErr}</Notice> : null}
        </div>
      </div>
    </div>
  );
}
