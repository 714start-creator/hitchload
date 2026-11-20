import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Link, navigate, useApp } from '../lib/app';
import { RouteMap } from '../lib/map';
import type { Stop } from '../lib/types';
import { useFormErrors } from '../lib/form';
import { Button, CityInput, isoDay } from '../lib/ui';

export function RouteSearch({ initialFrom = '', initialTo = '', initialDate = '', compact }: { initialFrom?: string; initialTo?: string; initialDate?: string; compact?: boolean }) {
  const { t, cities } = useApp();
  const f = useFormErrors();
  const known = (v: string) => cities.some((c) => `${c.city}, ${c.province}` === v);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [date, setDate] = useState(initialDate);
  return (
    <form className={`search ${compact ? 'compact' : ''}`} noValidate onSubmit={(e) => {
      e.preventDefault();
      const city = (v: string) => (!v.trim() ? t('errRequired') : cities.length && !known(v) ? t('errCity') : '');
      if (!f.check({ from: city(from), to: city(to) })) return;
      navigate(`/send?${new URLSearchParams({ from, to, ...(date ? { date } : {}) })}`);
    }}>
      <label className={`field ${f.errors.from ? 'invalid' : ''}`} data-field="from"><span className="label">{t('searchFrom')}</span><CityInput id="search-from" value={from} onChange={(v) => { setFrom(v); f.clear('from'); }} />{f.errors.from ? <span className="small err field-error">{f.errors.from}</span> : null}</label>
      <button type="button" className="swap" aria-label="⇄" onClick={() => { setFrom(to); setTo(from); }}>⇄</button>
      <label className={`field ${f.errors.to ? 'invalid' : ''}`} data-field="to"><span className="label">{t('searchTo')}</span><CityInput id="search-to" value={to} onChange={(v) => { setTo(v); f.clear('to'); }} />{f.errors.to ? <span className="small err field-error">{f.errors.to}</span> : null}</label>
      <label className="field"><span className="label">{t('searchDate')}</span><input id="search-date" type="date" value={date} min={isoDay(0)} onChange={(e) => setDate(e.target.value)} /></label>
      <Button kind="primary" type="submit">{t('findDrivers')}</Button>
    </form>
  );
}

export function Home() {
  const { t, me, site } = useApp();
  const [mode, setMode] = useState<'send' | 'drive'>('send');
  const [stats, setStats] = useState<{ drivers: number; trips: number; loads: number } | null>(null);
  const [routes, setRoutes] = useState<{ id: string; stops: Stop[] }[]>([]);
  useEffect(() => {
    api.stats().then(setStats).catch(() => undefined);
    api.tripsMap().then(setRoutes).catch(() => undefined);
  }, []);
  const driveTarget = me?.driver?.status === 'approved' ? '/driver/trips' : me?.driver ? '/driver/setup' : '/drive';
  const showStats = stats && stats.drivers + stats.trips + stats.loads >= 10;
  return (
    <>
      <section className="hero">
        <div className="hero-text">
          <h1>{t('heroTitle')}</h1>
          <p className="lead">{t('heroText')}</p>
          <div className="mode-tabs" role="tablist">
            <button role="tab" aria-selected={mode === 'send'} onClick={() => setMode('send')}>{t('heroSend')}</button>
            <button role="tab" aria-selected={mode === 'drive'} onClick={() => setMode('drive')}>{t('heroDrive')}</button>
          </div>
          {mode === 'send' ? (
            <RouteSearch />
          ) : (
            <div className="card hl drive-box">
              <p>{t('driverPitch')}</p>
              <div className="row">
                <Link to={driveTarget} className="btn primary">{me?.driver?.status === 'approved' ? t('postRoute') : t('driverPitchCta')}</Link>
                <Link to="/loads" className="btn">{t('seeLoads')}</Link>
              </div>
            </div>
          )}
          {showStats ? (
            <div className="stats">
              <div><b className="money">{stats.drivers}</b> {t('statDrivers')}</div>
              <div><b className="money">{stats.trips}</b> {t('statTrips')}</div>
              <div><b className="money">{stats.loads}</b> {t('statLoads')}</div>
            </div>
          ) : null}
        </div>
        <div className="hero-art" aria-hidden={routes.length === 0}>
          {routes.length ? <RouteMap routes={routes.map((r) => ({ ...r, highlight: true }))} height={360} label={t('mapLegend')} /> : <HeroSign brand={site?.brand ?? 'Hitchload'} />}
        </div>
      </section>

      <section className="band">
        <h2>{t('howTitle')}</h2>
        <ol className="how">
          {(['1', '2', '3', '4'] as const).map((n) => (
            <li key={n}>
              <span className="num">{n}</span>
              <h3>{t(`how${n}t`)}</h3>
              <p>{t(`how${n}`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="band">
        <h2>{t('whyTitle')}</h2>
        <div className="why">
          {(['1', '2', '3', '4'] as const).map((n) => (
            <div key={n} className="card">
              <h3>{t(`why${n}t`)}</h3>
              <p className="muted">{t(`why${n}`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="band driver-band">
        <div>
          <h2>{t('driverPitchTitle')}</h2>
          <p>{t('driverPitch')}</p>
        </div>
        <div className="row">
          <Link to={driveTarget} className="btn primary">{t('driverPitchCta')}</Link>
          <Link to="/loads" className="btn">{t('seeLoads')}</Link>
        </div>
      </section>

      <section className="band cta">
        <h2>{t('ctaTitle')}</h2>
        <p className="muted">{t('ctaText')}</p>
        <Link to={`/send/new`} className="btn primary">{t('postOrder')}</Link>
        <span className="muted small">{' '}{t('orSeparator')}{' '}</span>
        <Link to={`/send?date=${isoDay(0)}`} className="btn">{t('findDrivers')}</Link>
      </section>
    </>
  );
}

function HeroSign({ brand }: { brand: string }) {
  return (
    <svg viewBox="0 0 400 300" className="hero-sign" role="img" aria-label={brand}>
      <rect x="0" y="0" width="400" height="300" rx="16" fill="var(--chip)" />
      <path d="M20 250 C 120 230, 150 120, 230 110 S 360 60, 385 40" fill="none" stroke="var(--line)" strokeWidth="26" strokeLinecap="round" />
      <path d="M20 250 C 120 230, 150 120, 230 110 S 360 60, 385 40" fill="none" stroke="var(--panel)" strokeWidth="2" strokeDasharray="10 12" />
      {[[60, 240, 'Edmonton'], [205, 116, 'Red Deer'], [360, 50, 'Calgary']].map(([x, y, n]) => (
        <g key={n as string}>
          <circle cx={x as number} cy={y as number} r="9" fill="var(--sign)" stroke="var(--panel)" strokeWidth="3" />
          <text x={(x as number) + 14} y={(y as number) + 28} fontSize="14" fontWeight="600" fill="var(--ink)">{n}</text>
        </g>
      ))}
      <g transform="translate(130 150)">
        <rect width="120" height="44" rx="6" fill="var(--sign)" stroke="var(--sign-ink)" strokeWidth="3" />
        <text x="60" y="29" textAnchor="middle" fontSize="18" fontWeight="700" fill="var(--sign-ink)" fontFamily="var(--f-display)">{brand.toUpperCase()}</text>
      </g>
    </svg>
  );
}
