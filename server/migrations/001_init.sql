-- Poputka: initial schema. Money is stored in integer cents (CAD).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE driver_status AS ENUM ('draft', 'pending', 'approved', 'rejected', 'paused');
CREATE TYPE driver_tier AS ENUM ('basic', 'pro');
CREATE TYPE vehicle_type AS ENUM ('car', 'suv', 'pickup', 'van', 'cargo_van', 'box_truck', 'tow_truck', 'car_hauler');
CREATE TYPE doc_kind AS ENUM (
  'license_front', 'license_back', 'registration',
  'insurance_auto', 'insurance_endorsement', 'insurance_commercial', 'insurance_cargo', 'insurance_car_hauling',
  'safety_fitness_certificate', 'background_check', 'other'
);
CREATE TYPE review_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE size_class AS ENUM ('S', 'M', 'L', 'XL', 'AUTO');
CREATE TYPE order_status AS ENUM ('open', 'agreed', 'picked_up', 'in_transit', 'delivered', 'cancelled');
CREATE TYPE offer_by AS ENUM ('client', 'driver');
CREATE TYPE offer_status AS ENUM ('pending', 'accepted', 'declined', 'withdrawn', 'expired');
CREATE TYPE trip_status AS ENUM ('active', 'cancelled', 'completed');
CREATE TYPE dispute_status AS ENUM ('open', 'resolved');

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             text NOT NULL UNIQUE,
  name              text,
  email             text,
  lang              text NOT NULL DEFAULT 'ru',
  is_admin          boolean NOT NULL DEFAULT false,
  terms_accepted_at timestamptz,
  stripe_customer_id text,
  payment_method_id text,
  card_brand        text,
  card_last4        text,
  rating_sum        integer NOT NULL DEFAULT 0,
  rating_count      integer NOT NULL DEFAULT 0,
  blocked           boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  phone       text PRIMARY KEY,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_tokens_user ON push_tokens(user_id);

CREATE TABLE drivers (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status               driver_status NOT NULL DEFAULT 'draft',
  tier                 driver_tier NOT NULL DEFAULT 'basic',
  car_hauler           boolean NOT NULL DEFAULT false,
  legal_name           text,
  address              text,
  date_of_birth        date,
  home_city            text,
  home_lat             double precision,
  home_lng             double precision,
  radius_km            integer NOT NULL DEFAULT 40,
  quiet_from           text,          -- 'HH:MM' local time, nullable
  quiet_to             text,
  tax_id_type          text,          -- 'sin' | 'bn'
  tax_id_enc           text,          -- AES-256-GCM, never returned by the API
  tax_id_last3         text,
  gst_number           text,
  stripe_account_id    text,
  payouts_enabled      boolean NOT NULL DEFAULT false,
  identity_status      text NOT NULL DEFAULT 'none',   -- none | pending | verified | failed
  identity_session_id  text,
  background_status    text NOT NULL DEFAULT 'none',   -- none | pending | clear | failed
  agreement_accepted_at timestamptz,
  quiz_passed_at       timestamptz,
  cargo_limit_cents    integer NOT NULL DEFAULT 100000, -- set by admin from the cargo policy
  completed_jobs       integer NOT NULL DEFAULT 0,
  paused_reason        text,
  submitted_at         timestamptz,
  approved_at          timestamptz,
  last_lat             double precision,
  last_lng             double precision,
  last_seen_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id           uuid NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  type                vehicle_type NOT NULL,
  make                text NOT NULL,
  model               text NOT NULL,
  year                integer NOT NULL,
  plate               text NOT NULL,
  province            text NOT NULL DEFAULT 'AB',
  registered_weight_kg integer NOT NULL,
  cargo_length_cm     integer,
  has_trailer         boolean NOT NULL DEFAULT false,
  max_size            size_class NOT NULL DEFAULT 'L',
  equipment           text[] NOT NULL DEFAULT '{}',
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicles_driver ON vehicles(driver_id);

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id       uuid NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  kind            doc_kind NOT NULL,
  file_key        text NOT NULL,
  status          review_status NOT NULL DEFAULT 'pending',
  insurer         text,
  policy_number   text,
  coverage_cents  integer,
  expires_on      date,
  note            text,
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  reminded_30_at  timestamptz,
  reminded_7_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_driver ON documents(driver_id);
CREATE INDEX documents_expiry ON documents(expires_on) WHERE status = 'approved';

-- "I'm driving": a driver's published route with ordered stops.
CREATE TABLE trips (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   uuid NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  vehicle_id  uuid REFERENCES vehicles(id),
  stops       jsonb NOT NULL,          -- [{city, province, lat, lng}], length >= 2
  depart_at   timestamptz NOT NULL,
  space       text NOT NULL DEFAULT 'half', -- quarter | half | full
  max_size    size_class NOT NULL DEFAULT 'L',
  status      trip_status NOT NULL DEFAULT 'active',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trips_active ON trips(depart_at) WHERE status = 'active';

CREATE TABLE orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                bigserial UNIQUE,
  client_id             uuid NOT NULL REFERENCES users(id),
  driver_id             uuid REFERENCES drivers(user_id),
  trip_id               uuid REFERENCES trips(id),
  requested_driver_id   uuid REFERENCES drivers(user_id), -- booked onto a specific driver's trip
  request_expires_at    timestamptz,
  pickup                jsonb NOT NULL,  -- {address, city, province, lat, lng}
  dropoff               jsonb NOT NULL,
  intercity             boolean NOT NULL,
  distance_km           integer NOT NULL,
  size                  size_class NOT NULL,
  description           text NOT NULL DEFAULT '',
  photo_keys            text[] NOT NULL DEFAULT '{}',
  declared_value_cents  integer NOT NULL,
  insured               boolean NOT NULL DEFAULT false,
  insurance_cents       integer NOT NULL DEFAULT 0,
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL,
  recipient_name        text,
  recipient_phone       text,
  price_cents           integer NOT NULL,          -- client's asking price to the driver
  agreed_cents          integer,                   -- final price to the driver
  client_fee_cents      integer,                   -- 5% of agreed
  driver_fee_cents      integer,                   -- 5% of agreed
  charged_cents         integer,                   -- agreed + client fee + insurance
  status                order_status NOT NULL DEFAULT 'open',
  pro_until             timestamptz NOT NULL,      -- Pro-only visibility ends
  broadcast_at          timestamptz,               -- when non-Pro drivers were notified
  pin                   text,
  payment_intent_id     text,
  charge_id             text,
  charged_at            timestamptz,
  payment_error         text,
  transfer_id           text,
  paid_out_at           timestamptz,
  payout_held_reason    text,
  en_route_at           timestamptz,
  picked_up_at          timestamptz,
  pin_attempts          integer NOT NULL DEFAULT 0,
  departed_at           timestamptz,
  delivered_at          timestamptz,
  cancelled_at          timestamptz,
  cancelled_by          text,                      -- client | driver | admin | system
  cancel_reason         text,
  refund_cents          integer,
  driver_comp_cents     integer,
  platform_comp_cents   integer,
  driver_lat            double precision,
  driver_lng            double precision,
  driver_pos_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  CHECK (price_cents > 0),
  CHECK (declared_value_cents >= 0)
);
CREATE INDEX orders_client ON orders(client_id, created_at DESC);
CREATE INDEX orders_driver ON orders(driver_id, created_at DESC);
CREATE INDEX orders_open ON orders(created_at DESC) WHERE status = 'open';

CREATE TABLE offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id   uuid NOT NULL REFERENCES drivers(user_id),
  by          offer_by NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status      offer_status NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offers_order ON offers(order_id, created_at);
-- one price proposal per side per driver per order (the "one counter-offer" rule)
CREATE UNIQUE INDEX offers_once ON offers(order_id, driver_id, by);

CREATE TABLE order_events (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES users(id),
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order ON order_events(order_id, id);

CREATE TABLE order_photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage      text NOT NULL, -- pickup | delivery | damage
  file_key   text NOT NULL,
  lat        double precision,
  lng        double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_photos_order ON order_photos(order_id);

CREATE TABLE messages (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id   uuid REFERENCES users(id),  -- null = system message
  body        text NOT NULL,
  had_contact boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_order ON messages(order_id, id);

CREATE TABLE ratings (
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id   uuid NOT NULL REFERENCES users(id),
  stars        integer NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, from_user_id)
);

CREATE TABLE disputes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by    uuid NOT NULL REFERENCES users(id),
  reason       text NOT NULL,
  status       dispute_status NOT NULL DEFAULT 'open',
  resolution   text,
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX disputes_open ON disputes(created_at) WHERE status = 'open';

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  order_id   uuid REFERENCES orders(id) ON DELETE CASCADE,
  data       jsonb NOT NULL DEFAULT '{}',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications(user_id, id DESC);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  action     text NOT NULL,
  target     text,
  data       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Stripe webhook idempotency
CREATE TABLE processed_events (
  id         text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
