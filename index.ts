//index.ts
import { WebServer } from "./server.js";
import { Migrator } from "./database/migrator.js";
import { VERSION_STRING } from "./version.js";

const server = new WebServer();
const port = Number(process.env.PORT ?? 3003);

// Schema first, traffic second: a new build must never serve requests against
// a database it hasn't migrated yet. A failed migration is fatal on purpose —
// booting anyway would mean running new code against an old schema, which
// fails in far messier ways than not starting.
try {
  console.log(`Starting Streamio ${VERSION_STRING}`);
  await new Migrator(server.db).run();
} catch (err) {
  console.error("Migrations failed — refusing to start:", err);
  process.exit(1);
}

await server.start(port);
