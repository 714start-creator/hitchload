// Time zone for a Canadian province or territory (by its main population centre).
// Used to write times in SMS, email and notifications in the zone of the place they refer to.
const ZONES: Record<string, string> = {
  BC: 'America/Vancouver', AB: 'America/Edmonton', SK: 'America/Regina', MB: 'America/Winnipeg',
  ON: 'America/Toronto', QC: 'America/Toronto', NB: 'America/Moncton', NS: 'America/Halifax', PE: 'America/Halifax',
  NL: 'America/St_Johns', YT: 'America/Whitehorse', NT: 'America/Yellowknife', NU: 'America/Iqaluit',
};

export const provinceTz = (province: string | null | undefined, fallback = 'America/Edmonton') => (province && ZONES[province.toUpperCase()]) || fallback;

/** "Nov 19, 10:00–14:00 MST" */
export function windowInZone(start: string | Date, end: string | Date, tz: string, lang = 'en'): string {
  const loc = lang === 'ru' ? 'ru-RU' : 'en-CA';
  const day = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(start));
  const parts = new Intl.DateTimeFormat('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date(end));
  const hm = `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
  const zone = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  const dayOf = (d: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
  if (dayOf(start) !== dayOf(end)) {
    const endDay = new Intl.DateTimeFormat(loc, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(end));
    return `${day} – ${endDay} ${zone}`.trim();
  }
  return `${day}–${hm} ${zone}`.trim();
}

/** "Thu, Nov 19, 14:30 MST" */
export function momentInZone(at: string | Date, tz: string, lang = 'en'): string {
  return new Intl.DateTimeFormat(lang === 'ru' ? 'ru-RU' : 'en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz, timeZoneName: 'short' }).format(new Date(at));
}
