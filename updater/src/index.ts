// updater — host-side self-update watcher.
//
// Runs directly on the machine (not in Docker, like power-controller/): the
// app container can decide "a newer release exists and should be installed",
// but it cannot check out that release and rebuild the very image it is
// running from. This process is the other half — it polls the app, and when
// told to, checks out the target tag, rebuilds, and brings the stack back up.
//
// Downtime is kept to the container restart only: the new image is built
// *before* anything is stopped, and the new container runs its own DB
// migrations at boot, so no manual step sits between "new code" and "new
// schema".
import "dotenv/config";
import { execFile } from "node:child_process";
import path from "node:path";
import axios from "axios";

const STREAMIO_URL = (process.env.STREAMIO_URL || "http://localhost:8080").replace(/\/+$/, "");
const UPDATE_SECRET = process.env.UPDATE_CONTROLLER_SECRET || "";
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS) || 300;
const DRY_RUN = process.env.DRY_RUN === "true";
// The checkout that docker-compose.yml lives in — the thing actually rebuilt.
const REPO_DIR = path.resolve(process.env.REPO_DIR || path.join(process.cwd(), ".."));
const GIT_REMOTE = process.env.GIT_REMOTE || "origin";
const COMPOSE_SERVICE = process.env.COMPOSE_SERVICE || "streamio";
// How long to wait for the rebuilt app to come back and report the new
// version before declaring the update failed.
const HEALTH_TIMEOUT_SECONDS = Number(process.env.HEALTH_TIMEOUT_SECONDS) || 300;

if (!UPDATE_SECRET) {
  console.error("UPDATE_CONTROLLER_SECRET is required (must match the app's env var).");
  process.exit(1);
}

interface UpdateStatus {
  shouldUpdate: boolean;
  reason: "manual" | "auto" | null;
  requestedBy: string | null;
  updateAvailable: boolean;
  currentVersion: string;
  latest: { version: string; ref: string } | null;
}

const authHeaders = { "X-Update-Secret": UPDATE_SECRET };

// One update at a time, and never a second attempt while the first is still
// unwinding — the stack is being torn down underneath us.
let busy = false;

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`[updater] $ ${cmd} ${args.join(" ")}`);
    execFile(cmd, args, { cwd: REPO_DIR, env, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * `docker compose` (v2 plugin) with `docker-compose` (v1 binary) as fallback.
 * GIT_SHA/BUILD_TIME are passed through as build args (docker-compose.yml
 * reads them from the environment) so the image can report exactly which
 * commit it was built from.
 */
async function compose(args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    env.GIT_SHA = await run("git", ["rev-parse", "--short", "HEAD"]);
  } catch {
    // Not fatal — the build just reports an unknown commit.
  }
  env.BUILD_TIME = new Date().toISOString();

  try {
    return await run("docker", ["compose", ...args], env);
  } catch (err) {
    if (process.env.COMPOSE_COMMAND === "docker-compose") throw err;
    return run("docker-compose", args, env);
  }
}

async function currentRef(): Promise<string> {
  // The branch name if we're on one, otherwise the exact commit — either way
  // something `git checkout` can take us back to if the update fails.
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "HEAD") return branch;
  return run("git", ["rev-parse", "HEAD"]);
}

async function waitForHealthy(targetVersion: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_SECONDS * 1000;
  let lastError = "not yet responding";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      const res = await axios.get<{ status: string; version: string }>(
        `${STREAMIO_URL}/health`,
        { timeout: 10_000 },
      );
      if (res.data?.status !== "ok") {
        lastError = `health reported ${res.data?.status}`;
        continue;
      }
      if (res.data.version === targetVersion) return;
      // Up, but still the old build: compose hasn't swapped the container yet.
      lastError = `still running ${res.data.version}, expected ${targetVersion}`;
    } catch (err: any) {
      lastError = err.message;
    }
  }
  throw new Error(`Timed out waiting for ${targetVersion} to come up (${lastError}).`);
}

async function applyUpdate(status: UpdateStatus): Promise<void> {
  const target = status.latest!;
  const previousRef = await currentRef();

  console.log(
    `[updater] updating ${status.currentVersion} -> ${target.version} ` +
      `(${status.reason}${status.requestedBy ? ` by ${status.requestedBy}` : ""})`,
  );

  if (DRY_RUN) {
    console.log(`[updater] DRY_RUN is set — would check out ${target.ref} and rebuild.`);
    return;
  }

  // Record (and clear the pending flag) before touching anything: from here
  // on the app is going down, and a flag left set would have the replacement
  // container hand the same update straight back to us.
  let historyId: string;
  try {
    const res = await axios.post<{ id: string }>(
      `${STREAMIO_URL}/internal/update/start`,
      { to_version: target.version, trigger: status.reason, requested_by: status.requestedBy },
      { headers: authHeaders, timeout: 10_000 },
    );
    historyId = res.data.id;
  } catch (err: any) {
    console.error(`[updater] could not register the update, aborting: ${err.message}`);
    return;
  }

  try {
    await run("git", ["fetch", GIT_REMOTE, "--tags", "--prune"]);
    await run("git", ["-c", "advice.detachedHead=false", "checkout", "--force", target.ref]);

    // Build first, stop second: the old container keeps serving for the whole
    // (slow) build, and a build failure costs no downtime at all.
    await compose(["build", COMPOSE_SERVICE]);
    await compose(["up", "-d", COMPOSE_SERVICE]);

    await waitForHealthy(target.version);

    await report(historyId, "ok", null);
    console.log(`[updater] now running ${target.version}`);
  } catch (err: any) {
    console.error(`[updater] update failed: ${err.message}`);
    await rollback(previousRef);
    await report(historyId, "error", err.message);
  }
}

/**
 * Put the old build back. Best-effort: if this fails too, the operator has to
 * step in — but leaving a half-updated checkout that no longer builds would
 * be strictly worse.
 */
async function rollback(previousRef: string): Promise<void> {
  console.log(`[updater] rolling back to ${previousRef}`);
  try {
    await run("git", ["-c", "advice.detachedHead=false", "checkout", "--force", previousRef]);
    await compose(["build", COMPOSE_SERVICE]);
    await compose(["up", "-d", COMPOSE_SERVICE]);
    console.log("[updater] rollback complete.");
  } catch (err: any) {
    console.error(
      `[updater] ROLLBACK FAILED (${err.message}) — the checkout at ${REPO_DIR} needs manual attention.`,
    );
  }
}

async function report(id: string, status: "ok" | "error", error: string | null): Promise<void> {
  try {
    await axios.post(
      `${STREAMIO_URL}/internal/update/finish`,
      { id, status, error },
      { headers: authHeaders, timeout: 10_000 },
    );
  } catch (err: any) {
    console.error(`[updater] could not report the result: ${err.message}`);
  }
}

async function pollOnce(): Promise<void> {
  if (busy) return;

  let status: UpdateStatus;
  try {
    const res = await axios.get<UpdateStatus>(`${STREAMIO_URL}/internal/update/status`, {
      headers: authHeaders,
      timeout: 15_000,
    });
    status = res.data;
  } catch (err: any) {
    console.error(`[updater] status check failed: ${err.message}`);
    return;
  }

  if (!status.shouldUpdate || !status.latest) return;

  busy = true;
  try {
    await applyUpdate(status);
  } finally {
    busy = false;
  }
}

console.log(
  `[updater] watching ${STREAMIO_URL} every ${POLL_INTERVAL_SECONDS}s ` +
    `(repo: ${REPO_DIR}${DRY_RUN ? ", DRY_RUN" : ""})`,
);
setInterval(() => {
  pollOnce().catch((err) => console.error("[updater] poll error:", err));
}, POLL_INTERVAL_SECONDS * 1000);
pollOnce().catch((err) => console.error("[updater] poll error:", err));
