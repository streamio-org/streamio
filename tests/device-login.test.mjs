#!/usr/bin/env node
/**
 * Unit tests for the TV sign-in codes (`auth/deviceLogin.ts`).
 *
 * Unlike the provider suites next door these need no network — but they cover
 * the same kind of failure, the kind that succeeds quietly. The user code is
 * generated in TypeScript, rendered on a television, retyped by a human, and
 * normalized *again* by `public/scripts/tv.js` before it comes back. If those
 * two normalizers ever disagree about the alphabet or the grouping, every
 * pairing fails with "that code has expired" and nothing anywhere logs why.
 *
 * Usage:
 *   npm run test:device-login
 *
 * Requires a build first (`npm run build`); the npm script does it for you.
 */

import { readFileSync } from "node:fs";
import {
  DEVICE_APPROVED_TTL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  deviceCodeMatches,
  deviceKey,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  normalizeUserCode,
} from "../dist/auth/deviceLogin.js";

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n      expected: ${expected}\n      actual:   ${actual}`);
  }
}

console.log("user codes");

check("are XXXX-XXXX and survive their own normalizer", () => {
  for (let i = 0; i < 500; i++) {
    const code = generateUserCode();
    assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `malformed code: ${code}`);
    // The generator must only ever emit codes the parser round-trips, or a
    // perfectly typed code is rejected.
    assertEqual(normalizeUserCode(code), code, `not stable under normalize: ${code}`);
  }
});

check("avoid the glyphs people misread off a screen", () => {
  // O/0, I/1/L, S/5, Z/2, B/8 — the pairs that cost a retry when someone is
  // reading from three metres away. (Q survives: O is the one it pairs with,
  // and O is gone.)
  const ambiguous = "O0IL1S5Z2B8";
  for (let i = 0; i < 500; i++) {
    const code = generateUserCode().replace("-", "");
    const found = code.split("").filter((ch) => ambiguous.includes(ch));
    assertEqual(found.length, 0, `ambiguous glyph in ${code}: ${found}`);
  }
});

check("forgive how the code is actually typed", () => {
  // Whatever a phone keyboard does to it, the same record must be found.
  for (const typed of [
    "K7RQ-4M3P",
    "k7rq-4m3p",
    "K7RQ4M3P",
    " K7RQ 4M3P ",
    "K7RQ--4M3P",
    "K7RQ-4M3P\n",
  ]) {
    assertEqual(normalizeUserCode(typed), "K7RQ-4M3P", `normalize(${JSON.stringify(typed)})`);
  }
});

check("drop characters the generator can never emit", () => {
  // Someone reading "0" for "Q" or "1" for "7" gets a code that resolves to a
  // *different* record rather than an error — so the normalizer stripping them
  // is load-bearing, not cosmetic.
  assertEqual(normalizeUserCode("K7RQ-4M3P0"), "K7RQ-4M3P", "trailing zero");
  assertEqual(normalizeUserCode("!!K7RQ@@4M3P##"), "K7RQ-4M3P", "punctuation");
});

check("the browser's normalizer agrees with the server's", () => {
  // The one that drifts silently: two copies of the same alphabet in two
  // languages, one of which nobody recompiles.
  const tvJs = readFileSync(new URL("../public/scripts/tv.js", import.meta.url), "utf8");
  const match = tvJs.match(/const ALPHABET = '([^']+)'/);
  assert(match, "could not find ALPHABET in public/scripts/tv.js");

  // Recover the server's alphabet from its own output rather than exporting it
  // — this asserts on what codes are actually made of.
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    for (const ch of generateUserCode().replace("-", "")) seen.add(ch);
  }

  const browser = new Set(match[1]);
  for (const ch of seen) {
    assert(browser.has(ch), `server emits '${ch}', which tv.js would strip out`);
  }
});

console.log("device codes");

check("are long, random and never equal", () => {
  const a = generateDeviceCode();
  const b = generateDeviceCode();
  assert(a !== b, "two device codes collided");
  assert(a.length >= 40, `device code too short: ${a.length} chars`);
  assert(/^[A-Za-z0-9_-]+$/.test(a), `not URL-safe: ${a}`);
});

check("match only themselves", () => {
  const code = generateDeviceCode();
  const hash = hashDeviceCode(code);

  assert(deviceCodeMatches(code, hash), "a device code did not match its own hash");
  assert(!deviceCodeMatches(generateDeviceCode(), hash), "a foreign device code matched");
  // Comparison is constant-time over equal-length buffers; a junk candidate
  // must be rejected rather than throw.
  assert(!deviceCodeMatches("", hash), "an empty device code matched");
  assert(!deviceCodeMatches("not-base64url!!", hash), "a malformed device code matched");
});

console.log("record lifetime");

check("an approved code lives no longer than a pending one", () => {
  // Once approved, the record is worth a session to whoever holds the device
  // code. Widening this window instead of narrowing it is the mistake.
  assert(
    DEVICE_APPROVED_TTL_SECONDS <= DEVICE_CODE_TTL_SECONDS,
    `approved TTL (${DEVICE_APPROVED_TTL_SECONDS}s) exceeds pending TTL (${DEVICE_CODE_TTL_SECONDS}s)`,
  );
});

check("keys are namespaced by the normalized code", () => {
  assertEqual(deviceKey(normalizeUserCode("k7rq4m3p")), "auth:device:K7RQ-4M3P", "deviceKey");
});

console.log(failures === 0 ? "\nAll device-login tests passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
