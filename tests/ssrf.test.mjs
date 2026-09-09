#!/usr/bin/env node
/**
 * Unit tests for the outbound-URL guard (`core/utils/ssrf.ts`).
 *
 * `/api/cast-proxy` and `POST /api/episodes/:id/video` both fetch a URL the
 * caller supplies, so this module is the only thing between an unauthenticated
 * request and everything the container can reach that the internet cannot —
 * the cloud metadata service on 169.254.169.254, `redis`/`db` on the compose
 * network, anything on localhost.
 *
 * That makes the interesting failure a *silent* one: a range that looks
 * blocked but isn't (a mistyped mask, an IPv6 spelling of a v4 address, a
 * redirect that never gets re-checked) fails open and nothing logs it. Hence a
 * table of addresses rather than a smoke test.
 *
 * No network is used — DNS is only touched for the hostname cases, which use
 * `localhost` and an address literal.
 *
 * Usage:
 *   npm run test:ssrf
 *
 * Requires a build first (`npm run build`); the npm script does it for you.
 */

import http from "node:http";
import axios from "axios";
import {
  BlockedUrlError,
  assertFetchableUrl,
  clearHostCache,
  guardedAgents,
  isPrivateAddress,
  looksLikeUrl,
  parseHttpUrl,
  safeFetch,
} from "../dist/core/utils/ssrf.js";

let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertBlocked(url, message) {
  try {
    await assertFetchableUrl(url);
  } catch (err) {
    if (err instanceof BlockedUrlError) return;
    throw new Error(`${message} — threw ${err?.name}: ${err?.message}`);
  }
  throw new Error(message);
}

// Nothing below should be affected by the operator escape hatch, so make sure
// a stray environment can't quietly turn every assertion into a no-op.
delete process.env.ALLOW_PRIVATE_UPSTREAM;

console.log("address classification");

await check("blocks loopback, private, link-local, multicast and reserved v4", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.7",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254", // AWS/GCP/Azure metadata
    "100.64.0.1",
    "192.0.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
  ];
  for (const ip of blocked) {
    assert(isPrivateAddress(ip), `${ip} was not treated as private`);
  }
});

await check("allows ordinary public v4", () => {
  for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "192.169.0.1"]) {
    assert(!isPrivateAddress(ip), `${ip} was wrongly treated as private`);
  }
});

await check("blocks the v6 spellings of the same addresses", () => {
  const blocked = [
    "::1",                    // loopback
    "::",                     // unspecified
    "::ffff:127.0.0.1",       // v4-mapped loopback
    "::ffff:169.254.169.254", // v4-mapped metadata
    "::ffff:10.0.0.1",
    "fc00::1",                // unique-local
    "fd12:3456::1",
    "fe80::1",                // link-local
    "ff02::1",                // multicast
    "64:ff9b::7f00:1",        // NAT64 of 127.0.0.1
    "2002:7f00:0001::",       // 6to4 of 127.0.0.1
  ];
  for (const ip of blocked) {
    assert(isPrivateAddress(ip), `${ip} was not treated as private`);
  }
});

await check("allows ordinary public v6", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert(!isPrivateAddress(ip), `${ip} was wrongly treated as private`);
  }
});

await check("fails closed on anything that isn't an address", () => {
  for (const junk of ["", "not-an-ip", "999.999.999.999", "::gggg"]) {
    assert(isPrivateAddress(junk), `${JSON.stringify(junk)} was treated as public`);
  }
});

console.log("\nURL parsing");

await check("rejects every scheme but http(s)", async () => {
  for (const url of [
    "file:///etc/passwd",
    "gopher://example.com/",
    "ftp://example.com/x",
    "data:text/plain,hi",
    "javascript:alert(1)",
  ]) {
    let threw = false;
    try {
      parseHttpUrl(url);
    } catch (err) {
      threw = err instanceof BlockedUrlError;
    }
    assert(threw, `${url} was accepted`);
  }
});

await check("rejects relative and malformed URLs", () => {
  for (const url of ["", "   ", "/just/a/path", "http://", 42, null, undefined]) {
    let threw = false;
    try {
      parseHttpUrl(url);
    } catch (err) {
      threw = err instanceof BlockedUrlError;
    }
    assert(threw, `${JSON.stringify(url)} was accepted`);
  }
});

await check("accepts a plain https URL", () => {
  const url = parseHttpUrl("  https://vixcloud.co/playlist/12345?token=x  ");
  assert(url.hostname === "vixcloud.co", `unexpected host: ${url.hostname}`);
});

console.log("\nend-to-end URL checks");

await check("blocks the metadata service by literal address", async () => {
  await assertBlocked(
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "the metadata service was allowed",
  );
});

await check("blocks a bracketed IPv6 loopback literal", async () => {
  await assertBlocked("http://[::1]:6379/", "the v6 loopback literal was allowed");
});

await check("blocks a hostname that resolves to loopback", async () => {
  // "localhost" is the shape of the attack that a string-only check misses:
  // the URL names no address at all, the resolver supplies one.
  await assertBlocked("http://localhost:5432/", "localhost was allowed");
});

await check("blocks a port on a private LAN address", async () => {
  await assertBlocked("http://192.168.1.10:8080/admin", "a LAN address was allowed");
});

console.log("\nURL-shaped strings");

await check("recognises the slash-less http(s) form", () => {
  // `new URL("https:169.254.169.254/x")` really is that host — for a special
  // scheme the WHATWG parser does not require the slashes. A shape test that
  // only looks for "//" walks straight past it.
  for (const value of [
    "https:169.254.169.254/latest/meta-data/",
    "http:127.0.0.1:6379/",
    "https://example.com/",
    "//cdn.example.com/x.m3u8",
  ]) {
    assert(looksLikeUrl(value), `${value} was not recognised as a URL`);
  }
});

await check("does not mistake ids and labels for URLs", () => {
  // These travel in the same object as `src` and must not be fetched — or,
  // worse, rejected, which would 400 an ordinary playback request.
  for (const value of ["tv-1396#s1e2", "movie-603", "Vidcloud: HD", "channel-123", "1080p"]) {
    assert(!looksLikeUrl(value), `${value} was treated as a URL`);
  }
});

await check("blocks the slash-less spelling end to end", async () => {
  await assertBlocked("https:169.254.169.254/latest/", "the slash-less metadata URL was allowed");
});

console.log("\nthe socket is pinned to what was checked");

// Everything below needs a real listener: the point is not that a URL is
// refused on paper but that no byte of an internal response comes back.
const internal = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("INTERNAL-ONLY");
});
await new Promise((r) => internal.listen(0, "127.0.0.1", r));
const internalPort = internal.address().port;

const redirector = http.createServer((_req, res) => {
  res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/secret` });
  res.end();
});
await new Promise((r) => redirector.listen(0, "127.0.0.1", r));
const redirectorPort = redirector.address().port;

await check("safeFetch refuses a private target", async () => {
  let threw = false;
  try {
    await safeFetch(`http://127.0.0.1:${internalPort}/secret`);
  } catch (err) {
    threw = err instanceof BlockedUrlError;
  }
  assert(threw, "safeFetch read an internal service");
});

await check("axios with guardedAgents refuses a private target", async () => {
  // The agents are the whole guard for axios, which follows redirects itself.
  // Without them the route-level check is the only thing standing here.
  let body = null;
  try {
    body = (await axios.get(`http://127.0.0.1:${internalPort}/secret`, {
      ...guardedAgents,
      timeout: 3000,
    })).data;
  } catch {
    /* expected */
  }
  assert(body === null, `guarded axios read an internal service: ${body}`);
});

await check("a redirect into a private address is refused mid-chain", async () => {
  // The hop that matters is the second one. axios follows it without asking
  // anyone, so the refusal has to come from the socket.
  let body = null;
  try {
    body = (await axios.get(`http://127.0.0.1:${redirectorPort}/e/1`, {
      ...guardedAgents,
      timeout: 3000,
    })).data;
  } catch {
    /* expected */
  }
  assert(body === null, `a redirect reached an internal service: ${body}`);
});

await check("a rebinding host never reaches the address it flips to", async () => {
  // The classic bypass of a check-then-fetch guard: TTL 0, first answer
  // public, second answer loopback. It works whenever the guard validates a
  // *name* and then hands that name to the fetch, because the fetch resolves
  // it a second time. Here resolution happens once, inside the guard, and the
  // socket gets the addresses that were checked — so the flip has nothing to
  // land on.
  const dns = await import("node:dns/promises");
  const real = dns.default.lookup;
  let lookups = 0;

  dns.default.lookup = async (host, opts) => {
    if (host !== "rebind.invalid") return real(host, opts);
    lookups++;
    const address = lookups === 1 ? "93.184.216.34" : "127.0.0.1";
    return opts?.all ? [{ address, family: 4 }] : { address, family: 4 };
  };

  try {
    for (const run of [
      () => safeFetch(`http://rebind.invalid:${internalPort}/secret`),
      () =>
        axios.get(`http://rebind.invalid:${internalPort}/secret`, {
          ...guardedAgents,
          timeout: 2000,
        }),
    ]) {
      lookups = 0;
      clearHostCache();

      let body = null;
      try {
        const res = await run();
        body = res.response ? await res.response.text() : res.data;
      } catch {
        /* expected: the connection goes to the public address and fails */
      }

      assert(body === null, `rebinding read an internal service: ${body}`);
      assert(lookups === 1, `resolved ${lookups} times — the second answer is the attack`);
    }
  } finally {
    dns.default.lookup = real;
  }
});

internal.close();
redirector.close();

console.log(failures === 0 ? "\nAll SSRF-guard tests passed." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
