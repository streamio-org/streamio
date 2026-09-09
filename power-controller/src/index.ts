// power-controller — host-side watcher.
//
// Runs directly on the machine (not in Docker, unlike the rest of Streamio):
// the app container can flag "someone should shut this box down" but can
// never carry out an actual poweroff, since Wake-on-LAN wakes the physical
// host, not a container. This process is the other half — it polls the
// app's status endpoint and, when told to, powers off whatever host it's
// running on (Linux, Windows, or macOS).
import "dotenv/config";
import axios from "axios";
import { execFile } from "node:child_process";

const STREAMIO_URL = (process.env.STREAMIO_URL || "http://localhost:8080").replace(/\/+$/, "");
const POWER_SECRET = process.env.POWER_CONTROLLER_SECRET || "";
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS) || 30;
const DRY_RUN = process.env.DRY_RUN === "true";

// Optional: login-checker integration. If a user is logged into the host's
// desktop session, idle-triggered auto-shutdown is paused (manual/admin
// shutdown still always goes through). Left unset, this check is skipped
// entirely and behavior is unchanged from before login-checker existed.
const LOGIN_CHECK_URL = (process.env.LOGIN_CHECK_URL || "http://127.0.0.1:3001").replace(/\/+$/, "");
const LOGIN_CHECK_TOKEN = process.env.LOGIN_CHECK_TOKEN || "";

if (!POWER_SECRET) {
  console.error("POWER_CONTROLLER_SECRET is required (must match the app's env var).");
  process.exit(1);
}

// A single failed/timed-out check (a GC pause, a dropped loopback packet,
// anything transient) must not be enough to conclude "logged out" — that's
// an irreversible poweroff riding on one flaky HTTP request. Require several
// consecutive failures before honoring a negative result, so a momentary
// blip while someone is actually sitting at the machine doesn't shut it off
// under them.
const LOGIN_CHECK_FAILURE_THRESHOLD = 3;
let consecutiveLoginCheckFailures = 0;

async function checkLoginRaw(): Promise<boolean> {
  try {
    const res = await axios.get(LOGIN_CHECK_URL, {
      headers: { "X-auth": LOGIN_CHECK_TOKEN },
      timeout: 3_000,
    });
    return res.status === 200 && res.data?.status === "online";
  } catch {
    // Unreachable (service not running, or the request timed out).
    return false;
  }
}

async function isUserLoggedIn(): Promise<boolean> {
  if (!LOGIN_CHECK_TOKEN) return false;

  const online = await checkLoginRaw();
  if (online) {
    consecutiveLoginCheckFailures = 0;
    return true;
  }

  consecutiveLoginCheckFailures++;
  if (consecutiveLoginCheckFailures < LOGIN_CHECK_FAILURE_THRESHOLD) {
    console.log(
      `[power-controller] login-check failed (${consecutiveLoginCheckFailures}/${LOGIN_CHECK_FAILURE_THRESHOLD}) — not acting on it yet.`
    );
    return true; // treat as still logged in until the threshold is hit
  }
  return false;
}

interface PowerStatus {
  shouldShutdown: boolean;
  reason: "manual" | "idle" | null;
  enabled: boolean;
  idleSeconds: number;
  uptimeSeconds: number;
}

let triggered = false;

async function pollOnce(): Promise<void> {
  if (triggered) return;

  let status: PowerStatus;
  try {
    const res = await axios.get<PowerStatus>(`${STREAMIO_URL}/internal/power/status`, {
      headers: { "X-Power-Secret": POWER_SECRET },
      timeout: 10_000,
    });
    status = res.data;
  } catch (err: any) {
    console.error(`[power-controller] status check failed: ${err.message}`);
    return;
  }

  if (!status.shouldShutdown) return;

  if (status.reason === "idle" && (await isUserLoggedIn())) {
    console.log("[power-controller] idle shutdown skipped — user is logged into the host.");
    return;
  }

  triggered = true;
  console.log(
    `[power-controller] shutdown requested (reason: ${status.reason}, idle ${status.idleSeconds}s, uptime ${status.uptimeSeconds}s)`
  );

  if (status.reason === "manual") {
    // Consume the flag now, before the machine loses power — Redis persists
    // to disk, so an unconsumed flag would still be set the moment the box
    // comes back up via WOL and would immediately re-trigger a shutdown.
    await ackShutdown();
  }

  if (DRY_RUN) {
    console.log("[power-controller] DRY_RUN is set — not actually powering off.");
    triggered = false;
    return;
  }

  poweroff();
}

async function ackShutdown(): Promise<void> {
  try {
    await axios.post(
      `${STREAMIO_URL}/internal/power/ack-shutdown`,
      {},
      { headers: { "X-Power-Secret": POWER_SECRET }, timeout: 10_000 }
    );
  } catch (err: any) {
    console.error(`[power-controller] failed to acknowledge manual shutdown: ${err.message}`);
  }
}

function poweroff(): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "linux") {
    cmd = "systemctl";
    args = ["poweroff"];
  } else if (platform === "win32") {
    cmd = "shutdown";
    args = ["/s", "/t", "0"];
  } else if (platform === "darwin") {
    // Requires the user running this process to have passwordless sudo for
    // `shutdown` (visudo: "<user> ALL=(ALL) NOPASSWD: /sbin/shutdown").
    cmd = "sudo";
    args = ["shutdown", "-h", "now"];
  } else {
    console.error(`[power-controller] unsupported platform: ${platform}. Not shutting down.`);
    triggered = false;
    return;
  }

  console.log(`[power-controller] running: ${cmd} ${args.join(" ")}`);
  execFile(cmd, args, (err) => {
    if (err) {
      console.error(`[power-controller] poweroff command failed: ${err.message}`);
      triggered = false;
    }
    // On success the machine is going down; nothing else to do here.
  });
}

console.log(
  `[power-controller] watching ${STREAMIO_URL} every ${POLL_INTERVAL_SECONDS}s (platform: ${process.platform}${DRY_RUN ? ", DRY_RUN" : ""})`
);
setInterval(() => {
  pollOnce().catch((err) => console.error("[power-controller] poll error:", err));
}, POLL_INTERVAL_SECONDS * 1000);
pollOnce().catch((err) => console.error("[power-controller] poll error:", err));
