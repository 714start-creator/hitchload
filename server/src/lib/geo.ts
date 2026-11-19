export interface Point {
  lat: number;
  lng: number;
}

export interface Place extends Point {
  address: string;
  city: string;
  province: string;
}

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. */
export function haversineKm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rough driving distance: straight line times a road factor. Replace with a routing API when available. */
export function roadKm(a: Point, b: Point, factor: number): number {
  return Math.max(1, Math.round(haversineKm(a, b) * factor));
}

export function sameCity(a: Pick<Place, 'city' | 'province'> & Point, b: Pick<Place, 'city' | 'province'> & Point, radiusKm: number): boolean {
  if (norm(a.city) === norm(b.city) && a.province === b.province) return true;
  return haversineKm(a, b) <= radiusKm;
}

export const norm = (s: string) => s.trim().toLowerCase();

export interface Stop extends Point {
  city: string;
  province: string;
}

export interface TripMatch {
  pickupIndex: number;
  dropoffIndex: number;
  kmToPickup: number;
  kmToDropoff: number;
}

/**
 * Does a route (ordered stops) pass the pickup and then the dropoff?
 * A place matches a stop when it lies within `stopKm` of it.
 */
export function matchRoute(stops: Stop[], pickup: Point, dropoff: Point, stopKm: number, roadFactor: number): TripMatch | null {
  const near = (p: Point) => stops.map((s, i) => ({ i, d: haversineKm(s, p) })).filter((x) => x.d <= stopKm);
  const ps = near(pickup);
  const ds = near(dropoff);
  for (const p of ps) {
    for (const d of ds) {
      if (d.i > p.i) {
        let km = 0;
        let kmToPickup = 0;
        for (let i = 1; i <= d.i; i++) {
          const prev = stops[i - 1] as Stop;
          const cur = stops[i] as Stop;
          km += roadKm(prev, cur, roadFactor);
          if (i === p.i) kmToPickup = km;
        }
        return { pickupIndex: p.i, dropoffIndex: d.i, kmToPickup, kmToDropoff: km };
      }
    }
  }
  return null;
}
