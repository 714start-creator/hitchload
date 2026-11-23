// Pure helpers (no React Native imports) so they can be unit-tested in Node.
import { langInfo, type Lang } from './i18n';

export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '—' : `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function dollarsToCents(input: string): number | null {
  const s = input.replace(/[^\d.,]/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const locale = (lang: Lang) => langInfo(lang).locale;

export function time(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function dayTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function windowText(start: string, end: string, lang: Lang): string {
  const a = new Date(start);
  const b = new Date(end);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? `${dayTime(start, lang)}–${time(end, lang)}` : `${dayTime(start, lang)} – ${dayTime(end, lang)}`;
}

/** Delivery window text: "by Fri, 28 Nov, 18:00" or "Thu, 27 Nov, 09:00 – Fri, 28 Nov, 18:00". */
export function deliveryText(start: string | null | undefined, end: string | null | undefined, lang: Lang, by: (when: string) => string): string | null {
  if (!end) return null;
  return start ? windowText(start, end, lang) : by(dayTime(end, lang));
}

/** mm:ss until `iso`, or null if passed. */
export function countdown(iso: string, now = Date.now()): string | null {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Builds the loading window for "day N, HH:MM to HH:MM" in local time. */
export function buildWindow(dayOffset: number, from: string, to: string, base = new Date()): { start: string; end: string } | null {
  const parse = (hm: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h < 24 && min < 60 ? [h, min] as const : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return null;
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), a[0], a[1]);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), b[0], b[1]);
  if (e <= s) return null;
  return { start: s.toISOString(), end: e.toISOString() };
}

export function maskPhone(raw: string): string {
  const d = raw.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Google Maps directions link (opens the app or the website). */
export const directionsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

export interface PlaceValue {
  address: string;
  city: string;
  province: string;
  lat: number;
  lng: number;
}

interface AddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

/** Turns a Places API (New) place into the shape the server expects. */
export function placeFromGoogle(p: { formattedAddress?: string; location?: { latitude: number; longitude: number }; addressComponents?: AddressComponent[] }): PlaceValue | null {
  if (!p.location || !p.formattedAddress) return null;
  const comp = (type: string) => p.addressComponents?.find((c) => c.types?.includes(type));
  const city = comp('locality')?.longText ?? comp('administrative_area_level_3')?.longText ?? comp('sublocality')?.longText ?? '';
  const province = comp('administrative_area_level_1')?.shortText ?? '';
  const country = comp('country')?.shortText;
  if (!city || province.length !== 2 || (country && country !== 'CA')) return null;
  const address = p.formattedAddress.replace(/,\s*(Canada|Канада)$/i, '').replace(new RegExp(`,\\s*${city}.*$`), '').trim() || p.formattedAddress;
  return { address, city, province, lat: p.location.latitude, lng: p.location.longitude };
}
