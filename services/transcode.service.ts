// transcode.service.ts
//
// Turns one uploaded video (whatever container/codec it happens to be) into a
// multi-bitrate HLS package (`master.m3u8` + one variant playlist per rung of
// LADDER) that the existing hls.js / libmpv path can play and, crucially, can
// *adapt* down on: a single 1080p rendition left every client pinned to the
// top bitrate no matter what its link or its decoder could actually sustain.
//
// A single in-process FIFO queue, one job at a time: this app runs as one
// instance (RoomHub already makes the same single-instance assumption), and
// running more than one ffmpeg encode at once on likely-modest hardware would
// just make both slower. A job does not survive a process restart — a file
// stuck in `transcoding` after a crash needs an admin to hit "retry"
// (routes/local-provider.router.ts), which just calls `enqueue` again.
import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Database } from "../database/db.js";
import {
  hlsDirFor,
  masterPlaylistPathFor,
  originalDirFor,
} from "./local-media-storage.js";

interface Job {
  fileId: string;
  inputPath: string;
}

/** Runs `cmd` and resolves with its captured output; rejects with the stderr
 *  tail on a non-zero exit. stdout and stderr are kept apart because both are
 *  read for different things: ffprobe's JSON and ffmpeg's `-progress` blocks
 *  come down stdout, while only stderr is worth storing in
 *  `local_media_files.error`. */
function run(
  cmd: string,
  args: string[],
  onStdout?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const chunk = d.toString();
      if (onStdout) onStdout(chunk);
      else stdout += chunk;
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            stderr.slice(-4000) || stdout.slice(-4000) || `${cmd} exited with code ${code}`,
          ),
        );
      }
    });
  });
}

interface Probe {
  durationSeconds: number;
  /** Source height, used to cut ladder rungs a source can't fill — encoding a
   *  720p upload at "1080p" would cost a third of the encode time to produce
   *  an upscale nobody benefits from. */
  height: number;
  /** Absent on a silent clip, which `-map 0:a:0?` used to tolerate. The ABR
   *  ladder builds an explicit stream map, so audio has to be known up front
   *  rather than left optional. */
  hasAudio: boolean;
}

/** Duration, video height and whether there is an audio stream at all — one
 *  ffprobe call rather than three, since the ladder needs all of them before
 *  the encode's argument list can be built. */
async function probeInput(inputPath: string): Promise<Probe | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,height",
      "-of", "json",
      inputPath,
    ]);
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; height?: number }[];
    };

    const duration = Number(parsed?.format?.duration);
    if (!Number.isFinite(duration)) return null;

    const streams = parsed?.streams ?? [];
    const video = streams.find((st) => st.codec_type === "video");
    return {
      durationSeconds: Math.round(duration),
      // 1080 when the source doesn't report a height: the ladder's own
      // `min(H,ih)` scale expressions still stop any real upscaling, so the
      // worst case is one rung that encodes at the source's own size.
      height: Number(video?.height) || 1080,
      hasAudio: streams.some((st) => st.codec_type === "audio"),
    };
  } catch {
    return null;
  }
}

/**
 * Segment length, seconds.
 *
 * `-hls_time` alone is only a *request*: the HLS muxer can only cut on a
 * keyframe, so with libx264's default 250-frame GOP the old `-hls_time 6`
 * silently produced 10s segments (verified: `#EXT-X-TARGETDURATION:10`).
 * A client cannot render a single frame of a segment it hasn't finished
 * downloading, so a 10s segment means ~6 MB has to land before playback
 * starts or resumes after a stall, and hls.js's throughput estimate only
 * updates once per segment — far too coarse to react. The keyframe cadence
 * below is forced to match this, which is what makes the number real.
 */
const SEGMENT_SECONDS = 4;

interface Rung {
  /** Also the `%v` directory name and the variant's `name:` in the stream map. */
  name: string;
  height: number;
  /** Quality target. The `maxrate`/`bufsize` pair is what actually bounds the
   *  rung: CRF alone is unbounded, and a high-motion film peaks far above its
   *  average, which is exactly when a marginal client falls over. */
  crf: number;
  maxrateK: number;
  audioK: number;
  /**
   * H.264 profile and level, pinned rather than left to libx264's defaults.
   *
   * Android's MediaCodec advertises a maximum level, and a stream above it is
   * refused outright — libmpv then falls back to *software* decoding, which a
   * tablet SoC cannot sustain at 1080p. Every rung here stays inside the
   * level every H.264 decoder shipped in the last decade supports.
   */
  profile: "high" | "main";
  level: string;
}

/**
 * Ordered top-first. Rungs above the source's own height are dropped (see
 * `rungsFor`), so a 720p upload costs two encodes rather than three.
 *
 * Three rungs is the point of the whole change: hls.js and libmpv both pick a
 * variant from measured throughput, so 480p/720p exist to be *chosen* by a
 * client that cannot hold 1080p — over the tunnel hop, on hotel wifi, or on a
 * tablet whose decoder is the bottleneck.
 */
const LADDER: Rung[] = [
  { name: "1080p", height: 1080, crf: 21, maxrateK: 5000, audioK: 128, profile: "high", level: "4.0" },
  { name: "720p",  height: 720,  crf: 22, maxrateK: 2800, audioK: 128, profile: "high", level: "3.1" },
  { name: "480p",  height: 480,  crf: 23, maxrateK: 1200, audioK: 96,  profile: "main", level: "3.0" },
];

/** The rungs worth encoding for a source of `sourceHeight` pixels. Never
 *  empty: a sub-480p source still gets the bottom rung, whose `min(H,ih)`
 *  scale expression leaves it at its own size rather than upscaling it. */
function rungsFor(sourceHeight: number): Rung[] {
  const usable = LADDER.filter((r) => r.height <= sourceHeight);
  return usable.length ? usable : [LADDER[LADDER.length - 1]];
}

/**
 * The `-filter_complex` graph: decode once, `split` to one scaled output per
 * rung. Decoding a two-hour source three times over would cost more than the
 * extra encodes do.
 *
 * `trunc(min(H,ih)/2)*2` caps at the rung's height without upscaling a smaller
 * source, and keeps the result even — H.264 4:2:0 cannot represent an odd
 * dimension, and an odd-height source (rare, but rips are cropped) would
 * otherwise fail the encode outright. `-2` does the same for width, preserving
 * the source's aspect ratio.
 */
function filterGraph(rungs: Rung[]): string {
  const labels = rungs.map((_, i) => `[v${i}]`).join("");
  const split = `[0:v:0]split=${rungs.length}${labels}`;
  const scales = rungs.map(
    (r, i) => `[v${i}]scale=-2:'trunc(min(${r.height},ih)/2)*2'[v${i}o]`,
  );
  return [split, ...scales].join(";");
}

/** Seconds encoded so far, read out of one `-progress pipe:1` block. ffmpeg
 *  emits `out_time_us` (microseconds) plus a formatted `out_time`; the latter
 *  is the fallback because `out_time_us` reads `N/A` in the first block or
 *  two, before any frame has been written. */
function parseProgressSeconds(chunk: string): number | null {
  const micros = chunk.match(/out_time_us=(\d+)/);
  if (micros) return Number(micros[1]) / 1_000_000;

  const clock = chunk.match(/out_time=(\d+):(\d{2}):(\d{2})\.(\d+)/);
  if (clock) {
    return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  return null;
}

export class TranscodeService {
  private queue: Job[] = [];
  private running = false;
  /**
   * fileId → 0-100, live for the job currently encoding. In memory rather
   * than a DB column on purpose: it changes several times a second, it is
   * only meaningful while this process is the one running ffmpeg, and a
   * restart loses the job it describes anyway (see the file header).
   */
  private progress = new Map<string, number>();

  constructor(private db: Database) {}

  enqueue(fileId: string, inputPath: string): void {
    this.queue.push({ fileId, inputPath });
    void this.pump();
  }

  /** Percent complete for a file currently being encoded, else null (queued,
   *  finished, failed, or transcoded by an earlier run of this process). */
  getProgress(fileId: string): number | null {
    return this.progress.get(fileId) ?? null;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;

    this.running = true;
    try {
      await this.runJob(job);
    } finally {
      this.running = false;
      void this.pump();
    }
  }

  private async runJob(job: Job): Promise<void> {
    const { fileId, inputPath } = job;

    await this.db.query(
      `UPDATE local_media_files SET status = 'transcoding', error = NULL, updated_at = now() WHERE id = $1`,
      [fileId],
    );

    try {
      // Fails fast on a non-media file before any encode work starts, and
      // gives us `duration_seconds` plus the two facts the ladder is built
      // from for free.
      const probe = await probeInput(inputPath);
      if (probe === null) {
        throw new Error("ffprobe could not read a duration — is this a valid video file?");
      }
      const { durationSeconds, hasAudio } = probe;

      const outDir = hlsDirFor(fileId);
      // A retry re-encodes into the same directory. The rung set depends on
      // the source's height, so a previous run may have written variant
      // directories this one won't — left alone they'd stay listed in nothing
      // but still occupy disk, and a half-written segment from a crashed run
      // would sit alongside the new ones under the same name.
      await fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => {});
      fs.mkdirSync(outDir, { recursive: true });
      const masterPath = masterPlaylistPathFor(fileId);

      const rungs = rungsFor(probe.height);

      // Always transcodes (never stream-copies) for MVP robustness — detecting
      // "already H.264+AAC, safe to copy" is a later optimization, and a
      // stream copy could not produce a ladder anyway. Everything else here is
      // about accepting *whatever ffmpeg can decode* — an upload is not just
      // mp4/H.264, it's routinely an mkv rip carrying HEVC, VP9, multiple
      // audio tracks and a subtitle stream — and turning all of that into one
      // predictable output rather than failing on the first file that isn't a
      // "plain" mp4:
      //   - The `-filter_complex` graph maps only `0:v:0`, and the audio maps
      //     below only `0:a:0`. Without an explicit map, a file with
      //     commentary tracks or embedded subtitles (mkv routinely has both)
      //     can make ffmpeg's automatic stream selection feed the hls muxer a
      //     stream it can't take at all. `hasAudio` replaces the old optional
      //     `0:a:0?` map: a `-var_stream_map` naming an audio stream that
      //     doesn't exist is a hard error, so a silent source has to be
      //     detected up front and mapped video-only instead.
      //   - `-pix_fmt yuv420p` normalizes whatever the source decodes to.
      //     10-bit HEVC ("Main10") and VP9 profile 2 rips are common, and
      //     libx264's default build only encodes 8-bit 4:2:0 — left alone,
      //     these fail at the *encode* step with a codec that looks
      //     perfectly fine to ffprobe, which is the single most common
      //     "some files just don't work" report for a pipeline like this.
      //   - `-ac 2` downmixes anything wider than stereo (5.1/7.1 AC3, DTS,
      //     TrueHD...). ffmpeg's native `aac` encoder is unreliable above
      //     stereo and can reject uncommon channel layouts outright; this
      //     trades surround sound for "encodes successfully everywhere".
      //   - `-fflags +genpts` regenerates presentation timestamps for
      //     sources with broken/missing PTS, which shows up more often in
      //     older AVI/re-muxed files than in "clean" mp4s.
      //   - `-max_muxing_queue_size 1024` avoids a spurious "Too many
      //     packets buffered for output stream" abort that a handful of
      //     legitimately-decodable files trigger. Raised from the previous
      //     value's single output to cover several muxers at once.
      //
      // The ladder's own arguments, per rung `i`:
      //   - `-force_key_frames expr:gte(t,n_forced*SEGMENT_SECONDS)` plus
      //     `-sc_threshold 0` is what makes `-hls_time` mean anything. The
      //     muxer can only split on a keyframe, so with libx264's default
      //     250-frame GOP the old six-second request produced ten-second
      //     segments. The expression form is used rather than `-g <fps*4>`
      //     because it is frame-rate agnostic and survives a variable-frame-
      //     rate source, where a fixed GOP count drifts. `-sc_threshold 0`
      //     stops scene-cut detection inserting *extra* keyframes, which
      //     would leave the rungs cut at different points — a client
      //     switching variants mid-stream needs the segment boundaries to
      //     line up.
      //   - `-maxrate`/`-bufsize` bound each rung. CRF on its own is
      //     unbounded: a high-motion scene at CRF 21 peaks far above its
      //     average, and that peak is exactly when a marginal client stalls.
      //     `bufsize` = 2x `maxrate` is the usual VBV window — a second of
      //     slack, enough that the cap doesn't visibly flatten quality.
      //   - `-profile:v`/`-level` keep every rung inside what a hardware
      //     decoder will accept (see `Rung`).
      const args: string[] = [
        "-y",
        // Machine-readable progress on stdout instead of the human stats
        // line on stderr: this is what drives the admin page's "Processing
        // 42%" bar, and it leaves stderr holding nothing but real errors.
        "-progress", "pipe:1",
        "-nostats",
        "-fflags", "+genpts",
        "-i", inputPath,
        "-filter_complex", filterGraph(rungs),
      ];

      for (let i = 0; i < rungs.length; i++) {
        args.push("-map", `[v${i}o]`);
        if (hasAudio) args.push("-map", "0:a:0");
      }

      args.push(
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-sc_threshold", "0",
        "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      );

      rungs.forEach((rung, i) => {
        args.push(
          `-crf:v:${i}`, String(rung.crf),
          `-maxrate:v:${i}`, `${rung.maxrateK}k`,
          `-bufsize:v:${i}`, `${rung.maxrateK * 2}k`,
          `-profile:v:${i}`, rung.profile,
          `-level:v:${i}`, rung.level,
        );
      });

      if (hasAudio) {
        args.push("-c:a", "aac", "-ac", "2");
        rungs.forEach((rung, i) => args.push(`-b:a:${i}`, `${rung.audioK}k`));
      }

      // `%v` in both output paths expands to each variant's `name:` from the
      // stream map, so a rung lands in its own `<outDir>/1080p/` directory and
      // the master playlist that references them stays at `<outDir>/
      // master.m3u8` — the exact path `LocalProvider.getVideo` already hands
      // out, so the URL a client plays is unchanged by this.
      args.push(
        "-max_muxing_queue_size", "1024",
        "-f", "hls",
        "-hls_time", String(SEGMENT_SECONDS),
        "-hls_playlist_type", "vod",
        "-hls_list_size", "0",
        // Tells a player every segment can be decoded without the one before
        // it, which is what lets it switch rungs at any boundary rather than
        // only at the start.
        "-hls_flags", "independent_segments",
        "-hls_segment_filename", `${outDir}/%v/seg_%05d.ts`,
        "-master_pl_name", "master.m3u8",
        "-var_stream_map",
        rungs
          .map((rung, i) => (hasAudio ? `v:${i},a:${i},name:${rung.name}` : `v:${i},name:${rung.name}`))
          .join(" "),
        `${outDir}/%v/index.m3u8`,
      );

      await run("ffmpeg", args, (chunk) => {
        const seconds = parseProgressSeconds(chunk);
        if (seconds !== null && durationSeconds > 0) {
          const percent = Math.min(99, Math.round((seconds / durationSeconds) * 100));
          this.progress.set(fileId, percent);
        }
      });

      // ffmpeg exits 0 having written variant playlists but no master if the
      // stream map is degenerate, and `getVideo` hands out this exact path —
      // a missing file there would surface to a viewer as a manifest 404
      // rather than as a failed transcode the admin page can show.
      if (!fs.existsSync(masterPath)) {
        throw new Error("ffmpeg finished without writing master.m3u8");
      }

      await this.db.query(
        `UPDATE local_media_files
            SET status = 'ready', duration_seconds = $2, error = NULL, updated_at = now()
          WHERE id = $1`,
        [fileId, durationSeconds],
      );

      // Only needed for this one encode once it has succeeded — keeping it
      // around would be an ever-growing copy of every upload on top of its
      // HLS output. Kept on failure (see catch below) so "retry" has
      // something to re-encode.
      await fs.promises.rm(originalDirFor(fileId), { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`local-provider transcode failed for file ${fileId}:`, message);
      await this.db.query(
        `UPDATE local_media_files SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
        [fileId, message.slice(0, 2000)],
      );
    } finally {
      // The row's `status` is the durable answer from here on; a stale 87%
      // left in the map would keep the admin page drawing a progress bar
      // over a file that is already ready or failed.
      this.progress.delete(fileId);
    }
  }
}
