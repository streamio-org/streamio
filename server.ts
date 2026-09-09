import dotenv from "dotenv";
import express from "express";
import cookieParser from "cookie-parser";
import { WebPlatformHandler } from "./PlatformHandler.js";
import { UnknownProviderError, ProviderDisabledError, ProviderTimeoutError } from "./core/core.js";
import { createContentRouter } from "./routes/content.router.js";
import { createHealthRouter } from "./routes/health.router.js";
import { createPublicRouter } from "./routes/public.router.js";
import { createProviderRouter } from "./routes/provider.router.js";
import { createAuthRouter } from "./routes/auth.router.js";
import { createAccountRouter } from "./routes/account.router.js";
import { createFollowRouter } from "./routes/follow.router.js";
import { createShareRouter } from "./routes/share.router.js";
import { createSettingsRouter } from "./routes/settings.router.js";
import { createSyncRouter } from "./routes/sync.router.js";
import { createPowerRouter } from "./routes/power.router.js";
import { createRoomRouter } from "./routes/room.router.js";
import { createVersionRouter } from "./routes/version.router.js";
import { createUpdateRouter } from "./routes/update.router.js";
import { createLocalProviderRouter } from "./routes/local-provider.router.js";
import { UpdateService } from "./services/update.service.js";
import { createClientVersionGate } from "./auth/clientVersion.js";
import { optionalAuth } from "./auth/middleware.js";
import { VERSION_STRING } from "./version.js";
import { Database } from "./database/db.js";
import { Redis } from "./database/redis.js";
import { SyncService } from "./services/sync.service.js";
import { SettingsService } from "./services/settings.service.js";
import { IdleShutdownService } from "./services/idle-shutdown.service.js";
import { RoomService } from "./services/room.service.js";
import { RoomHub } from "./services/room-socket.service.js";
import { ensureApkDir } from "./services/apk-storage.js";
import { ensureLocalMediaDirs, HLS_DIR } from "./services/local-media-storage.js";
import { verifyAccessToken } from "./auth/jwt.js";
import path from "node:path";
import http from "node:http";
import { WebSocketServer } from "ws";

// Paths excluded from idle-activity tracking: these are polled on a fixed
// interval by infrastructure (the redirect tunnel's watchdog, the
// power-controller) or by peer servers, not by an actual user, so counting
// them would mean the server never looks idle.
const ACTIVITY_EXCLUDED_PATHS = [
  "/health",
  "/internal/power/status",
  "/internal/update/status",
  "/api/sync/export",
];

dotenv.config();

export class WebServer {
  private app: express.Application;
  private platformHandler: WebPlatformHandler;
  private syncService: SyncService;
  private idleShutdownService: IdleShutdownService;
  private updateService: UpdateService;
  private roomService: RoomService;
  private roomHub: RoomHub;
  db: Database;
  redis: Redis;

  constructor() {
    this.app = express();
    this.db = new Database();
    this.redis = new Redis();
    this.redis.connect().catch((err) => {
      console.error("Failed to connect to Redis:", err);
    });

    this.platformHandler = new WebPlatformHandler(this.db, this.redis);
    this.syncService = new SyncService(this.db, this.redis);
    const settingsService = new SettingsService(this.db);
    this.idleShutdownService = new IdleShutdownService(this.redis, settingsService);
    this.updateService = new UpdateService(this.db, this.redis, settingsService);
    this.roomService = new RoomService(this.db);
    this.roomHub = new RoomHub(this.roomService);
    // Fails loudly at boot if the uploads volume isn't mounted, rather than
    // on an admin's first APK upload.
    ensureApkDir();
    ensureLocalMediaDirs();
    // Anything that reads the database is started in start(), not here:
    // the constructor runs before index.ts applies migrations, so on a fresh
    // install these would query tables that don't exist yet.

    this.app.use(express.json());
    this.app.use(cookieParser());
    this.app.use((req, res, next) => {
          res.set("Access-Control-Allow-Origin", "*");
          res.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
          res.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Client");
          // Paging metadata on the library listings. A response header is
          // invisible to cross-origin JS unless it is named here, so a page
          // served from another origin would read the counts as absent.
          res.set("Access-Control-Expose-Headers", "X-Total-Count, X-Page-Rows");
          if (req.method === "OPTIONS") return res.sendStatus(204);
          next();
      });
    // Runs before any route: a client below the enforced floor gets a 426
    // and never reaches business logic. No-op for browsers and for anyone
    // when the policy isn't enforced.
    this.app.use(createClientVersionGate(settingsService));
    this.app.use((req, _res, next) => {
      if (!ACTIVITY_EXCLUDED_PATHS.includes(req.path)) {
        this.idleShutdownService.recordActivity().catch((err) => {
          console.error("Failed to record activity:", err);
        });
      }
      next();
    });

    this.setupRoutes();
    this.setupErrorHandling();

    console.log("WebServer initialized");
  }

  private setupErrorHandling() {
    this.app.use(
      (
        err: any,
        req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        // A `?provider=` the registry doesn't know is the caller's mistake,
        // not the server's. It gets its own status because the alternative —
        // quietly serving the default provider's content under the asked-for
        // name — is how a client can be pointed at the wrong source for a
        // whole release without anything looking broken.
        if (err instanceof UnknownProviderError) {
          return res.status(400).json({
            error:   "Unknown provider",
            message: err.message,
          });
        }

        if (err instanceof ProviderDisabledError) {
          return res.status(403).json({
            error:   "Provider disabled",
            message: err.message,
          });
        }

        if (err instanceof ProviderTimeoutError) {
          return res.status(504).json({
            error:   "Provider timeout",
            message: err.message,
          });
        }

        // A response already in flight (e.g. a proxied stream the client
        // aborted mid-transfer) can't take a JSON error body — express's
        // res.json() would throw ERR_HTTP_HEADERS_SENT. Delegate to the
        // default Express handler, which just closes the connection.
        if (res.headersSent) {
          return next(err);
        }

        console.error("Global error:", err);
        res.status(500).json({
          error:   "Internal Server Error",
          message: err.message,
        });
      }
    );
  }

  private setupRoutes() {
    this.app.use(express.static(path.join(process.cwd(), "public")));
    // Under /api deliberately, even though it serves files rather than JSON:
    // a reverse proxy in front of an install may only proxy /api/* and
    // 302-redirect everything else, and a 302 has no
    // Access-Control-Allow-Origin — so a page served from the proxy's own
    // origin could not fetch a manifest mounted anywhere else (hls.js
    // reports manifestLoadError, the CAF receiver error 905).
    // Registered before the routers so it wins over the /api catch-all.
    //
    // ffmpeg-generated segment/manifest filenames only, never user input, so
    // express.static's own path-traversal protection is enough — see
    // services/local-media-storage.ts.
    this.app.use(
      "/api/local-media",
      express.static(HLS_DIR, {
        // Every fragment travels device -> (reverse proxy, if any) -> server,
        // so a revalidation round trip costs far more here than it does against a
        // CDN. express.static's default `max-age: 0` made the player re-ask
        // for every segment it already held; a VOD segment under a fileId
        // directory is immutable (a re-encode only ever happens for a file
        // that never reached `ready`, so nothing has been served from it),
        // which is what makes the long TTL safe. The playlists get a short
        // one rather than sharing it — they're the only files a retry
        // rewrites in place.
        setHeaders: (res, filePath) => {
          res.setHeader(
            "Cache-Control",
            filePath.endsWith(".m3u8")
              ? "public, max-age=60"
              : "public, max-age=31536000, immutable",
          );
        },
      }),
    );
    this.app.use("/",              createPublicRouter());
    this.app.use("/health",        createHealthRouter());
    this.app.use("/api/version",   createVersionRouter(this.db));
    this.app.use("/api/auth",      createAuthRouter(this.db, this.redis));
    this.app.use("/api/account",   createAccountRouter(this.db, this.redis, this.roomService, this.roomHub, this.platformHandler));
    this.app.use("/api/social",    createFollowRouter(this.db, this.redis));
    this.app.use("/api/social",    createShareRouter(this.db, this.redis));
    this.app.use("/api/settings",  createSettingsRouter(this.db, this.idleShutdownService, this.updateService, this.platformHandler));
    this.app.use("/api/admin/local-provider", createLocalProviderRouter(this.db));
    this.app.use("/api/sync",      createSyncRouter(this.db, this.redis));
    this.app.use("/internal/power", createPowerRouter(this.idleShutdownService));
    this.app.use("/internal/update", createUpdateRouter(this.updateService));
    this.app.use("/api/rooms",     createRoomRouter(this.roomService, this.roomHub));
    // optionalAuth, not requireAuth: browsing stays anonymous, but a signed-in
    // caller is recognised so the 18+ preference can be honoured. Without this
    // the content routes could never tell who is asking.
    this.app.use("/api/providers", optionalAuth, createProviderRouter(this.platformHandler, this.db, this.redis));
    this.app.use("/api",           optionalAuth, createContentRouter(this.platformHandler, this.db, this.redis));
  }

  // Rooms (watch parties) sync over a plain WebSocket at /ws/rooms/:code —
  // handled on the raw http.Server via a manual upgrade (not app.listen)
  // because `ws` needs the underlying server to intercept the Upgrade
  // handshake, and route params (:code) aren't available through express.
  private setupRoomSocket(server: http.Server) {
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? "", "http://internal");
          const match = url.pathname.match(/^\/ws\/rooms\/([^/]+)$/);
          if (!match) {
            socket.destroy();
            return;
          }

          const code = decodeURIComponent(match[1]);
          const token = url.searchParams.get("token") || "";
          const user = verifyAccessToken(token);

          const room = await this.roomService.getRoomDetail(code, user.sub);
          if (!room || !room.isMember) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            this.roomHub.handleConnection(ws, room, user);
          });
        } catch {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
        }
      })();
    });
  }

  public async start(port: number) {
    const server = http.createServer(this.app);
    this.setupRoomSocket(server);

    // Disabled-provider state lives in app_settings but is enforced from
    // Core's in-memory registry — loaded here, not the constructor, since
    // the DB isn't guaranteed migrated until index.ts's Migrator has run.
    const settingsService = new SettingsService(this.db);
    const disabled = await settingsService.getDisabledProviders();
    this.platformHandler.applyDisabledProviders(Object.keys(disabled));

    // DB-backed background work — started here rather than in the
    // constructor, so migrations have already run by this point.
    this.syncService.startScheduler();
    this.roomHub.init().catch((err) => {
      console.error("Failed to start room-hub cleanup scheduler:", err);
    });
    // An update that got as far as killing this container but never reported
    // back is settled here, on the boot that replaced it.
    this.updateService.reconcileInterrupted().catch((err) => {
      console.error("Failed to reconcile interrupted updates:", err);
    });
    server.listen(port, "0.0.0.0", () => {
      console.log(`Streamio ${VERSION_STRING} is running on port ${port}`);
    });
  }
}