import { TvShow } from './TvShow.js';
import { Episode } from './Episode.js';
import { AppAdapter, AppItem, ItemType } from '../adapters/AppAdapter.js';

export class Season implements AppItem {
    public id: string;
    public number: number;
    public title: string | null;
    public poster: string | null;
    public tvShow: TvShow | null;
    public episodes: Episode[];

    /**
     * Season-level metadata a source may publish alongside the number. Assigned
     * after construction, like `Movie.details`, so the positional constructor
     * every provider calls stays as it is; `undefined` means "not published".
     */
    public overview: string | null = null;
    /** Episodes the source claims for this season, which may exceed what it can play. */
    public episodeCount: number | null = null;
    /** First air date of the season, ISO where the source gives one. */
    public released: string | null = null;

    // lateinit var -> definite assignment assertion (!)
    public itemType!: ItemType;

    constructor(
        id: string = "",
        number: number = 0,
        title: string | null = null,
        poster: string | null = null,
        tvShow: TvShow | null = null,
        episodes: Episode[] = []
    ) {
        this.id = id;
        this.number = number;
        this.title = title;
        this.poster = poster;
        this.tvShow = tvShow;
        this.episodes = episodes;
    }

    /**
     * Riproduce il metodo copy() di Kotlin.
     */
    public copy(update: Partial<Season>): Season {
        const newSeason = new Season(
            update.id ?? this.id,
            update.number ?? this.number,
            update.title ?? this.title,
            update.poster ?? this.poster,
            update.tvShow ?? this.tvShow,
            update.episodes ?? [...this.episodes]
        );

        newSeason.overview = update.overview ?? this.overview;
        newSeason.episodeCount = update.episodeCount ?? this.episodeCount;
        newSeason.released = update.released ?? this.released;

        if (update.itemType || this.itemType) {
            newSeason.itemType = update.itemType ?? this.itemType;
        }

        return newSeason;
    }

    /**
     * Uguaglianza strutturale profonda
     */
    public equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof Season)) return false;

        return (
            this.id === other.id &&
            this.number === other.number &&
            this.title === other.title &&
            this.poster === other.poster &&
            this.itemType === other.itemType &&
            // Confronto veloce degli oggetti/liste tramite stringhifizzazione
            JSON.stringify(this.tvShow) === JSON.stringify(other.tvShow) &&
            JSON.stringify(this.episodes) === JSON.stringify(other.episodes)
        );
    }
}