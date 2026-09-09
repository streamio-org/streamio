import { Show } from './Show.js';
import { AppAdapter, AppItem, ItemType } from '../adapters/AppAdapter.js';

export class People implements AppItem {
    public id: string;
    public name: string;
    public image: string | null;
    public biography: string | null;
    public placeOfBirth: string | null;
    public filmography: Show[];

    // Proprietà calcolate/convertite
    public birthday: Date | null;
    public deathday: Date | null;

    // Proprietà adapter (lateinit in Kotlin)
    public itemType!: ItemType;

    constructor(
        id: string,
        name: string,
        image: string | null = null,
        biography: string | null = null,
        placeOfBirth: string | null = null,
        birthdayStr: string | null = null,
        deathdayStr: string | null = null,
        filmography: Show[] = []
    ) {
        this.id = id;
        this.name = name;
        this.image = image;
        this.biography = biography;
        this.placeOfBirth = placeOfBirth;
        this.filmography = filmography;
        
        // Conversione stringa -> Date (equivalente a .toCalendar())
        this.birthday = birthdayStr ? new Date(birthdayStr) : null;
        this.deathday = deathdayStr ? new Date(deathdayStr) : null;
    }

    /**
     * Riproduce il metodo copy() di Kotlin.
     * Per le date, accetta stringhe nel formato "yyyy-MM-dd" o le ricava dalle istanze Date.
     */
    public copy(update: Partial<People> & { birthdayStr?: string, deathdayStr?: string }): People {
        const newPeople = new People(
            update.id ?? this.id,
            update.name ?? this.name,
            update.image ?? this.image,
            update.biography ?? this.biography,
            update.placeOfBirth ?? this.placeOfBirth,
            update.birthdayStr ?? this.birthday?.toISOString().split('T')[0] ?? null,
            update.deathdayStr ?? this.deathday?.toISOString().split('T')[0] ?? null,
            update.filmography ?? [...this.filmography]
        );

        if (update.itemType || this.itemType) {
            newPeople.itemType = update.itemType ?? this.itemType;
        }

        return newPeople;
    }

    /**
     * Uguaglianza strutturale profonda
     */
    public equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof People)) return false;

        return (
            this.id === other.id &&
            this.name === other.name &&
            this.image === other.image &&
            this.biography === other.biography &&
            this.placeOfBirth === other.placeOfBirth &&
            this.itemType === other.itemType &&
            this.birthday?.getTime() === other.birthday?.getTime() &&
            this.deathday?.getTime() === other.deathday?.getTime() &&
            JSON.stringify(this.filmography) === JSON.stringify(other.filmography)
        );
    }
}