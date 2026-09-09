import { Database } from "../database/db.js";
import { Core } from "./core.js";

/**
 * Ad hoc manual smoke test for the registry/dispatch plumbing. `local` is the
 * only registered family and it needs a real `db` handle (`LocalProvider.ts`'s
 * `providerFamily.create` returns null without one) — a bare `new Core()`
 * would leave zero families registered and throw "No providers available".
 */
async function main() {
    const db = new Database();
    const c = new Core(db);

    const providers = c.getListOfProviders();
    console.log("Provider disponibili:", providers);

    const defaultProvider = c.getDefaultProvider();
    console.log("Provider di default:", defaultProvider.getName());

    const home = await c.getHome("");
    console.log("Categorie home:", home.length);

    await db.close?.();
}

main().catch(console.error);
