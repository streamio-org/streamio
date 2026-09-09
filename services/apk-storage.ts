// apk-storage.ts
//
// Where the self-hosted app build lives on disk. One file, always "the
// current build" — an upload replaces it, nothing is versioned/retained.
// Shared by settings.router.ts (writes it) and version.router.ts (serves
// it), so both agree on the path without either hardcoding the other's
// route.
import fs from "node:fs";
import path from "node:path";

export const APK_DIR = path.join(process.cwd(), "uploads", "app-releases");
export const APK_PATH = path.join(APK_DIR, "streamio.apk");

/** Called once at server startup so a missing/broken volume mount fails
 *  loudly at boot rather than on the admin's first upload. */
export function ensureApkDir(): void {
  fs.mkdirSync(APK_DIR, { recursive: true });
}
