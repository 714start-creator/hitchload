-- Uploaded files kept in the database when no S3 bucket is configured
-- (test servers whose disk is wiped on every restart, e.g. Render free).
CREATE TABLE stored_files (
  key          text PRIMARY KEY,
  content_type text NOT NULL,
  body         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
