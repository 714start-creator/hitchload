-- Website launch: route alerts for shippers, trip matches, email confirmation, web push.

-- "Tell me when a driver is going from A to B"
CREATE TABLE route_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin       jsonb NOT NULL,          -- {city, province, lat, lng}
  destination  jsonb NOT NULL,
  size         size_class,              -- NULL = any
  date_from    date,                    -- NULL = from today
  date_to      date,                    -- NULL = no end
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX route_alerts_active ON route_alerts(active) WHERE active;
CREATE INDEX route_alerts_user ON route_alerts(user_id);

-- who has already been told about which trip (no duplicate notifications)
CREATE TABLE trip_matches (
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('alert', 'order')),
  target_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, kind, target_id)
);

-- drivers told about a load on one of their trips
CREATE TABLE load_matches (
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, driver_id)
);

ALTER TABLE users
  ADD COLUMN email_verified_at   timestamptz,
  ADD COLUMN email_token_hash    text,
  ADD COLUMN email_token_expires timestamptz,
  ADD COLUMN email_alerts        boolean NOT NULL DEFAULT true;

ALTER TABLE users ALTER COLUMN lang SET DEFAULT 'en';
