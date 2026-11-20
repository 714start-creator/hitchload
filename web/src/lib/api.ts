// HTTP client for the site. Same origin as the API; the session token lives in localStorage.
import type { CancelPreview, City, DriverOverview, Earnings, Me, Message, Notification, Order, PublicLoad, Quote, RouteAlert, SiteConfig, Size, Stop, Trip, TripLoad, TripOption } from './types';
import type { PlaceValue } from './format';
import type { Lang } from './i18n';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

const TOKEN_KEY = 'hl.token';
let token: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: the session lasts for this tab */
  }
}

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (f: () => void) => void (onUnauthorized = f);

async function call<T>(method: string, path: string, body?: unknown, raw?: { data: Blob; type: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(raw ? { 'Content-Type': raw.type } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server');
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status === 401 && token) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'http_' + res.status, json?.error?.message ?? 'Request failed', json?.error?.details);
  return json as T;
}
const get = <T>(p: string) => call<T>('GET', p);
const post = <T>(p: string, b: unknown = {}) => call<T>('POST', p, b);
const qs = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v) as [string, string][]).toString();

export const api = {
  // public
  site: () => get<SiteConfig>('/v1/public/site'),
  config: () => get<{ rules: { clientFeeRate: number; driverFeeRate: number; insuranceRate: number; insuranceMinCents: number; basicCargoLimitCents: number; cancelLateHours: number } }>('/v1/config'),
  cities: () => get<City[]>('/v1/cities'),
  stats: () => get<{ drivers: number; trips: number; loads: number; delivered: number }>('/v1/public/stats'),
  searchTrips: (p: { from: string; to: string; size?: Size; date?: string }) => get<{ from: Stop; to: Stop; distanceKm: number; trips: TripOption[] }>(`/v1/public/trips?${qs(p)}`),
  publicLoads: (p: { from?: string; to?: string }) => get<PublicLoad[]>(`/v1/public/loads?${qs(p)}`),
  tripsMap: () => get<{ id: string; stops: Stop[]; departAt: string }[]>('/v1/trips/map'),
  // auth
  startOtp: (phone: string) => post<{ phone: string; devCode?: string }>('/v1/auth/otp/start', { phone }),
  verifyOtp: (phone: string, code: string) => post<{ token: string; user: Me }>('/v1/auth/otp/verify', { phone, code }),
  // account
  me: () => get<Me>('/v1/me'),
  updateMe: (p: { name?: string; email?: string; lang?: Lang; acceptTerms?: true; emailAlerts?: boolean }) => call<Me>('PATCH', '/v1/me', p),
  resendEmail: () => post<{ sent: boolean }>('/v1/me/email/verify'),
  savePush: (sub: PushSubscriptionJSON) => post('/v1/me/push-tokens', { token: JSON.stringify(sub), platform: 'web' }),
  removePush: (sub: PushSubscriptionJSON) => call('DELETE', '/v1/me/push-tokens', { token: JSON.stringify(sub) }),
  cardSetup: () => post<{ setupIntentClientSecret: string; customerId: string; publishableKey: string }>('/v1/me/card/setup'),
  cardSync: () => post<Me>('/v1/me/card/sync'),
  testCard: () => post<Me>('/v1/dev/test-card'),
  notifications: () => get<Notification[]>('/v1/me/notifications'),
  markRead: (upTo: number) => post('/v1/me/notifications/read', { upTo }),
  alerts: () => get<RouteAlert[]>('/v1/alerts'),
  createAlert: (p: { from: { city: string; province: string }; to: { city: string; province: string }; size?: Size; dateFrom?: string; dateTo?: string }) => post<{ alert: RouteAlert; trips: TripOption[] }>('/v1/alerts', p),
  deleteAlert: (id: string) => call('DELETE', `/v1/alerts/${id}`),
  upload: (file: Blob, purpose: 'order' | 'pickup' | 'delivery' | 'document') => call<{ key: string; url: string }>('POST', `/v1/uploads?purpose=${purpose}`, undefined, { data: file, type: file.type || 'application/octet-stream' }),
  // customer
  quote: (p: { pickup: PlaceValue; dropoff: PlaceValue; size: Size; declaredValueCents: number; insured: boolean; windowStart?: string; windowEnd?: string }) => post<Quote>('/v1/quotes', p),
  createOrder: (p: Record<string, unknown>) => post<Order>('/v1/orders', p),
  orders: () => get<Order[]>('/v1/orders'),
  order: (id: string) => get<Order>(`/v1/orders/${id}`),
  requestTrip: (id: string, tripId: string) => post<{ ok: true; requestExpiresAt: string }>(`/v1/orders/${id}/request-trip`, { tripId }),
  respondOffer: (id: string, offerId: string, action: 'accept' | 'decline' | 'counter', amountCents?: number) => post<Order>(`/v1/orders/${id}/offers/${offerId}`, { action, amountCents }),
  cancelPreview: (id: string) => get<CancelPreview>(`/v1/orders/${id}/cancel`),
  cancel: (id: string, reason?: string) => post<CancelPreview & { status: string }>(`/v1/orders/${id}/cancel`, { reason }),
  messages: (id: string) => get<Message[]>(`/v1/orders/${id}/messages`),
  sendMessage: (id: string, body: string) => post<Message>(`/v1/orders/${id}/messages`, { body }),
  rate: (id: string, stars: number, comment?: string) => post(`/v1/orders/${id}/rating`, { stars, comment }),
  dispute: (id: string, reason: string) => post<{ id: string }>(`/v1/orders/${id}/disputes`, { reason }),
  // driver
  startDriver: () => post<DriverOverview>('/v1/driver'),
  driver: () => get<DriverOverview>('/v1/driver'),
  updateDriver: (p: Record<string, unknown>) => call<DriverOverview>('PATCH', '/v1/driver', p),
  addVehicle: (p: Record<string, unknown>) => post('/v1/driver/vehicles', p),
  removeVehicle: (id: string) => call('DELETE', `/v1/driver/vehicles/${id}`),
  addDocument: (p: Record<string, unknown>) => post('/v1/driver/documents', p),
  saveTax: (p: { type: 'sin' | 'bn'; number: string; gstNumber?: string }) => post<DriverOverview>('/v1/driver/tax', p),
  quiz: () => get<{ id: string; question: string; options: string[] }[]>('/v1/driver/quiz'),
  agreement: (answers: Record<string, number>) => post<DriverOverview>('/v1/driver/agreement', { answers }),
  identity: () => post<{ url: string }>('/v1/driver/identity'),
  payouts: () => post<{ url: string }>('/v1/driver/payouts'),
  refreshPayouts: () => post<DriverOverview>('/v1/driver/payouts/refresh'),
  submitDriver: () => post<DriverOverview>('/v1/driver/submit'),
  earnings: () => get<Earnings>('/v1/driver/earnings'),
  location: (lat: number, lng: number) => post('/v1/driver/location', { lat, lng }),
  trips: () => get<Trip[]>('/v1/driver/trips'),
  createTrip: (p: { stops: { city: string; province: string }[]; departAt: string; space: string; note?: string }) => post<Trip>('/v1/driver/trips', p),
  cancelTrip: (id: string) => call('DELETE', `/v1/driver/trips/${id}`),
  tripLoads: (id: string) => get<{ trip: { id: string; stops: Stop[]; departAt: string }; items: TripLoad[] }>(`/v1/driver/trips/${id}/loads`),
  feed: () => get<{ status: string; tier?: string; items: Order[] }>('/v1/driver/feed'),
  jobs: (scope: 'active' | 'history') => get<Order[]>(`/v1/driver/jobs?scope=${scope}`),
  driverOrder: (id: string) => get<Order>(`/v1/driver/orders/${id}`),
  take: (id: string) => post<Order>(`/v1/driver/orders/${id}/take`),
  offer: (id: string, amountCents: number) => post<Order>(`/v1/driver/orders/${id}/offer`, { amountCents }),
  answerCounter: (id: string, action: 'accept' | 'decline') => post<Order>(`/v1/driver/orders/${id}/counter`, { action }),
  declineRequest: (id: string) => post(`/v1/driver/orders/${id}/decline-request`),
  enRoute: (id: string) => post<Order>(`/v1/driver/orders/${id}/en-route`),
  pickup: (id: string, photoKeys: string[]) => post<Order>(`/v1/driver/orders/${id}/pickup`, { photoKeys }),
  depart: (id: string) => post<Order>(`/v1/driver/orders/${id}/depart`),
  deliver: (id: string, pin: string, photoKeys: string[] = []) => post<Order>(`/v1/driver/orders/${id}/deliver`, { pin, photoKeys }),
  drop: (id: string, reason: string) => post(`/v1/driver/orders/${id}/drop`, { reason }),
};
