import { AppAdapter, AppItem, ItemType } from '../adapters/AppAdapter.js';

export class Category implements AppItem {
    // Proprietà dal costruttore Kotlin
    public name: string;
    public list: AppItem[];

    // Proprietà inizializzate nel corpo della classe
    public selectedIndex: number = 0;
    public itemSpacing: number = 0;

    // lateinit var in Kotlin -> ! in TS (definite assignment assertion)
    public itemType!: ItemType;

    // Companion Object -> Proprietà statiche in TS
    public static readonly FEATURED = "In evidenza";
    public static readonly CONTINUE_WATCHING = "Continua a guardare";
    public static readonly FAVORITE_MOVIES = "Film preferiti";
    public static readonly FAVORITE_TV_SHOWS = "Serie TV preferite";

    constructor(name: string, list: AppItem[] = []) {
        this.name = name;
        this.list = list;
    }

    /**
     * Riproduce il metodo copy() delle data class.
     * Accetta un oggetto parziale per sovrascrivere le proprietà.
     */
    public copy(update: Partial<Category>): Category {
        const newCategory = new Category(
            update.name ?? this.name,
            update.list ?? [...this.list]
        );
        newCategory.selectedIndex = update.selectedIndex ?? this.selectedIndex;
        newCategory.itemSpacing = update.itemSpacing ?? this.itemSpacing;
        
        if (update.itemType || this.itemType) {
            newCategory.itemType = update.itemType ?? this.itemType;
        }
        
        return newCategory;
    }

    /**
     * Confronto profondo per verificare l'uguaglianza dei contenuti
     */
    public equals(other: any): boolean {
        if (this === other) return true;
        if (!(other instanceof Category)) return false;

        return (
            this.name === other.name &&
            this.selectedIndex === other.selectedIndex &&
            this.itemSpacing === other.itemSpacing &&
            this.itemType === other.itemType &&
            JSON.stringify(this.list) === JSON.stringify(other.list)
        );
    }
}