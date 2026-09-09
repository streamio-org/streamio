import { Genre } from './Genre.js';
import { People } from './People.js';
import { Show } from './Show.js';
import { WatchItem, WatchHistory } from './WatchItem.js';
import { AppAdapter, AppItem, ItemType } from '../adapters/AppAdapter.js';
import { TvShow } from './TvShow.js';
import { ShowDetails } from './ShowDetails.js';

export class Movie implements WatchItem, AppItem {
    // Proprietà principali
    public id: string;
    public title: string;
    public overview: string | null;
    public runtime: number | null;
    public trailer: string | null;
    public quality: string | null;
    public rating: number | null;
    public poster: string | null;
    public banner: string | null;

    // Proprietà ignorate da Room (UI/Logic)
    public imdbId: string | null;
    public providerName: string | null;
    public genres: Genre[];
    public directors: People[];
    public cast: People[];
    public recommendations: Show[];
    
    // Stato di visione e preferiti
    public isFavorite: boolean;
    public released: Date | null;
    public favoritedAtMillis: number | null = null;
    public isWatched: boolean = false;
    public watchedDate: Date | null = null;
    public watchHistory: WatchHistory | null = null;

    /**
     * 18+. Set from `local_titles.adult`, the flag an admin sets by hand when
     * adding the title — see `LocalProvider.ts`.
     */
    public adult: boolean;

    /**
     * Everything the source publishes that has no flat field here — original
     * title, studio, status, external ids, popularity counters. Assigned after
     * construction rather than taken as a nineteenth positional argument (see
     * `ShowDetails`); `{}` means the provider filled nothing in.
     */
    public details: ShowDetails = {};

    // Proprietà adapter
    public itemType!: ItemType;

    constructor(
        id: string = "",
        title: string = "",
        overview: string | null = null,
        releasedStr: string | null = null,
        runtime: number | null = null,
        trailer: string | null = null,
        quality: string | null = null,
        rating: number | null = null,
        poster: string | null = null,
        banner: string | null = null,
        imdbId: string | null = null,
        providerName: string | null = null,
        genres: Genre[] = [],
        directors: People[] = [],
        cast: People[] = [],
        recommendations: Show[] = [],
        isFavorite: boolean = false,
        adult: boolean = false
    ) {
        this.id = id;
        this.title = title;
        this.overview = overview;
        this.runtime = runtime;
        this.trailer = trailer;
        this.quality = quality;
        this.rating = rating;
        this.poster = poster;
        this.banner = banner;
        this.imdbId = imdbId;
        this.providerName = providerName;
        this.genres = genres;
        this.directors = directors;
        this.cast = cast;
        this.recommendations = recommendations;
        this.isFavorite = isFavorite;
        this.adult = adult;
        this.released = releasedStr ? new Date(releasedStr) : null;
    }

    public getItemIdentity(): string {
        return `${this.getBaseIdentityKey()}_${this.id}`;
    }

    public getBaseIdentityKey(): string {
        return this.providerName ?? "unknown";
    }
    public states: Map<number, any> = new Map();
    public items: AppItem[] = [];
    public isLoading: boolean = false;
    public onMovieClickListener?: (movie: Movie) => void;
    public onTvShowClickListener?: (tvShow: TvShow) => void;
    public onGenreClickListener?: (genre: Genre) => void;
    public onLoadMoreListener?: () => void;
    public getItemCount(): number {
        throw new Error('Method not implemented.');
    }
    public submitList(newList: AppItem[]): void {
        throw new Error('Method not implemented.');
    }
    public saveState(position: number, state: any): void {
        throw new Error('Method not implemented.');
    }
    public getState(position: number) {
        throw new Error('Method not implemented.');
    }

    /**
     * Verifica se i dati dinamici (User State) sono identici
     */
    public isSame(movie: Movie): boolean {
        return (
            this.isFavorite === movie.isFavorite &&
            this.favoritedAtMillis === movie.favoritedAtMillis &&
            this.isWatched === movie.isWatched &&
            this.watchedDate?.getTime() === movie.watchedDate?.getTime() &&
            JSON.stringify(this.watchHistory) === JSON.stringify(movie.watchHistory)
        );
    }

    /**
     * Sincronizza lo stato utente da un'altra istanza
     */
    public merge(movie: Movie): Movie {
        this.isFavorite = movie.isFavorite;
        this.favoritedAtMillis = movie.favoritedAtMillis;
        this.isWatched = movie.isWatched;
        this.watchedDate = movie.watchedDate;
        this.watchHistory = movie.watchHistory;
        return this;
    }

    /**
     * Metodo per clonare l'oggetto con modifiche (simile a Kotlin data class)
     */
    public copy(update: Partial<Movie> & { releasedStr?: string }): Movie {
        const newMovie = new Movie(
            update.id ?? this.id,
            update.title ?? this.title,
            update.overview ?? this.overview,
            update.releasedStr ?? this.released?.toISOString().split('T')[0] ?? null,
            update.runtime ?? this.runtime,
            update.trailer ?? this.trailer,
            update.quality ?? this.quality,
            update.rating ?? this.rating,
            update.poster ?? this.poster,
            update.banner ?? this.banner,
            update.imdbId ?? this.imdbId,
            update.providerName ?? this.providerName,
            update.genres ?? [...this.genres],
            update.directors ?? [...this.directors],
            update.cast ?? [...this.cast],
            update.recommendations ?? [...this.recommendations],
            update.isFavorite ?? this.isFavorite,
            update.adult ?? this.adult
        );

        newMovie.favoritedAtMillis = update.favoritedAtMillis ?? this.favoritedAtMillis;
        newMovie.isWatched = update.isWatched ?? this.isWatched;
        newMovie.watchedDate = update.watchedDate ?? this.watchedDate;
        newMovie.watchHistory = update.watchHistory ?? this.watchHistory;
        newMovie.details = update.details ?? this.details;
        
        if (update.itemType || this.itemType) {
            newMovie.itemType = update.itemType ?? this.itemType;
        }

        return newMovie;
    }

    public equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof Movie)) return false;

        return (
            this.id === other.id &&
            this.title === other.title &&
            this.isFavorite === other.isFavorite &&
            this.isWatched === other.isWatched &&
            this.itemType === other.itemType &&
            JSON.stringify(this.genres) === JSON.stringify(other.genres) &&
            this.released?.getTime() === other.released?.getTime()
        );
    }
}