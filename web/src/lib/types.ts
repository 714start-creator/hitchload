// Shapes returned by the API (see server/src/services/dto.ts).
import type { PlaceValue } from './format';

export type Size = 'S' | 'M' | 'L' | 'XL' | 'AUTO';
export type OrderStatus = 'open' | 'agreed' | 'picked_up' | 'in_transit' | 'delivered' | 'cancelled';
export type DriverStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'paused';

export interface DriverSelf {
  status: DriverStatus;
  tier: 'basic' | 'pro';
  carHauler: boolean;
  legalName: string | null;
  address: string | null;
  dateOfBirth: string | null;
  homeCity: string | null;
  home: { lat: number; lng: number } | null;
  radiusKm: number;
  quietFrom: string | null;
  quietTo: string | null;
  taxInfo: { type: string; last3: string | null; gst: string | null } | null;
  payoutsEnabled: boolean;
  payoutsStarted: boolean;
  identityStatus: string;
  backgroundStatus: string;
  agreementAccepted: boolean;
  quizPassed: boolean;
  cargoLimitCents: number;
  completedJobs: number;
  pausedReason: string | null;
}

export interface Me {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  emailAlerts: boolean;
  lang: 'ru' | 'en';
  isAdmin: boolean;
  termsAccepted: boolean;
  card: { brand: string; last4: string } | null;
  rating: number | null;
  driver: DriverSelf | null;
}

export interface Offer {
  id: string;
  by: 'client' | 'driver';
  amountCents: number;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired';
  createdAt: string;
}

export interface Order {
  id: string;
  number: number;
  status: OrderStatus;
  pickup: PlaceValue;
  dropoff: PlaceValue;
  intercity: boolean;
  distanceKm: number;
  size: Size;
  description: string;
  photos: string[];
  declaredValueCents: number;
  insured: boolean;
  windowStart: string;
  windowEnd: string;
  priceCents: number;
  agreedCents: number | null;
  tripId: string | null;
  requestedDriver: boolean;
  requestExpiresAt: string | null;
  proUntil: string;
  enRouteAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  offers: Offer[];
  driver: { name: string | null; rating: number | null; tier: string; vehicle: string | null; completedJobs: number } | null;
  client: { name: string | null; rating: number | null } | null;
  pickupPhotos: { stage: string; url: string; createdAt: string }[];
  // customer view
  pin?: string | null;
  recipientName?: string | null;
  insuranceCents?: number;
  clientFeeCents?: number | null;
  chargedCents?: number | null;
  paymentError?: string | null;
  refundCents?: number | null;
  driverPosition?: { lat: number; lng: number; at: string } | null;
  // driver view
  driverNetCents?: number | null;
  driverCompCents?: number | null;
  paidOutAt?: string | null;
  payoutHeldReason?: string | null;
  eligibility?: Eligibility | null;
}

export interface Eligibility {
  visible: boolean;
  canTake: boolean;
  lockReason?: 'pro_window' | 'cargo_limit';
  opensAt?: string;
  requestedToMe: boolean;
  onMyTrip: boolean;
  distanceToPickupKm: number | null;
}

export interface Stop {
  city: string;
  province: string;
  lat: number;
  lng: number;
}

export interface TripOption {
  tripId: string;
  driver: { name: string | null; rating: number | null; tier: string; vehicle: string; completedJobs: number };
  stops: Stop[];
  departAt: string;
  pickupEta: string;
  dropoffEta: string;
  space: string;
  priceCents: number;
  fitsWindow: boolean;
}

export interface Quote {
  distanceKm: number;
  intercity: boolean;
  suggestedPriceCents: number;
  insuranceCents: number;
  breakdown: { driverPriceCents: number; clientFeeCents: number; insuranceCents: number; clientTotalCents: number; driverFeeCents: number; driverNetCents: number };
  rates: { clientFee: number; driverFee: number; insurance: number; insuranceMinCents: number };
  trips: TripOption[];
}

export interface CancelPreview {
  tier: 'free' | 'early' | 'late' | 'no_show';
  driverCents: number;
  platformCents: number;
  keptFeeCents: number;
  refundCents: number;
  chargedCents: number;
}

export interface Message {
  id: number;
  from: 'me' | 'them' | 'system';
  body: string;
  contactHidden?: boolean;
  createdAt: string;
}

export interface Check {
  key: string;
  done: boolean;
  requiredToSubmit: boolean;
  requiredToApprove: boolean;
}

export interface DriverOverview {
  driver: DriverSelf;
  vehicles: { id: string; type: string; make: string; model: string; year: number; plate: string; maxSize: Size; needsFederalSfc: boolean }[];
  documents: { id: string; kind: string; status: 'pending' | 'approved' | 'rejected'; insurer: string | null; expiresOn: string | null; note: string | null }[];
  checklist: Check[];
}

export interface Trip {
  id: string;
  stops: Stop[];
  departAt: string;
  space: string;
  maxSize: Size;
  status: string;
  note?: string | null;
  matches?: { loads: number; shippersNotified: number };
}

export interface TripLoad extends Order {
  pickupEta: string;
  fitsWindow: boolean;
}

export interface RouteAlert {
  id: string;
  from: Stop;
  to: Stop;
  size: Size | null;
  dateFrom: string | null;
  dateTo: string | null;
  active: boolean;
  createdAt: string;
}

export interface PublicLoad {
  number: number;
  from: { city: string; province: string };
  to: { city: string; province: string };
  intercity: boolean;
  distanceKm: number;
  size: Size;
  windowStart: string;
  windowEnd: string;
  priceCents: number;
  postedAt: string;
}

export interface SiteConfig {
  brand: string;
  supportEmail: string;
  stripePublishableKey: string;
  vapidPublicKey: string | null;
  googleMapsKey: string | null;
  mapTilesUrl: string;
  mapAttribution: string;
  devCodes: boolean;
  fakePayments?: boolean;
}

export interface City {
  city: string;
  province: string;
  lat: number;
  lng: number;
}

export interface Notification {
  id: number;
  type: string;
  orderId: string | null;
  title: string;
  body: string;
  link?: string | null;
  read: boolean;
  createdAt: string;
}

export interface Earnings {
  todayCents: number;
  weekCents: number;
  yearCents: number;
  heldCents: number;
  feesYearCents: number;
  jobsYear: number;
}
