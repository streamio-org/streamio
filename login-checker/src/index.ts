// login-checker — presence beacon for the machine's OS session.
//
// This process is only ever running while someone is logged into the host
// desktop session: it's meant to be started by the OS on login and killed on
// logout (see README). power-controller polls it before honoring an
// idle-triggered auto-shutdown — if it's reachable, someone is physically at
// the machine and idle auto-shutdown is paused; manual/admin shutdown always
// still works regardless. It never talks to the Streamio app directly.
import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import rateLimit from "express-rate-limit";

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT2 || 3001;
const TOKEN = process.env.LOGIN_TOKEN || "";

if (!TOKEN) {
  console.error("LOGIN_TOKEN is required (must match power-controller's LOGIN_CHECK_TOKEN).");
  process.exit(1);
}

app.use(cors({ origin: "http://127.0.0.1" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
});
app.use(limiter);

app.get("/", (req, res) => {
  if (req.headers["x-auth"] !== TOKEN) {
    res.status(403).json({ status: "forbidden" });
    return;
  }

  res.json({
    status: "online",
    user: process.env.USER || process.env.USERNAME,
    timestamp: Date.now(),
  });
});

server.listen(Number(PORT), "127.0.0.1", () => {
  console.log(`[login-checker] listening on http://127.0.0.1:${PORT}`);
});
