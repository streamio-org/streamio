import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The TV sign-in ("device") flow.
 *
 * Android TV devices generally ship with no browser and no handler for `https`
 * ACTION_VIEW at all, so the app's normal OAuth path — hand a consent URL to a
 * Custom Tab and wait for `streamio://auth` — cannot start: the launch throws
 * ActivityNotFoundException and the button looks broken. The same is true of
 * any headless-ish client, which is why the shape here is the one YouTube and
 * Netflix use on the same hardware.
 *
 * Two secrets, deliberately asymmetric:
 *
 *   - the **user code** is short and legible from three metres. It is the only
 *     thing shown on the television, and it is *not* bearer material: knowing
 *     it lets you approve a pairing, never collect one.
 *   - the **device code** is long, random, and never leaves the TV. It is what
 *     the app proves to collect the tokens, so a bystander who reads the user
 *     code off the screen still cannot claim the session.
 *
 * The record lives in Redis under the user code, expires on its own, and is
 * burned the moment it is redeemed.
 */

/** How long an unclaimed code stays good. Long enough to find your phone. */
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;

/**
 * How long an *approved* record survives before it is redeemed.
 *
 * Shorter than the pending TTL on purpose: once a real user has approved it,
 * the record is worth a session to whoever holds the device code, and the TV
 * is polling every few seconds anyway. It bounds the window in which a stolen
 * device code is worth anything.
 */
export const DEVICE_APPROVED_TTL_SECONDS = 2 * 60;

/** What we ask the app to wait between polls. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/**
 * Unambiguous on a television: no O/0, I/1/L, S/5, Z/2, B/8. Someone is going
 * to read this off a screen across a room and type it on a phone, and a code
 * that needs a second attempt is a code that reads as broken.
 */
const USER_CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY3467";
const USER_CODE_GROUPS = 2;
const USER_CODE_GROUP_SIZE = 4;

export type DeviceLoginStatus = "pending" | "approved";

export interface DeviceLoginRecord {
  /** SHA-256 of the device code. The code itself is never stored. */
  deviceCodeHash: string;
  status: DeviceLoginStatus;
  /** Set once a signed-in browser has approved the pairing. */
  userId: string | null;
  /** For the approval page, so the user can see what they're signing in. */
  label: string | null;
}

export function deviceKey(userCode: string): string {
  return `auth:device:${userCode}`;
}

/**
 * `K7RQ-4M3P`. Roughly 24^8 ≈ 1.1e11 possibilities, narrowed by however many
 * codes are live at once — which is why claiming one still requires a signed-in
 * session and redeeming one still requires the device code.
 */
export function generateUserCode(): string {
  const bytes = randomBytes(USER_CODE_GROUPS * USER_CODE_GROUP_SIZE);
  let out = "";

  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % USER_CODE_GROUP_SIZE === 0) out += "-";
    out += USER_CODE_ALPHABET[bytes[i]! % USER_CODE_ALPHABET.length];
  }

  return out;
}

export function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

export function hashDeviceCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * Accepts what someone actually types: lowercase, spaces, a missing or extra
 * dash. Anything outside the alphabet is dropped rather than rejected, so a
 * pasted code with a stray character still resolves.
 */
export function normalizeUserCode(input: string): string {
  const cleaned = input
    .toUpperCase()
    .split("")
    .filter((ch) => USER_CODE_ALPHABET.includes(ch))
    .join("");

  const groups: string[] = [];
  for (let i = 0; i < cleaned.length; i += USER_CODE_GROUP_SIZE) {
    groups.push(cleaned.slice(i, i + USER_CODE_GROUP_SIZE));
  }

  return groups.join("-");
}

/** Constant-time, so a poller can't walk the hash out of the timing. */
export function deviceCodeMatches(candidate: string, expectedHash: string): boolean {
  const a = Buffer.from(hashDeviceCode(candidate), "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
