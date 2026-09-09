-- ============================================================
-- 004_verification_token_expiry.sql
--
-- Email-verification tokens used to be single-use but eternal: unlike
-- reset_token, which has always had reset_token_exp checked against NOW(),
-- verification_token stayed valid until someone redeemed it. A link sitting in
-- an old inbox (or an old mail archive, or a forwarded message) was still
-- worth a verification months later.
--
-- That matters more than it used to, because email_verified is now what
-- separates an admin from anyone who typed the admin's address into the
-- registration form (see auth/middleware.ts, createRequireAdmin).
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token_exp TIMESTAMPTZ;

-- Tokens already in flight have no expiry recorded. Give them a full window
-- from this deploy rather than expiring them on the spot — the user did
-- nothing wrong, and POST /api/auth/verify-email/resend is the remedy either
-- way.
UPDATE users
   SET verification_token_exp = NOW() + INTERVAL '24 hours'
 WHERE verification_token IS NOT NULL
   AND verification_token_exp IS NULL;
