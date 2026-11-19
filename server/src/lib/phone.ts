/** Normalizes a North American number to E.164 (+1XXXXXXXXXX). Returns null when invalid. */
export function normalizePhone(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length === 10 && /^[2-9]/.test(d)) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1') && /^[2-9]/.test(d.slice(1))) return `+${d}`;
  return null;
}

/** Local HH:MM for a timestamp in a time zone. */
export function localHm(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at);
}

/** Is `hm` inside [from, to) where the range may wrap past midnight. */
export function inQuietHours(hm: string, from: string | null, to: string | null): boolean {
  if (!from || !to || from === to) return false;
  return from < to ? hm >= from && hm < to : hm >= from || hm < to;
}
