// Row types and the shapes the API returns. Viewer-specific fields (PIN,
// phone numbers) are only included for the side that is allowed to see them.
import type { Place } from '../lib/geo.js';

export interface UserRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  lang: string;
  is_admin: boolean;
  terms_accepted_at: string | null;
  stripe_customer_id: string | null;
  payment_method_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  rating_sum: number;
  rating_count: number;
  blocked: boolean;
  created_at: string;
  email_verified_at: string | null;
  email_token_hash: string | null;
  email_token_expires: string | null;
  email_alerts: boolean;
}

export interface DriverRow {
  user_id: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'paused';
  tier: 'basic' | 'pro';
  car_hauler: boolean;
  legal_name: string | null;
  address: string | null;
  date_of_birth: string | null;
  home_city: string | null;
  home_lat: number | null;
  home_lng: number | null;
  radius_km: number;
  quiet_from: string | null;
  quiet_to: string | null;
  tax_id_type: string | null;
  tax_id_enc: string | null;
  tax_id_last3: string | null;
  gst_number: string | null;
  stripe_account_id: string | null;
  payouts_enabled: boolean;
  identity_status: string;
  identity_session_id: string | null;
  background_status: string;
  agreement_accepted_at: string | null;
  quiz_passed_at: string | null;
  cargo_limit_cents: number;
  completed_jobs: number;
  paused_reason: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  last_lat: number | null;
  last_lng: number | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface OrderRow {
  id: string;
  number: number;
  client_id: string;
  driver_id: string | null;
  trip_id: string | null;
  requested_driver_id: string | null;
  request_expires_at: string | null;
  pickup: Place;
  dropoff: Place;
  intercity: boolean;
  distance_km: number;
  size: 'S' | 'M' | 'L' | 'XL' | 'AUTO';
  description: string;
  photo_keys: string[];
  declared_value_cents: number;
  insured: boolean;
  insurance_cents: number;
  window_start: string;
  window_end: string;
  delivery_start: string | null;
  delivery_end: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  price_cents: number;
  agreed_cents: number | null;
  client_fee_cents: number | null;
  driver_fee_cents: number | null;
  charged_cents: number | null;
  status: 'open' | 'agreed' | 'picked_up' | 'in_transit' | 'delivered' | 'cancelled';
  pro_until: string;
  broadcast_at: string | null;
  pin: string | null;
  payment_intent_id: string | null;
  charge_id: string | null;
  charged_at: string | null;
  payment_error: string | null;
  transfer_id: string | null;
  paid_out_at: string | null;
  payout_held_reason: string | null;
  en_route_at: string | null;
  picked_up_at: string | null;
  pin_attempts: number;
  departed_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  refund_cents: number | null;
  driver_comp_cents: number | null;
  platform_comp_cents: number | null;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_pos_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OfferRow {
  id: string;
  order_id: string;
  driver_id: string;
  by: 'client' | 'driver';
  amount_cents: number;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired';
  created_at: string;
}

export const rating = (sum: number, count: number) => (count ? Math.round((sum / count) * 10) / 10 : null);
export const firstName = (name: string | null) => (name ?? '').trim().split(/\s+/)[0] || null;

export function userDto(u: UserRow, driver?: DriverRow | null) {
  return {
    id: u.id,
    phone: u.phone,
    name: u.name,
    email: u.email,
    emailVerified: Boolean(u.email && u.email_verified_at),
    emailAlerts: u.email_alerts,
    lang: u.lang,
    isAdmin: u.is_admin,
    termsAccepted: Boolean(u.terms_accepted_at),
    card: u.payment_method_id ? { brand: u.card_brand, last4: u.card_last4 } : null,
    rating: rating(u.rating_sum, u.rating_count),
    ratingCount: u.rating_count,
    driver: driver ? driverSelfDto(driver) : null,
  };
}

export function driverSelfDto(d: DriverRow) {
  return {
    status: d.status,
    tier: d.tier,
    carHauler: d.car_hauler,
    legalName: d.legal_name,
    address: d.address,
    dateOfBirth: d.date_of_birth,
    homeCity: d.home_city,
    home: d.home_lat !== null && d.home_lng !== null ? { lat: d.home_lat, lng: d.home_lng } : null,
    radiusKm: d.radius_km,
    quietFrom: d.quiet_from,
    quietTo: d.quiet_to,
    taxInfo: d.tax_id_type ? { type: d.tax_id_type, last3: d.tax_id_last3, gst: d.gst_number } : null,
    payoutsEnabled: d.payouts_enabled,
    payoutsStarted: Boolean(d.stripe_account_id),
    identityStatus: d.identity_status,
    backgroundStatus: d.background_status,
    agreementAccepted: Boolean(d.agreement_accepted_at),
    quizPassed: Boolean(d.quiz_passed_at),
    cargoLimitCents: d.cargo_limit_cents,
    completedJobs: d.completed_jobs,
    pausedReason: d.paused_reason,
    submittedAt: d.submitted_at,
    approvedAt: d.approved_at,
  };
}

export type Viewer = 'client' | 'driver' | 'admin' | 'prospect';

export interface OrderExtras {
  offers?: OfferRow[];
  driver?: { name: string | null; rating: number | null; tier: string; vehicle: string | null; completedJobs: number } | null;
  client?: { name: string | null; rating: number | null } | null;
  photos?: { stage: string; url: string; createdAt: string }[];
  urls?: (key: string) => string;
}

export function orderDto(o: OrderRow, viewer: Viewer, x: OrderExtras = {}) {
  const base = {
    id: o.id,
    number: o.number,
    status: o.status,
    pickup: viewer === 'prospect' ? { city: o.pickup.city, province: o.pickup.province, address: areaOnly(o.pickup.address), lat: round2(o.pickup.lat), lng: round2(o.pickup.lng) } : o.pickup,
    dropoff: viewer === 'prospect' ? { city: o.dropoff.city, province: o.dropoff.province, address: areaOnly(o.dropoff.address), lat: round2(o.dropoff.lat), lng: round2(o.dropoff.lng) } : o.dropoff,
    intercity: o.intercity,
    distanceKm: o.distance_km,
    size: o.size,
    description: o.description,
    photos: (x.urls ? o.photo_keys.map((k) => x.urls!(k)) : []) as string[],
    declaredValueCents: o.declared_value_cents,
    insured: o.insured,
    windowStart: o.window_start,
    windowEnd: o.window_end,
    deliveryStart: o.delivery_start ?? null,
    deliveryEnd: o.delivery_end ?? null,
    priceCents: o.price_cents,
    agreedCents: o.agreed_cents,
    tripId: o.trip_id,
    requestedDriver: Boolean(o.requested_driver_id),
    requestExpiresAt: o.request_expires_at,
    proUntil: o.pro_until,
    enRouteAt: o.en_route_at,
    pickedUpAt: o.picked_up_at,
    departedAt: o.departed_at,
    deliveredAt: o.delivered_at,
    cancelledAt: o.cancelled_at,
    cancelledBy: o.cancelled_by,
    createdAt: o.created_at,
    offers: (x.offers ?? []).map((f) => ({ id: f.id, by: f.by, amountCents: f.amount_cents, status: f.status, createdAt: f.created_at, mine: undefined as boolean | undefined, driverId: viewer === 'admin' ? f.driver_id : undefined })),
    driver: x.driver ?? null,
    client: x.client ?? null,
    pickupPhotos: x.photos ?? [],
  };
  if (viewer === 'client' || viewer === 'admin') {
    return {
      ...base,
      pin: o.status === 'delivered' || o.status === 'cancelled' ? null : o.pin,
      recipientName: o.recipient_name,
      recipientPhone: o.recipient_phone,
      insuranceCents: o.insurance_cents,
      clientFeeCents: o.client_fee_cents,
      chargedCents: o.charged_cents,
      paymentError: o.payment_error,
      refundCents: o.refund_cents,
      driverPosition: o.driver_lat !== null && (o.status === 'agreed' || o.status === 'picked_up' || o.status === 'in_transit') ? { lat: o.driver_lat, lng: o.driver_lng, at: o.driver_pos_at } : null,
      ...(viewer === 'admin'
        ? { clientId: o.client_id, driverId: o.driver_id, paymentIntentId: o.payment_intent_id, transferId: o.transfer_id, payoutHeldReason: o.payout_held_reason, driverCompCents: o.driver_comp_cents, platformCompCents: o.platform_comp_cents, driverFeeCents: o.driver_fee_cents }
        : {}),
    };
  }
  return {
    ...base,
    recipientName: viewer === 'driver' ? o.recipient_name : null,
    driverFeeCents: o.driver_fee_cents,
    driverNetCents: o.agreed_cents !== null ? o.agreed_cents - (o.driver_fee_cents ?? 0) : null,
    driverCompCents: viewer === 'driver' ? o.driver_comp_cents : null,
    paidOutAt: viewer === 'driver' ? o.paid_out_at : null,
    payoutHeldReason: viewer === 'driver' ? o.payout_held_reason : null,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Before a driver commits, show the street/area but not the house number. */
function areaOnly(address: string): string {
  return address.replace(/^\s*\d+[\w-]*\s+/, '').replace(/\b(?:apt|unit|suite|#)\s*\S+/gi, '').trim();
}
