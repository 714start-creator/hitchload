// Public board of open loads (cities only). Drivers sign in to take them.
import { useState } from 'react';
import { api } from '../lib/api';
import { Link, useApp, useLoad } from '../lib/app';
import { windowText } from '../lib/format';
import { Empty, ErrorBox, Field, Loading, PageHead, Pill, RouteLine } from '../lib/ui';
import { money } from '../lib/format';

export function Loads() {
  const { t, lang, me } = useApp();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, error, loading, reload } = useLoad(() => api.publicLoads({ from: from || undefined, to: to || undefined }), [from, to]);
  const approved = me?.driver?.status === 'approved';
  const cta = approved ? { to: '/driver', label: t('driverHome') } : me ? { to: me.driver ? '/driver/setup' : '/drive', label: t('becomeDriverToTake') } : { to: '/sign-in?next=/driver', label: t('takeThisLoad') };
  return (
    <div className="page">
      <PageHead title={t('loadsTitle')} text={t('loadsText')} />
      <div className="grid2 filters">
        <Field label={t('loadsFilterFrom')}><input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Edmonton" /></Field>
        <Field label={t('loadsFilterTo')}><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Calgary" /></Field>
      </div>
      {loading && !data ? <Loading /> : null}
      <ErrorBox error={error} onRetry={reload} />
      {data && data.length === 0 ? (
        <Empty>
          {t('loadsEmpty')} <Link to={approved ? '/driver/trips' : '/drive'}>{t('postRoute')}</Link>
        </Empty>
      ) : null}
      <div className="grid-cards">
        {data?.map((l) => (
          <div key={l.number} className="card">
            <div className="row between">
              <Pill tone={l.intercity ? 'go' : undefined}>{l.intercity ? `${t('intercity')} · ${l.distanceKm} km` : t('local')}</Pill>
              <span className="small muted">{t(`size${l.size}`)}</span>
            </div>
            <RouteLine from={`${l.from.city}, ${l.from.province}`} to={`${l.to.city}, ${l.to.province}`} sub={t('loadWindow', { when: windowText(l.windowStart, l.windowEnd, lang) })} />
            <div className="row between">
              <b className="money big">{money(l.priceCents)}</b>
              <Link to={cta.to} className="btn small primary">{cta.label}</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
