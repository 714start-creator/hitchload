// HTTP client for the Poputka API. No React Native imports here so it can be unit-tested.
import type { CancelPreview, DriverOverview, Earnings, Me, Message, Notification, Order, Quote, Size, Trip } from './types';
import type { PlaceValue } from './format';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function createApi(baseUrl: string, getToken: () => string | null, f: Fetch = fetch as unknown as Fetch) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = getToken();
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await f(baseUrl + path, {
        method,
        headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
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
    if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'http_' + res.status, json?.error?.message ?? 'Request failed', json?.error?.details);
    return json as T;
  }
  const get = <T>(p: string) => call<T>('GET', p);
  const post = <T>(p: string, b: unknown = {}) => call<T>('POST', p, b);

  return {
    baseUrl,
    // auth
    startOtp: (phone: string) => post<{ phone: string; devCode?: string }>('/v1/auth/otp/start', { phone }),
    verifyOtp: (phone: string, code: string) => post<{ token: string; user: Me }>('/v1/auth/otp/verify', { phone, code }),
    // account
    me: () => get<Me>('/v1/me'),
    updateMe: (p: { name?: string; email?: string; lang?: 'ru' | 'en'; acceptTerms?: true }) => call<Me>('PATCH', '/v1/me', p),
    savePushToken: (token: string, platform: 'ios' | 'android') => post('/v1/me/push-tokens', { token, platform }),
    removePushToken: (token: string) => call('DELETE', '/v1/me/push-tokens', { token }),
    cardSetup: () => post<{ setupIntentClientSecret: string; ephemeralKeySecret: string; customerId: string; publishableKey: string; merchantDisplayName: string }>('/v1/me/card/setup'),
    cardSync: () => post<Me>('/v1/me/card/sync'),
    notifications: () => get<Notification[]>('/v1/me/notifications'),
    markRead: (upTo: number) => post('/v1/me/notifications/read', { upTo }),
    config: () => get<{ stripePublishableKey: string; rules: { cancelLateHours: number; insuranceRate: number; insuranceMinCents: number; basicCargoLimitCents: number } }>('/v1/config'),
    cities: () => get<{ city: string; province: string; lat: number; lng: number }[]>('/v1/cities'),
    // customer
    quote: (p: { pickup: PlaceValue; dropoff: PlaceValue; size: Size; declaredValueCents: number; insured: boolean; windowStart?: string; windowEnd?: string }) => post<Quote>('/v1/quotes', p),
    createOrder: (p: Record<string, unknown>) => post<Order>('/v1/orders', p),
    orders: () => get<Order[]>('/v1/orders'),
    order: (id: string) => get<Order>(`/v1/orders/${id}`),
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
    addDocument: (p: Record<string, unknown>) => post('/v1/driver/documents', p),
    saveTax: (p: { type: 'sin' | 'bn'; number: string; gstNumber?: string }) => post<DriverOverview>('/v1/driver/tax', p),
    quiz: () => get<{ id: string; question: string; options: string[] }[]>('/v1/driver/quiz'),
    agreement: (answers: Record<string, number>) => post<DriverOverview>('/v1/driver/agreement', { answers }),
    identity: () => post<{ url: string }>('/v1/driver/identity'),
    payouts: () => post<{ url: string }>('/v1/driver/payouts'),
    refreshPayouts: () => post<DriverOverview>('/v1/driver/payouts/refresh'),
    submitDriver: () => post<DriverOverview>('/v1/driver/submit'),
    location: (lat: number, lng: number) => post('/v1/driver/location', { lat, lng }),
    earnings: () => get<Earnings>('/v1/driver/earnings'),
    trips: () => get<Trip[]>('/v1/driver/trips'),
    createTrip: (p: { stops: { city: string; province: string }[]; departAt: string; space: string }) => post<Trip>('/v1/driver/trips', p),
    cancelTrip: (id: string) => call('DELETE', `/v1/driver/trips/${id}`),
    feed: () => get<{ status: string; tier?: string; items: Order[] }>('/v1/driver/feed'),
    jobs: (scope: 'active' | 'history') => get<Order[]>(`/v1/driver/jobs?scope=${scope}`),
    driverOrder: (id: string) => get<Order>(`/v1/driver/orders/${id}`),
    take: (id: string) => post<Order>(`/v1/driver/orders/${id}/take`),
    offer: (id: string, amountCents: number) => post<Order>(`/v1/driver/orders/${id}/offer`, { amountCents }),
    answerCounter: (id: string, action: 'accept' | 'decline') => post<Order>(`/v1/driver/orders/${id}/counter`, { action }),
    declineRequest: (id: string) => post(`/v1/driver/orders/${id}/decline-request`),
    enRoute: (id: string) => post<Order>(`/v1/driver/orders/${id}/en-route`),
    pickup: (id: string, photoKeys: string[], note?: string, pos?: { lat: number; lng: number }) => post<Order>(`/v1/driver/orders/${id}/pickup`, { photoKeys, note, ...pos }),
    depart: (id: string) => post<Order>(`/v1/driver/orders/${id}/depart`),
    deliver: (id: string, pin: string, photoKeys: string[] = []) => post<Order>(`/v1/driver/orders/${id}/deliver`, { pin, photoKeys }),
    drop: (id: string, reason: string) => post(`/v1/driver/orders/${id}/drop`, { reason }),
  };
}

export type Api = ReturnType<typeof createApi>;
