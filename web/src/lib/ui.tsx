// Shared building blocks: form fields, cards, pills, money, pickers.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { Link, navigate, useApp } from './app';
import { dayTime, deliveryText, money, placeFromGoogle, type PlaceValue } from './format';
import { LANGS, type Lang } from './i18n';
import type { City, OrderStatus, Size, TripOption } from './types';

export function Button({ children, kind = 'secondary', small, busy, disabled, onClick, type = 'button', className = '', ...rest }: {
  children: ReactNode; kind?: 'primary' | 'secondary' | 'ghost' | 'warn' | 'danger'; small?: boolean; busy?: boolean; disabled?: boolean;
  onClick?: () => unknown; type?: 'button' | 'submit'; className?: string; 'aria-pressed'?: boolean; id?: string;
}) {
  const [running, setRunning] = useState(false);
  return (
    <button
      type={type}
      className={`btn ${kind} ${small ? 'small' : ''} ${className}`}
      disabled={disabled || busy || running}
      onClick={onClick ? async () => {
        const r = onClick();
        if (r instanceof Promise) {
          setRunning(true);
          try {
            await r;
          } finally {
            setRunning(false);
          }
        }
      } : undefined}
      {...rest}
    >
      {busy || running ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, children, error, name }: { label: ReactNode; hint?: ReactNode; children: ReactNode; error?: string | null; name?: string }) {
  return (
    <label className={`field ${error ? 'invalid' : ''}`} data-field={name}>
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="small muted">{hint}</span> : null}
      {error ? <span className="small err field-error">{error}</span> : null}
    </label>
  );
}

/** A checkbox row that can be marked as missing. */
export function Check({ checked, onChange, children, error, name, id }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; error?: string | null; name?: string; id?: string }) {
  return (
    <div className={`check-wrap ${error ? 'invalid' : ''}`} data-field={name}>
      <label className="check">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{children}</span>
      </label>
      {error ? <span className="small err field-error">{error}</span> : null}
    </div>
  );
}

export const Card = ({ children, hl, className = '', id }: { children: ReactNode; hl?: boolean; className?: string; id?: string }) => (
  <section className={`card ${hl ? 'hl' : ''} ${className}`} id={id}>{children}</section>
);

export const Pill = ({ children, tone }: { children: ReactNode; tone?: 'go' | 'wait' | 'done' | 'bad' }) => <span className={`pill ${tone ?? ''}`}>{children}</span>;

export function StatusPill({ status }: { status: OrderStatus }) {
  const { t } = useApp();
  const tone = status === 'open' ? 'wait' : status === 'delivered' ? 'done' : status === 'cancelled' ? undefined : 'go';
  return <Pill tone={tone}>{t(`st_${status}`)}</Pill>;
}

export const Money = ({ cents, className = '' }: { cents: number | null | undefined; className?: string }) => <span className={`money ${className}`}>{money(cents)}</span>;

export function Steps({ status }: { status: OrderStatus }) {
  const idx = { open: 0, agreed: 1, picked_up: 2, in_transit: 3, delivered: 4, cancelled: 0 }[status];
  return (
    <div className="steps" aria-hidden="true">
      {[1, 2, 3, 4].map((i) => <div key={i} className={idx >= i ? 'on' : ''} />)}
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export function Loading() {
  const { t } = useApp();
  return <div className="loading"><span className="spinner" aria-hidden="true" /> {t('loading')}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { err, t } = useApp();
  if (!error) return null;
  return (
    <div className="notice bad" role="alert">
      {err(error)} {onRetry ? <button className="btn small ghost" onClick={onRetry}>{t('retry')}</button> : null}
    </div>
  );
}

export const Notice = ({ children, tone = 'wait' }: { children: ReactNode; tone?: 'wait' | 'go' | 'bad' }) => <div className={`notice ${tone}`}>{children}</div>;

export function RouteLine({ from, to, sub }: { from: string; to: string; sub?: ReactNode }) {
  return (
    <div>
      <div className="route">{from}<span className="arr">→</span>{to}</div>
      {sub ? <div className="small muted">{sub}</div> : null}
    </div>
  );
}

export const SIZES: Size[] = ['S', 'M', 'L', 'XL', 'AUTO'];

export function SizePicker({ value, onChange, withAuto = true }: { value: Size; onChange: (s: Size) => void; withAuto?: boolean }) {
  const { t } = useApp();
  return (
    <div className="sizes" role="group">
      {SIZES.filter((s) => withAuto || s !== 'AUTO').map((s) => (
        <button key={s} type="button" className="size" aria-pressed={value === s} onClick={() => onChange(s)} title={t(`size${s}d`)}>
          <b>{s === 'AUTO' ? '🚗' : s}</b>
          <span>{t(`size${s}`)}</span>
        </button>
      ))}
    </div>
  );
}

export const cityLabel = (c: { city: string; province: string }) => `${c.city}, ${c.province}`;

/** City combobox over the server's city list. Value is "City, PR" or ''. */
export function CityInput({ value, onChange, placeholder, id }: { value: string; onChange: (v: string, c: City | null) => void; placeholder?: string; id?: string }) {
  const { cities, t } = useApp();
  const listId = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const find = (s: string) => cities.find((c) => cityLabel(c).toLowerCase() === s.trim().toLowerCase() || c.city.toLowerCase() === s.trim().toLowerCase()) ?? null;
  return (
    <>
      <input
        id={id}
        list={listId}
        value={text}
        placeholder={placeholder ?? t('pickCity')}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          const c = find(e.target.value);
          onChange(c ? cityLabel(c) : '', c);
        }}
        onBlur={() => {
          const c = find(text);
          if (c) setText(cityLabel(c));
        }}
      />
      <datalist id={listId}>
        {cities.map((c) => <option key={cityLabel(c)} value={cityLabel(c)} />)}
      </datalist>
    </>
  );
}

// ---------------------------------------------------------------- addresses

interface Suggestion { placeId: string; main: string; secondary: string }

async function googleAutocomplete(key: string, input: string, session: string, lang: string): Promise<Suggestion[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({ input, sessionToken: session, includedRegionCodes: ['ca'], languageCode: lang }),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { suggestions?: { placePrediction?: { placeId: string; structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } } } }[] };
  return (json.suggestions ?? []).flatMap((s) => (s.placePrediction ? [{ placeId: s.placePrediction.placeId, main: s.placePrediction.structuredFormat?.mainText?.text ?? '', secondary: s.placePrediction.structuredFormat?.secondaryText?.text ?? '' }] : []));
}

async function googleDetails(key: string, placeId: string, session: string, lang: string): Promise<PlaceValue | null> {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${session}&languageCode=${lang}`, { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'formattedAddress,location,addressComponents' } });
  return res.ok ? placeFromGoogle(await res.json()) : null;
}

const newSession = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/**
 * Address input. With a Google key: live suggestions limited to Canada (exact coordinates).
 * Without one: street address + city from the list (city-centre coordinates).
 */
export function PlaceInput({ label, value, onChange, idPrefix, defaultCity = '', error, name }: { label: string; value: PlaceValue | null; onChange: (p: PlaceValue | null) => void; idPrefix: string; defaultCity?: string; error?: string | null; name?: string }) {
  const { site, t, lang, cities } = useApp();
  const key = site?.googleMapsKey;
  const [street, setStreet] = useState(value?.address ?? '');
  const [cityText, setCityText] = useState(value ? cityLabel(value) : defaultCity);
  const [items, setItems] = useState<Suggestion[]>([]);
  const session = useRef(newSession());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!key) {
    const emit = (s: string, c: City | null) => onChange(c && s.trim().length >= 3 ? { address: s.trim(), city: c.city, province: c.province, lat: c.lat, lng: c.lng } : null);
    const cityOf = (label: string) => cities.find((c) => cityLabel(c) === label) ?? null;
    return (
      <fieldset className={`field ${error ? 'invalid' : ''}`} data-field={name}>
        <legend className="label">{label}</legend>
        <div className="grid-addr">
          <input id={`${idPrefix}-street`} aria-label={`${label}: ${t('street')}`} value={street} placeholder={t('streetPh')} autoComplete="street-address"
            onChange={(e) => { setStreet(e.target.value); emit(e.target.value, cityOf(cityText)); }} />
          <CityInput id={`${idPrefix}-city`} value={cityText} onChange={(v, c) => { setCityText(v); emit(street, c); }} />
        </div>
        {error ? <span className="small err field-error">{error}</span> : null}
      </fieldset>
    );
  }
  return (
    <div className={`field combo ${error ? 'invalid' : ''}`} data-field={name}>
      <span className="label">{label}</span>
      <input id={`${idPrefix}-street`} value={street} placeholder={t('addressPh')} autoComplete="off" className={value ? 'ok' : ''}
        onChange={(e) => {
          const s = e.target.value;
          setStreet(s);
          onChange(null);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => { if (s.trim().length >= 3) googleAutocomplete(key, s, session.current, lang).then(setItems).catch(() => setItems([])); }, 250);
        }} />
      {items.length > 0 && !value ? (
        <ul className="suggest" role="listbox">
          {items.slice(0, 5).map((s) => (
            <li key={s.placeId}>
              <button type="button" onClick={async () => {
                const p = await googleDetails(key, s.placeId, session.current, lang);
                session.current = newSession();
                setItems([]);
                if (p) {
                  setStreet(`${p.address}, ${p.city}`);
                  onChange(p);
                }
              }}>
                <b>{s.main}</b> <span className="muted small">{s.secondary}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <span className="small err field-error">{error}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- uploads

export function PhotoUpload({ purpose, keys, onChange, max = 6, label, accept = 'image/*', id, invalid, name }: { purpose: 'order' | 'pickup' | 'delivery' | 'document'; keys: { key: string; url: string }[]; onChange: (k: { key: string; url: string }[]) => void; max?: number; label: string; accept?: string; id?: string; invalid?: string | null; name?: string }) {
  const { err } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  return (
    <div className={`field ${invalid ? 'invalid' : ''}`} data-field={name}>
      <div className="thumbs">
        {keys.map((k) => (
          <div key={k.key} className="thumb">
            {/\.pdf$/.test(k.key) ? <span>PDF</span> : <img src={k.url} alt="" />}
            <button type="button" className="x" aria-label="×" onClick={() => onChange(keys.filter((x) => x.key !== k.key))}>×</button>
          </div>
        ))}
        {keys.length < max ? (
          <label className={`thumb add ${busy ? 'busy' : ''}`} htmlFor={id ?? inputId}>
            {busy ? <span className="spinner" /> : '+'}
            <span className="small">{label}</span>
          </label>
        ) : null}
      </div>
      <input id={id ?? inputId} type="file" accept={accept} multiple={max > 1} hidden onChange={async (e) => {
        const files = [...(e.target.files ?? [])].slice(0, max - keys.length);
        e.target.value = '';
        if (!files.length) return;
        setBusy(true);
        setError(null);
        try {
          const out = [...keys];
          for (const f of files) out.push(await api.upload(await shrinkImage(f), purpose));
          onChange(out);
        } catch (x) {
          setError(err(x));
        } finally {
          setBusy(false);
        }
      }} />
      {error || invalid ? <span className="small err field-error">{error ?? invalid}</span> : null}
    </div>
  );
}

/** Phone photos are 3–8 MB; resize to 1600 px JPEG before upload. PDFs pass through. */
async function shrinkImage(f: File): Promise<Blob> {
  if (!f.type.startsWith('image/') || f.type === 'image/heic' || f.size < 900_000) return f;
  try {
    const bmp = await createImageBitmap(f);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((r) => c.toBlob((b) => r(b ?? f), 'image/jpeg', 0.85));
  } catch {
    return f;
  }
}

// ---------------------------------------------------------------- trips

export function TripCard({ trip, from, to, action, highlight }: { trip: TripOption; from: string; to: string; action?: ReactNode; highlight?: boolean }) {
  const { t, lang } = useApp();
  const fromCity = from.split(',')[0]!.trim();
  const toCity = to.split(',')[0]!.trim();
  return (
    <div className={`card trip ${highlight || trip.fitsWindow ? 'hl' : ''}`}>
      <div className="row between">
        <b>
          {trip.driver.name ?? '—'}{' '}
          <span className="muted small">
            {trip.driver.rating ? t('rating', { r: trip.driver.rating.toFixed(1) }) : t('newDriver')} · {trip.driver.vehicle || '—'} · {t('jobs', { n: trip.driver.completedJobs })}
          </span>
        </b>
        <Pill tone={trip.driver.tier === 'pro' ? 'done' : undefined}>{t(trip.driver.tier === 'pro' ? 'tier_pro' : 'tier_basic')}</Pill>
      </div>
      <div className="route small">
        {trip.stops.map((s, i) => (
          <span key={i}>
            {i > 0 ? <span className="arr">→</span> : null}
            {s.city === fromCity || s.city === toCity ? <b>{s.city}</b> : <span className="muted">{s.city}</span>}
          </span>
        ))}
      </div>
      <div className="small">
        {t('departs', { city: trip.stops[0]!.city, time: dayTime(trip.departAt, lang) })} · {t('picksUp', { city: fromCity, time: dayTime(trip.pickupEta, lang) })} · {t('arrives', { city: toCity, time: dayTime(trip.dropoffEta, lang) })}
      </div>
      <div className="row between">
        <span className="small">{trip.fitsWindow ? <Pill tone="go">{t('fitsWindow')}</Pill> : t(`space_${trip.space}` as 'space_half')}</span>
        <span className="small">{t('onTheWayPrice')} <b className="money">{money(trip.priceCents)}</b></span>
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- misc

export function Stars({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="stars" role="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={String(n)} className={n <= value ? 'on' : ''} onClick={() => onChange(n)}>★</button>
      ))}
    </div>
  );
}

export function FeeBox({ rows, total }: { rows: [string, number, boolean?][]; total: [string, number] }) {
  return (
    <div className="fee">
      {rows.map(([label, cents, muted]) => (
        <div key={label} className={muted ? 'muted' : ''}><span>{label}</span><span className="money">{money(cents)}</span></div>
      ))}
      <div className="total"><span>{total[0]}</span><span className="money">{money(total[1])}</span></div>
    </div>
  );
}

/** Shows children only to signed-in users; otherwise a sign-in prompt that comes back here. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, ready, t } = useApp();
  useEffect(() => {
    if (ready && !me) navigate(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`, true);
  }, [ready, me]);
  if (!ready) return <Loading />;
  if (!me) return <p className="muted">{t('signInToContinue')}</p>;
  return <>{children}</>;
}

export function PageHead({ title, text, back }: { title: string; text?: ReactNode; back?: string }) {
  const { t } = useApp();
  return (
    <div className="page-head">
      {back ? <Link to={back} className="back">{t('back')}</Link> : null}
      <h1>{title}</h1>
      {text ? <p className="lead">{text}</p> : null}
    </div>
  );
}

export function Countdown({ to, now }: { to: string; now: number }) {
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return <span className="money">0:00</span>;
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return <span className="money">{h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`}</span>;
}

/** today / tomorrow / … as YYYY-MM-DD in local time */
export const isoDay = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function useCityPair(initialFrom = '', initialTo = '') {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  return useMemo(() => ({ from, to, setFrom, setTo }), [from, to]);
}

/** Language menu: every language named in itself. */
export function LangSelect({ id, compact }: { id?: string; compact?: boolean }) {
  const { lang, setLang, t } = useApp();
  return (
    <select id={id} className={`lang-select ${compact ? 'compact' : ''}`} value={lang} aria-label={t('language')} onChange={(e) => setLang(e.target.value as Lang)}>
      {LANGS.map((l) => <option key={l.code} value={l.code} lang={l.code} dir={l.dir}>{compact ? `${l.code.toUpperCase()} · ${l.name}` : l.name}</option>)}
    </select>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = ['00', '15', '30', '45'];

/**
 * Date + hour + minute with labels, instead of the browser's own date-time pop-up (unlabelled, hard to scroll).
 * `value` is "YYYY-MM-DDTHH:MM" in local time, or "" when empty (only with `optional`).
 */
export function DateTimeInput({ idPrefix, label, value, onChange, error, name, min, optional }: {
  idPrefix: string; label: ReactNode; value: string; onChange: (v: string) => void; error?: string | null; name?: string; min?: string; optional?: boolean;
}) {
  const { t } = useApp();
  const [date, hm = ''] = value ? value.split('T') : ['', ''];
  const [h = '', m = ''] = hm.split(':');
  const minute = MINUTES.includes(m) ? m : m ? m : '00';
  const emit = (d: string, hh: string, mm: string) => onChange(d ? `${d}T${hh || '09'}:${mm || '00'}` : '');
  return (
    <fieldset className={`field datetime ${error ? 'invalid' : ''}`} data-field={name}>
      <legend className="label">{label}</legend>
      <div className="dt-row">
        <label className="dt-part dt-date">
          <span className="small muted">{t('dtDate')}</span>
          <input id={`${idPrefix}-date`} type="date" value={date ?? ''} min={min} onChange={(e) => emit(e.target.value, h, minute)} />
        </label>
        <label className="dt-part">
          <span className="small muted">{t('dtHours')}</span>
          <select id={`${idPrefix}-hour`} value={h} disabled={optional && !date} onChange={(e) => emit(date || isoDay(0), e.target.value, minute)}>
            {optional && !date ? <option value="">—</option> : null}
            {HOURS.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="dt-part">
          <span className="small muted">{t('dtMinutes')}</span>
          <select id={`${idPrefix}-minute`} value={minute} disabled={optional && !date} onChange={(e) => emit(date || isoDay(0), h, e.target.value)}>
            {(MINUTES.includes(minute) ? MINUTES : [minute, ...MINUTES]).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        {optional && date ? <button type="button" className="btn ghost small dt-clear" onClick={() => onChange('')} aria-label={t('dtClear')}>{t('dtClear')}</button> : null}
      </div>
      {error ? <span className="small err field-error">{error}</span> : null}
    </fieldset>
  );
}

/** "YYYY-MM-DDTHH:MM" (local) → ISO, or null. */
export function localToIso(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).toISOString();
}

/** "Delivery: by Fri 28 Nov, 18:00" under a route, when the customer set a deadline. */
export function DeliveryLine({ o }: { o: { deliveryStart?: string | null; deliveryEnd?: string | null } }) {
  const { t, lang } = useApp();
  const text = deliveryText(o.deliveryStart, o.deliveryEnd, lang, (when) => t('deliverByWhen', { when }));
  return text ? <p className="small delivery-line"><b>{t('deliveryLabel')}:</b> {text}</p> : null;
}
