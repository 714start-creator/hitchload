// Driver's trips: post a route with stops and departure; see loads along each trip.
import { useState } from 'react';
import { api } from '../../lib/api';
import { useApp, useLoad } from '../../lib/app';
import { dayTime } from '../../lib/format';
import { RouteMap } from '../../lib/map';
import type { Trip } from '../../lib/types';
import { Button, Card, CityInput, Empty, ErrorBox, Field, Loading, Notice, PageHead, RequireAuth, RouteLine } from '../../lib/ui';
import { DriverNav, LoadCard } from './Feed';

export function Trips() {
  return <RequireAuth><TripsPage /></RequireAuth>;
}

const inHours = (h: number) => {
  const d = new Date(Date.now() + h * 3_600_000);
  d.setMinutes(0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
};

function TripsPage() {
  const { t, me } = useApp();
  const trips = useLoad(() => api.trips(), []);
  const [open, setOpen] = useState<string | null>(null);
  const [posted, setPosted] = useState<Trip | null>(null);
  if (me?.driver?.status !== 'approved') return <Notice>{t(`ds_${me?.driver?.status ?? 'draft'}`)}</Notice>;
  return (
    <div className="page">
      <PageHead title={t('myTrips')} text={t('tripsIntro')} />
      <DriverNav />
      <div className="split">
        <div className="stack">
          <NewTrip onPosted={(tr) => { setPosted(tr); setOpen(tr.id); void trips.reload(); }} />
          {posted?.matches ? <Notice tone="go">{t('tripPosted', { loads: posted.matches.loads, shippers: posted.matches.shippersNotified })}</Notice> : null}
        </div>
        <div className="stack">
          {trips.loading && !trips.data ? <Loading /> : null}
          <ErrorBox error={trips.error} onRetry={trips.reload} />
          {trips.data?.length === 0 ? <Empty>{t('noMyTrips')}</Empty> : null}
          {trips.data?.map((tr) => (
            <TripItem key={tr.id} trip={tr} open={open === tr.id} toggle={() => setOpen(open === tr.id ? null : tr.id)} onCancel={() => trips.reload()} />
          ))}
        </div>
      </div>
    </div>
  );
}

function NewTrip({ onPosted }: { onPosted: (t: Trip) => void }) {
  const { t, err, cities } = useApp();
  const [stops, setStops] = useState<string[]>(['', '']);
  const [depart, setDepart] = useState(inHours(3));
  const [space, setSpace] = useState('half');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const parsed = stops.map((s) => cities.find((c) => `${c.city}, ${c.province}` === s));
  const valid = parsed.every(Boolean) && parsed.length >= 2 && depart;
  return (
    <Card>
      <h2 className="h3">{t('newTrip')}</h2>
      <span className="label">{t('stops')}</span>
      {stops.map((s, i) => (
        <div key={i} className="row stop-row">
          <span className="stop-dot" aria-hidden="true">{i === 0 ? 'A' : i === stops.length - 1 ? 'B' : '•'}</span>
          <div className="grow"><CityInput id={`stop-${i}`} value={s} onChange={(v) => setStops(stops.map((x, j) => (j === i ? v : x)))} /></div>
          {stops.length > 2 && i > 0 && i < stops.length - 1 ? <Button small kind="ghost" onClick={() => setStops(stops.filter((_, j) => j !== i))}>{t('removeStop')}</Button> : null}
        </div>
      ))}
      {stops.length < 8 ? <button type="button" className="btn ghost small" id="add-stop" onClick={() => setStops([...stops.slice(0, -1), '', stops[stops.length - 1]!])}>{t('addStop')}</button> : null}
      <div className="grid2">
        <Field label={t('departure')}><input id="depart" type="datetime-local" value={depart} onChange={(e) => setDepart(e.target.value)} /></Field>
        <Field label={t('space')}>
          <select id="space" value={space} onChange={(e) => setSpace(e.target.value)}>
            <option value="quarter">{t('space_quarter')}</option>
            <option value="half">{t('space_half')}</option>
            <option value="full">{t('space_full')}</option>
          </select>
        </Field>
      </div>
      <Field label={t('note')}><input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} /></Field>
      {parsed.every(Boolean) ? <RouteMap routes={[{ id: 'new', stops: parsed.map((c) => c!), highlight: true }]} height={200} /> : null}
      <Button kind="primary" id="publish-trip" disabled={!valid} onClick={async () => {
        setError(null);
        try {
          const tr = await api.createTrip({ stops: parsed.map((c) => ({ city: c!.city, province: c!.province })), departAt: new Date(depart).toISOString(), space, ...(note ? { note } : {}) });
          setStops(['', '']);
          setNote('');
          onPosted(tr);
        } catch (e) {
          setError(err(e));
        }
      }}>{t('publishTrip')}</Button>
      {error ? <p className="small err">{error}</p> : null}
    </Card>
  );
}

function TripItem({ trip, open, toggle, onCancel }: { trip: Trip; open: boolean; toggle: () => void; onCancel: () => void }) {
  const { t, lang } = useApp();
  return (
    <Card hl={open}>
      <button className="row between plain" onClick={toggle} aria-expanded={open}>
        <RouteLine from={trip.stops[0]!.city} to={trip.stops[trip.stops.length - 1]!.city} sub={`${trip.stops.map((s) => s.city).join(' → ')} · ${dayTime(trip.departAt, lang)}`} />
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open ? <TripLoads id={trip.id} /> : null}
      {open ? <Button small kind="ghost" onClick={async () => { await api.cancelTrip(trip.id); onCancel(); }}>{t('cancelTrip')}</Button> : null}
    </Card>
  );
}

function TripLoads({ id }: { id: string }) {
  const { t } = useApp();
  const { data, error, loading, reload } = useLoad(() => api.tripLoads(id), [id]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  return (
    <div className="stack">
      <span className="label">{t('loadsOnTrip')}</span>
      {data!.items.length === 0 ? <p className="small muted">{t('noLoadsOnTrip')}</p> : null}
      {data!.items.map((o) => <LoadCard key={o.id} o={o} eta={o.pickupEta} fitsWindow={o.fitsWindow} />)}
    </div>
  );
}
