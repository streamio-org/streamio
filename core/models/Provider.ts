import { AppAdapter, AppItem, ItemType } from '../adapters/AppAdapter.js';
import { Category, Genre } from './index.js';

type VideoServer = { id: string; name: string; src: string };

/**
 * Genre browsing, implemented by every provider whose upstream site exposes a
 * genre/category filter.
 *
 * Kept as a structural interface rather than methods on `Provider` because
 * `Core` has to be able to tell a provider that supports genres from one that
 * doesn't: base-class stubs that throw would make `typeof p.getGenres ===
 * "function"` true for everyone, and the caller would learn the provider can't
 * do it only from an exception.
 */
export interface GenreCapableProvider {
    /** The provider's genre catalogue — `{ id, name }`, no shows attached. */
    getGenres(): Promise<Genre[]>;
    /** One page of titles in a genre, returned on the `Genre`'s `shows`. */
    getGenre(id: string, page: number): Promise<Genre>;
}

export function supportsGenres(
    provider: Provider
): provider is Provider & GenreCapableProvider {
    const candidate = provider as Partial<GenreCapableProvider>;
    return (
        typeof candidate.getGenres === "function" &&
        typeof candidate.getGenre === "function"
    );
}

export class Provider implements AppItem {
    private readonly name: string;
    private logo: string;
    private readonly language: string;

    public itemType!: ItemType;

    constructor(
        name: string,
        logo: string,
        language: string,
    ) {
        this.name = name;
        this.logo = logo;
        this.language = language;
    }

    public setLogo(url: string) {
        this.logo = url;
    }

    public getLogo(): string {
        return this.logo;
    }

    public getName(): string {
        return this.name;
    }

    public getLanguage(): string {
        return this.language;
    }

    public async getHome(): Promise<Category[]> {
        throw new Error("Not implemented");
    }

    public async search(query: string, page: number): Promise<AppItem[]> {
        throw new Error("Not implemented");
    }

    public async getMovie(id: string): Promise<AppItem> {
        throw new Error("Not implemented");
    }

    public async getTvShow(id: string): Promise<AppItem> {
        throw new Error("Not implemented");
    }

    public async getEpisodesBySeason(seasonId: string): Promise<AppItem[]> {
        throw new Error("Not implemented");
    }

    public async getServers(id: string): Promise<VideoServer[]> {
        throw new Error("Not implemented");
    }

    public equals(other: any): boolean {
        if (other instanceof Provider) {
            return this.name === other.name;
        }
        return false;
    }

    public toString(): string {
        return `${this.name}`;
    }
}