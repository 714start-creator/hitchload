import { useState } from 'react';
import { api } from '../lib/api';
import { Link, navigate, useApp, useLoad, useLocation } from '../lib/app';
import { RouteMap } from '../lib/map';
import type { Size } from '../lib/types';
import { Button, Card, Empty, ErrorBox, Field, Loading, Notice, PageHead, SizePicker, TripCard, isoDay } from '../lib/ui';
import { RouteSearch } from './Home';

const parseCity = (s: string) => {
  const m = /^(.+),\s*([A-Za-z]{2})$/.exec(s);
  return m ? { city: m[1]!.trim(), province: m[2]!.toUpperCase() } : null;
};

export function Send() {
  const { t } = useApp();
  const { query } = useLocation();
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';
  const date = query.get('date') ?? '';
  const [size, setSize] = useState<Size>((query.get('size') as Size) || 'S');
  const ready = Boolean(parseCity(from) && parseCity(to));
  return (
    <div className="page">
      <PageHead title={t('sendTitle')} text={t('sendText')} />
      <RouteSearch key={`${from}|${to}|${date}`} initialFrom={from} initialTo={to} initialDate={date} compact />
      {ready ? <Results from={from} to={to} date={date} size={size} setSize={setSize} highlight={query.get('trip')} /> : (
        <div className="row">
          <Link to="/send/new" className="btn">{t('postOrder')}</Link>
        </div>
      )}
    </div>
  );
}

function Results({ from, to, date, size, setSize, highlight }: { from: string; to: string; date: string; size: Size; setSize: (s: Size) => void; highlight: string | null }) {
  const { t } = useApp();
  const { data, error, loading, reload } = useLoad(() => api.searchTrips({ from, to, size, date: date || undefined }), [from, to, size, date]);
  const newOrder = (trip?: string) => `/send/new?${new URLSearchParams({ from, to, size, ...(trip ? { trip } : {}), ...(date ? { date } : {}) })}`;
  return (
    <div className="split">
      <div className="stack">
        <Field label={t('size')}><SizePicker value={size} onChange={setSize} /></Field>
        {loading && !data ? <Loading /> : null}
        <ErrorBox error={error} onRetry={reload} />
        {data ? (
          <>
            <h2 className="h3">{data.trips.length === 1 ? t('tripsFound1') : data.trips.length ? t('tripsFound', { n: data.trips.length }) : t('noTripsRoute')}</h2>
            {data.trips.length === 0 ? <Empty>{t('noTripsHint')}</Empty> : null}
            {data.trips.map((tr) => (
              <TripCard key={tr.tripId} trip={tr} from={from} to={to} highlight={tr.tripId === highlight}
                action={<Button kind="primary" small onClick={() => navigate(newOrder(tr.tripId))}>{t('sendWithDriver')}</Button>} />
            ))}
            <div className="row">
              <Link to={newOrder()} className="btn primary">{t('postOrder')}</Link>
            </div>
          </>
        ) : null}
      </div>
      <div className="stack sticky">
        {data ? (
          <Card>
            <RouteMap
              routes={data.trips.map((tr) => ({ id: tr.tripId, stops: tr.stops, highlight: true }))}
              points={[{ ...data.from, label: data.from.city, kind: 'from' }, { ...data.to, label: data.to.city, kind: 'to' }]}
              label={t('mapLegend')}
            />
          </Card>
        ) : null}
        <AlertBox from={from} to={to} size={size} date={date} />
      </div>
    </div>
  );
}

export function AlertBox({ from, to, size, date }: { from: string; to: string; size?: Size; date?: string }) {
  const { t, me, err } = useApp();
  const [dateFrom, setDateFrom] = useState(date || isoDay(0));
  const [dateTo, setDateTo] = useState(date || '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = parseCity(from);
  const b = parseCity(to);
  if (!a || !b) return null;
  return (
    <Card hl={saved}>
      <h3>{t('alertTitle')}</h3>
      <p className="small muted">{t('alertText')}</p>
      {saved ? <Notice tone="go">{t('alertSaved', { route: `${a.city} → ${b.city}` })}</Notice> : (
        <>
          <div className="grid2">
            <Field label={t('alertDateFrom')}><input type="date" value={dateFrom} min={isoDay(0)} onChange={(e) => setDateFrom(e.target.value)} /></Field>
            <Field label={`${t('alertDateTo')} (${t('optional')})`}><input type="date" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} /></Field>
          </div>
          <Button kind="primary" id="alert-save" onClick={async () => {
            if (!me) {
              navigate(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
              return;
            }
            setError(null);
            try {
              await api.createAlert({ from: a, to: b, size: size === 'S' ? undefined : size, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined });
              setSaved(true);
            } catch (e) {
              setError(err(e));
            }
          }}>{t('alertSave')}</Button>
          {error ? <p className="small err">{error}</p> : null}
        </>
      )}
    </Card>
  );
}
