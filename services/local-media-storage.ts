// local-media-storage.ts
//
// Where locally-uploaded videos live on disk, mirroring apk-storage.ts's
// convention. Two separate roots, deliberately not nested one inside the
// other:
//
//   - ORIGINALS_DIR holds the raw upload handed to ffmpeg. Never served —
//     an admin's original file (whatever container/codec it happens to be)
//     has no reason to be reachable by URL.
//   - HLS_DIR holds ffmpeg's output (master.m3u8 plus one `<rung>/` directory
//     of index.m3u8 + segments per ABR rung) and is the one
//     directory mounted as `express.static` (see server.ts), at
//     `/api/local-media` — under /api because a reverse proxy in front of an
//     install may only proxy that prefix and 302-redirect everything else,
//     and a redirect carries no CORS header for the player to follow. Segment/manifest
//     filenames are ffmpeg-generated, not user-controlled, so
//     express.static's own traversal protection is enough — no custom
//     range-serving code is needed the way a raw progressive-file provider
//     would have needed one.
import fs from "node:fs";
import path from "node:path";

const LOCAL_MEDIA_DIR = path.join(process.cwd(), "uploads", "local-media");
export const ORIGINALS_DIR = path.join(LOCAL_MEDIA_DIR, "originals");
export const HLS_DIR = path.join(LOCAL_MEDIA_DIR, "hls");

/** Called once at server startup so a missing/broken volume mount fails
 *  loudly at boot rather than on an admin's first upload. */
export function ensureLocalMediaDirs(): void {
  fs.mkdirSync(ORIGINALS_DIR, { recursive: true });
  fs.mkdirSync(HLS_DIR, { recursive: true });
}

export function originalDirFor(fileId: string): string {
  return path.join(ORIGINALS_DIR, fileId);
}

export function hlsDirFor(fileId: string): string {
  return path.join(HLS_DIR, fileId);
}

export function masterPlaylistPathFor(fileId: string): string {
  return path.join(hlsDirFor(fileId), "master.m3u8");
}

/** Best-effort recursive removal — used when a title/episode/file is
 *  deleted. Never throws: a leftover directory on disk is a cleanup nit, not
 *  a reason to fail the delete the admin actually asked for. */
export async function removeMediaFiles(fileId: string): Promise<void> {
  await fs.promises.rm(originalDirFor(fileId), { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(hlsDirFor(fileId), { recursive: true, force: true }).catch(() => {});
}
