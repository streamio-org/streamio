import { Show } from './Show.js';
import { AppItem, ItemType } from '../adapters/AppAdapter.js';

export class Genre implements AppItem {
    public id: string;
    public name: string;
    public shows: Show[];
    
    // Corretto: ora punta all'enum ItemType definito nel file dell'adapter
    public itemType: ItemType; 

    constructor(
        id: string,
        name: string,
        shows: Show[] = [],
        itemType: ItemType = ItemType.GENRE_GRID_MOBILE_ITEM // Default corretto
    ) {
        this.id = id;
        this.name = name;
        this.shows = shows;
        this.itemType = itemType;
    }

    public copy({
        id = this.id,
        name = this.name,
        shows = this.shows,
        itemType = this.itemType
    }: Partial<Genre> = {}): Genre {
        return new Genre(id, name, [...shows], itemType);
    }

    public equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof Genre)) return false;

        return (
            this.id === other.id &&
            this.name === other.name &&
            this.itemType === other.itemType &&
            // Confronto strutturale più sicuro per gli show
            this.shows.length === other.shows.length &&
            this.shows.every((show, index) => {
                const otherShow = other.shows[index];
                return otherShow !== undefined && show === otherShow;
            })
        );
    }
}