// Driver home: status, quick links, active jobs and loads available to this driver.
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Link, useApp, useLoad, useNow } from '../../lib/app';
import { money, windowText } from '../../lib/format';
import type { Order } from '../../lib/types';
import { Countdown, Empty, ErrorBox, Loading, Notice, PageHead, Pill, RequireAuth, RouteLine, StatusPill, DeliveryLine } from '../../lib/ui';

export function DriverHome() {
  return <RequireAuth><Home /></RequireAuth>;
}

function Home() {
  const { t, me } = useApp();
  if (!me?.driver || me.driver.status !== 'approved') {
    return (
      <div className="page narrow-page">
        <PageHead title={t('driverSetupTitle')} text={me?.driver ? t(`ds_${me.driver.status}`) : t('driverSetupText')} />
        <Link to="/driver/setup" className="btn primary">{me?.driver ? t('continue') : t('startDriver')}</Link>
      </div>
    );
  }
  return <Feed />;
}

function DriverNav() {
  const { t } = useApp();
  return (
    <nav className="subnav">
      <Link to="/driver">{t('driverHome')}</Link>
      <Link to="/driver/trips">{t('myTrips')}</Link>
      <Link to="/driver/jobs">{t('myJobs')}</Link>
      <Link to="/driver/earnings">{t('earnings')}</Link>
      <Link to="/driver/setup">{t('driverProfile')}</Link>
    </nav>
  );
}
export { DriverNav };

function Feed() {
  const { t, onLive } = useApp();
  const feed = useLoad(() => api.feed(), []);
  const jobs = useLoad(() => api.jobs('active'), []);
  useEffect(() => onLive((e) => {
    if (e.type === 'order' || (e.type === 'notification' && String(e.data?.type).startsWith('new_order'))) {
      void feed.reload();
      void jobs.reload();
    }
  }), [onLive, feed.reload, jobs.reload]);
  return (
    <div className="page">
      <PageHead title={t('driverHome')} />
      <DriverNav />
      {jobs.data && jobs.data.length ? (
        <section className="stack">
          <h2 className="h3">{t('activeJobs')}</h2>
          {jobs.data.map((o) => (
            <Link key={o.id} to={`/driver/jobs/${o.id}`} className="card hl link-card">
              <div className="row between"><span className="small muted">{t('orderN', { n: o.number })}</span><StatusPill status={o.status} /></div>
              <RouteLine from={o.pickup.city} to={o.dropoff.city} />
            </Link>
          ))}
        </section>
      ) : null}
      <div className="row between">
        <h2 className="h3">{t('driverHome')}</h2>
        <Link to="/driver/trips" className="btn small">{t('newTrip')}</Link>
      </div>
      {feed.loading && !feed.data ? <Loading /> : null}
      <ErrorBox error={feed.error} onRetry={feed.reload} />
      {feed.data ? <FeedTabs items={feed.data.items} /> : null}
    </div>
  );
}

function FeedTabs({ items }: { items: Order[] }) {
  const { t } = useApp();
  const onWay = items.filter((o) => o.eligibility?.onMyTrip || o.eligibility?.requestedToMe);
  const rest = items.filter((o) => !(o.eligibility?.onMyTrip || o.eligibility?.requestedToMe));
  const [tab, setTab] = useState<'way' | 'all'>(onWay.length ? 'way' : 'all');
  const list = tab === 'way' ? onWay : rest;
  return (
    <>
      <div className="tabs" role="tablist">
        <button role="tab" id="tab-way" aria-selected={tab === 'way'} onClick={() => setTab('way')}>{t('loadsOnWay')} ({onWay.length})</button>
        <button role="tab" id="tab-all" aria-selected={tab === 'all'} onClick={() => setTab('all')}>{t('allLoads')} ({rest.length})</button>
      </div>
      {list.length === 0 ? <Empty>{tab === 'way' ? <>{t('onWayEmpty')} <Link to="/driver/trips">{t('newTrip')}</Link></> : t('feedEmpty')}</Empty> : null}
      <div className="grid-cards">
        {list.map((o) => <LoadCard key={o.id} o={o} />)}
      </div>
    </>
  );
}

export function LoadCard({ o, eta, fitsWindow }: { o: Order; eta?: string; fitsWindow?: boolean }) {
  const { t, lang } = useApp();
  const now = useNow(o.eligibility?.lockReason === 'pro_window');
  const e = o.eligibility;
  const net = Math.round(o.priceCents * 0.95);
  return (
    <Link to={`/driver/jobs/${o.id}`} className={`card link-card ${e?.requestedToMe || e?.onMyTrip ? 'hl' : ''}`}>
      <div className="row between">
        <span className="row">
          {e?.requestedToMe ? <Pill tone="wait">{t('requestedToYou')}</Pill> : e?.onMyTrip ? <Pill tone="go">{t('onMyTrip')}</Pill> : e?.near ? <Pill>{t('nearYou')}</Pill> : null}
          <span className="small muted">{o.intercity ? `${t('intercity')} · ${o.distanceKm} km` : t('local')} · {t(`size${o.size}`)}</span>
        </span>
        {e?.distanceToPickupKm !== null && e?.distanceToPickupKm !== undefined ? <span className="small muted">{t('kmAway', { km: e.distanceToPickupKm })}</span> : null}
      </div>
      <RouteLine from={`${o.pickup.address}, ${o.pickup.city}`} to={`${o.dropoff.address}, ${o.dropoff.city}`} sub={`${t('loadingWindow')}: ${windowText(o.windowStart, o.windowEnd, lang)}`} />
      <DeliveryLine o={o} />
      {o.description ? <p className="small">{o.description}</p> : null}
      {eta ? <p className="small">{t('eta', { time: windowText(eta, eta, lang).split('–')[0]! })} {fitsWindow === false ? <span className="muted">· {t('outsideWindow')}</span> : null}</p> : null}
      <div className="row between">
        <span className="small muted">{t('youGet')} <b className="money">{money(net)}</b></span>
        <b className="money big">{money(o.priceCents)}</b>
      </div>
      {e?.lockReason === 'pro_window' && e.opensAt ? <Notice>{t('lockedPro', { left: '' })} <Countdown to={e.opensAt} now={now} /></Notice> : null}
      {e?.lockReason === 'cargo_limit' ? <Notice tone="bad">{t('lockedCargo')}</Notice> : null}
      {e?.lockReason === 'client_payment' ? <Notice tone="bad">{t('lockedClientPayment')}</Notice> : null}
      {e?.sizeWarning ? <Notice>{t('sizeWarn')}</Notice> : null}
    </Link>
  );
}
