/**
 * Interfaccia che definisce le proprietà di un elemento visualizzabile.
 * In TypeScript, usiamo 'interface' per definire il contratto che le classi
 * come Movie o Episode devono implementare.
 */
export interface WatchItem {
    isWatched: boolean;
    watchedDate: Date | null;
    watchHistory: WatchHistory | null;
}

/**
 * Rappresenta i dettagli del progresso di visione.
 * Traduzione della 'data class WatchHistory'.
 */
export interface WatchHistory {
    readonly lastEngagementTimeUtcMillis: number;
    readonly lastPlaybackPositionMillis: number;
    readonly durationMillis: number;
}

/**
 * Utility (opzionale): Un Type Guard per verificare se un oggetto implementa WatchItem.
 */
export function isWatchItem(object: any): object is WatchItem {
    return object && 'isWatched' in object && 'watchHistory' in object;
}