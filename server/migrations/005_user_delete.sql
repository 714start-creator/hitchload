-- Admin can delete users. Users with money history are anonymised instead (kept for accounting and the CRA report).
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
