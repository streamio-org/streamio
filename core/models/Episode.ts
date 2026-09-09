import { AppItem, ItemType } from '../adapters/AppAdapter.js';
import { TvShow } from './TvShow.js';
import { Season } from './Season.js';

// Assumendo che WatchItem sia un'interfaccia simile a questa:
export interface WatchItem {
    isWatched: boolean;
    watchedDate?: Date | null;
    watchHistory?: WatchHistory | null;
}

export interface WatchHistory {
    lastEngagementTimeUtcMillis: number;
    // ... altri campi necessari
}

export class Episode implements WatchItem, AppItem {
    public id: string;
    public number: number;
    public title: string | null;
    public poster: string | null;
    public overview: string | null;
    public tvShow: TvShow | null;
    public season: Season | null;
    
    /**
     * Per-episode metadata a source may publish alongside the number. Assigned
     * after construction, like `Movie.details`/`Season.overview`, so the
     * positional constructor every provider calls stays as it is.
     * `null` means "not published", never a default.
     */
    /** Runtime in minutes. */
    public runtime: number | null = null;
    /** Encode quality as the source labels it ("HD", "1080p"). */
    public quality: string | null = null;
    /** Italian dub available for this episode specifically. */
    public dubIta: boolean | null = null;
    /** Italian subtitles available for this episode specifically. */
    public subIta: boolean | null = null;

    // Campi gestiti internamente o ereditati
    public released: Date | null;
    public isWatched: boolean = false;
    public watchedDate: Date | null = null;
    public watchHistory: WatchHistory | null = null;
    public itemType!: ItemType;

    constructor(
        id: string = "",
        number: number = 0,
        title: string | null = null,
        releasedStr: string | null = null, // Riceve la stringa e la converte
        poster: string | null = null,
        overview: string | null = null,
        tvShow: TvShow | null = null,
        season: Season | null = null
    ) {
        this.id = id;
        this.number = number;
        this.title = title;
        this.poster = poster;
        this.overview = overview;
        this.tvShow = tvShow;
        this.season = season;
        this.released = releasedStr ? new Date(releasedStr) : null;
    }

    /**
     * Confronta se lo stato di visione è identico
     */
    public isSame(episode: Episode): boolean {
        return (
            this.isWatched === episode.isWatched &&
            this.watchedDate?.getTime() === episode.watchedDate?.getTime() &&
            JSON.stringify(this.watchHistory) === JSON.stringify(episode.watchHistory)
        );
    }

    /**
     * Unisce i dati di visione da un altro episodio (Merge)
     */
    public merge(episode: Episode): Episode {
        this.isWatched = episode.isWatched;
        this.watchedDate = episode.watchedDate;
        this.watchHistory = episode.watchHistory;
        return this;
    }

    /**
     * Clona l'oggetto con possibilità di sovrascrivere i campi
     */
    public copy(update: Partial<Episode> & { releasedStr?: string }): Episode {
        const newEpisode = new Episode(
            update.id ?? this.id,
            update.number ?? this.number,
            update.title ?? this.title,
            update.releasedStr ?? this.released?.toISOString().split('T')[0] ?? null,
            update.poster ?? this.poster,
            update.overview ?? this.overview,
            update.tvShow ?? this.tvShow,
            update.season ?? this.season
        );

        newEpisode.runtime = update.runtime ?? this.runtime;
        newEpisode.quality = update.quality ?? this.quality;
        newEpisode.dubIta = update.dubIta ?? this.dubIta;
        newEpisode.subIta = update.subIta ?? this.subIta;
        newEpisode.isWatched = update.isWatched ?? this.isWatched;
        newEpisode.watchedDate = update.watchedDate ?? this.watchedDate;
        newEpisode.watchHistory = update.watchHistory ?? this.watchHistory;
        
        if (update.itemType || this.itemType) {
            newEpisode.itemType = update.itemType ?? this.itemType;
        }

        return newEpisode;
    }

    /**
     * Uguaglianza profonda
     */
    public equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof Episode)) return false;

        return (
            this.id === other.id &&
            this.number === other.number &&
            this.title === other.title &&
            this.poster === other.poster &&
            this.overview === other.overview &&
            this.isWatched === other.isWatched &&
            this.itemType === other.itemType &&
            this.released?.getTime() === other.released?.getTime() &&
            // Confronto semplificato per oggetti complessi
            JSON.stringify(this.tvShow) === JSON.stringify(other.tvShow) &&
            JSON.stringify(this.season) === JSON.stringify(other.season)
        );
    }
}