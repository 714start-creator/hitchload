-- Vehicle photos (side view; rear view with the plate) are required for drivers.
ALTER TYPE doc_kind ADD VALUE IF NOT EXISTS 'vehicle_side';
ALTER TYPE doc_kind ADD VALUE IF NOT EXISTS 'vehicle_rear';
-- A personal auto policy is accepted for Basic drivers when they confirm it may not cover paid deliveries.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS risk_ack_at timestamptz;
