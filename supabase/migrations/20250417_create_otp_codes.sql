-- Migration: Create OTP codes table for custom authentication flows
CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,           -- 'signup' or 'reset'
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite index for lookup performance
CREATE INDEX IF NOT EXISTS idx_otp_codes_lookup
  ON otp_codes(email, purpose, expires_at DESC);