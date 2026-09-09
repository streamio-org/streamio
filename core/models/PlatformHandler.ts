import { Core } from "../core.js";
import type { Database } from "../../database/db.js";
export class PlatformHandler {
    protected platform: string | null = null;
    protected core: Core;

    // `db` is optional because most callers of `Core` (every provider but
    // the local one scrapes a site or calls TMDB, needing no database at
    // all) have never had to supply one — see core/core.ts's constructor.
    constructor(platform: string, db?: Database) {
        this.platform = platform;
        this.core = new Core(db);
    }

    getDefaultProvider() {
        return this.core.getDefaultProvider();
    }

    getDefaultProviderName() {
        return this.core.getDefaultProviderName();
    }

    getListOfProviders(includeAdult: boolean = false) {
        return this.core.getListOfProviders(includeAdult);
    }

    getProviderCatalog(includeAdult: boolean = false) {
        return this.core.getProviderCatalog(includeAdult);
    }

    isAdultProvider(name: string) {
        return this.core.isAdultProvider(name);
    }

    getProviderByName(name: string) {
        return this.core.getProviderByName(name);
    }

    getAdminProviderCatalog() {
        return this.core.getAdminProviderCatalog();
    }

    setProviderDisabled(slug: string, disabled: boolean) {
        return this.core.setProviderDisabled(slug, disabled);
    }

    isProviderDisabled(slug: string) {
        return this.core.isProviderDisabled(slug);
    }

    applyDisabledProviders(slugs: string[]) {
        return this.core.loadDisabledProviders(slugs);
    }

    getHome(providerName: string) {
    // Implementation for getting home content
    }

    search(providerName: string, query: string, page?: number) {
        // Implementation for searching content
    }
    getShowDetails(providerName: string, showId: string) {
        // Implementation for getting show details
    }
    getEpisodes(providerName: string, seasonId: string) {
        // Implementation for getting episodes
    }
    getServers(providerName: string, episodeId: string, contentType?: "episode" | "movie") {
        // Implementation for getting servers
    }
    
}