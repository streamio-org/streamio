import { Season } from './Season.js';
import { Genre } from './Genre.js';
import { People } from './People.js';
import { Show } from './Show.js';
import { Episode } from './Episode.js';
import { AppAdapter, AppItem, ItemType } from '../adapters/AppAdapter.js';
import { Movie } from './Movie.js';
import { ShowDetails } from './ShowDetails.js';

export class TvShow implements AppItem {
    public id: string;
    public title: string;
    public overview: string | null;
    public runtime: number | null;
    public trailer: string | null;
    public quality: string | null;
    public rating: number | null;
    public poster: string | null;
    public banner: string | null;

    public imdbId: string | null;
    public providerName: string | null;
    public seasons: Season[];
    public genres: Genre[];
    public directors: People[];
    public cast: People[];
    public recommendations: Show[];

    public isFavorite: boolean;
    public released: Date | null;
    public favoritedAtMillis: number | null = null;
    public isWatching: boolean = true;

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
        seasons: Season[] = [],
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
        this.seasons = seasons;
        this.genres = genres;
        this.directors = directors;
        this.cast = cast;
        this.recommendations = recommendations;
        this.isFavorite = isFavorite;
        this.adult = adult;
        this.released = releasedStr ? new Date(releasedStr) : null;
    }

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
     * Getter che calcola l'episodio da guardare.
     * Implementa la stessa logica di priorità della versione Kotlin.
     */
    get episodeToWatch(): Episode | null {
        // 1. Ordina stagioni (Stagione 0/Speciali per ultima)
        const sortedSeasons = [...this.seasons].sort((a, b) => {
            if (a.number === 0) return 1;
            if (b.number === 0) return -1;
            return a.number - b.number;
        });

        // 2. Appiattisce tutti gli episodi iniettando i riferimenti circolari
        const allEpisodes: Episode[] = sortedSeasons.flatMap(season => {
            return [...season.episodes]
                .sort((a, b) => a.number - b.number)
                .map(episode => {
                    episode.season = season;
                    episode.tvShow = this;
                    return episode;
                });
        });

        // 3. Logica di selezione:
        // A. Ultimo episodio iniziato (watchHistory presente)
        const inProgress = allEpisodes
            .filter(e => e.watchHistory != null)
            .sort((a, b) => (b.watchHistory?.lastEngagementTimeUtcMillis ?? 0) - (a.watchHistory?.lastEngagementTimeUtcMillis ?? 0))[0];

        if (inProgress) return inProgress;

        // B. Episodio successivo all'ultimo visto interamente
        const lastWatchedIndex = allEpisodes.map(e => e.isWatched).lastIndexOf(true);
        if (lastWatchedIndex !== -1 && lastWatchedIndex + 1 < allEpisodes.length) {
            return allEpisodes[lastWatchedIndex + 1] ?? null;
        }

        // C. Primo episodio della prima stagione regolare (non speciale)
        const firstRegularSeason = sortedSeasons.find(s => s.number !== 0);
        if (firstRegularSeason && firstRegularSeason.episodes.length > 0) {
            const firstEpisode = [...firstRegularSeason.episodes].sort((a, b) => a.number - b.number)[0];
            return firstEpisode ?? null;
        }

        // D. Fallback assoluto
        return allEpisodes[0] || null;
    }

    public isSame(tvShow: TvShow): boolean {
        return (
            this.isFavorite === tvShow.isFavorite &&
            this.favoritedAtMillis === tvShow.favoritedAtMillis &&
            this.isWatching === tvShow.isWatching
        );
    }

    public merge(tvShow: TvShow): TvShow {
        this.isFavorite = tvShow.isFavorite;
        this.favoritedAtMillis = tvShow.favoritedAtMillis;
        this.isWatching = tvShow.isWatching;
        return this;
    }

    public copy(update: Partial<TvShow> & { releasedStr?: string }): TvShow {
        const newTv = new TvShow(
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
            update.seasons ?? [...this.seasons],
            update.genres ?? [...this.genres],
            update.directors ?? [...this.directors],
            update.cast ?? [...this.cast],
            update.recommendations ?? [...this.recommendations],
            update.isFavorite ?? this.isFavorite,
            update.adult ?? this.adult
        );
        newTv.isWatching = update.isWatching ?? this.isWatching;
        newTv.favoritedAtMillis = update.favoritedAtMillis ?? this.favoritedAtMillis;
        newTv.details = update.details ?? this.details;
        if (update.itemType || this.itemType) newTv.itemType = update.itemType ?? this.itemType;
        return newTv;
    }

    public equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof TvShow)) return false;
        return (
            this.id === other.id &&
            this.isWatching === other.isWatching &&
            this.isFavorite === other.isFavorite &&
            JSON.stringify(this.seasons) === JSON.stringify(other.seasons)
        );
    }
}