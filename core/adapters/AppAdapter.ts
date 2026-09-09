export enum ItemType {
    CATEGORY_MOBILE_ITEM,
    CATEGORY_TV_ITEM,

    CATEGORY_MOBILE_SWIPER,
    CATEGORY_TV_SWIPER,

    EPISODE_MOBILE_ITEM,
    EPISODE_TV_ITEM,
    EPISODE_CONTINUE_WATCHING_MOBILE_ITEM,
    EPISODE_CONTINUE_WATCHING_TV_ITEM,

    FOOTER,

    GENRE_GRID_MOBILE_ITEM,
    GENRE_GRID_TV_ITEM,

    HEADER,

    LOADING_ITEM,

    MOVIE_MOBILE_ITEM,
    MOVIE_TV_ITEM,
    MOVIE_CONTINUE_WATCHING_MOBILE_ITEM,
    MOVIE_CONTINUE_WATCHING_TV_ITEM,
    MOVIE_GRID_MOBILE_ITEM,
    MOVIE_GRID_TV_ITEM,
    MOVIE_SWIPER_MOBILE_ITEM,

    MOVIE_MOBILE,
    MOVIE_TV,
    MOVIE_DIRECTORS_MOBILE,
    MOVIE_DIRECTORS_TV,
    MOVIE_CAST_MOBILE,
    MOVIE_CAST_TV,
    MOVIE_RECOMMENDATIONS_MOBILE,
    MOVIE_RECOMMENDATIONS_TV,

    PEOPLE_MOBILE_ITEM,
    PEOPLE_TV_ITEM,

    PROVIDER_MOBILE_ITEM,
    PROVIDER_TV_ITEM,

    SEASON_MOBILE_ITEM,
    SEASON_TV_ITEM,

    TV_SHOW_MOBILE_ITEM,
    TV_SHOW_TV_ITEM,
    TV_SHOW_GRID_MOBILE_ITEM,
    TV_SHOW_GRID_TV_ITEM,
    TV_SHOW_SWIPER_MOBILE_ITEM,

    TV_SHOW_MOBILE,
    TV_SHOW_TV,
    TV_SHOW_SEASONS_MOBILE,
    TV_SHOW_SEASONS_TV,
    TV_SHOW_DIRECTORS_MOBILE,
    TV_SHOW_DIRECTORS_TV,
    TV_SHOW_CAST_MOBILE,
    TV_SHOW_CAST_TV,
    TV_SHOW_RECOMMENDATIONS_MOBILE,
    TV_SHOW_RECOMMENDATIONS_TV,
}

export interface AppItem {
    itemType: ItemType;
}

import { Movie, TvShow, Genre, People, Episode, Season, Provider, Category } from '../models/index.js';

export class AppAdapter {
    public items: AppItem[] = [];
    public isLoading: boolean = false;

    // Listeners (simili a quelli di Kotlin)
    public onMovieClickListener?: (movie: Movie) => void;
    public onTvShowClickListener?: (tvShow: TvShow) => void;
    public onGenreClickListener?: (genre: Genre) => void;
    public onLoadMoreListener?: () => void;

    private states: Map<number, any> = new Map();

    constructor(initialItems: AppItem[] = []) {
        this.items = initialItems;
    }

    /**
     * Simula il getItemCount() considerando Header, Footer e Loading
     */
    public getItemCount(): number {
        let count = this.items.length;
        if (this.onLoadMoreListener) count++;
        // Header e Footer logica opzionale qui
        return count;
    }

    /**
     * Logica per generare una chiave di identità (simile a identityAt)
     */
    private getItemIdentity(position: number): string {
        const item = this.items[position];
        if (!item) {
            throw new RangeError(`Invalid item position: ${position}`);
        }

        const baseKey = this.getBaseIdentityKey(item);
        
        // Conta occorrenze precedenti per gestire duplicati nella lista
        const occurrenceIndex = this.items
            .slice(0, position)
            .filter(it => it.itemType === item.itemType && this.getBaseIdentityKey(it) === baseKey)
            .length;

        return `${item.itemType}:${baseKey}:${occurrenceIndex}`;
    }

    private getBaseIdentityKey(item: AppItem): string {
        if (item instanceof Movie) return `movie:${item.id}`;
        if (item instanceof TvShow) return `tvshow:${item.id}`;
        if (item instanceof Category) return `category:${item.name}`;
        // ... continua per gli altri modelli
        return `item:${item.itemType}`;
    }

    /**
     * Metodo per aggiornare la lista (Simile a submitList)
     */
    public submitList(newList: AppItem[]): void {
        // Qui solitamente si delega al framework (es. React state)
        // Ma salviamo lo stato come facevi in Kotlin
        this.items = [...newList];
        this.isLoading = false;
    }

    // Gestione dello stato del LayoutManager
    public saveState(position: number, state: any): void {
        this.states.set(position, state);
    }

    public getState(position: number): any {
        return this.states.get(position);
    }
}