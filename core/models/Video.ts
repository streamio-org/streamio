// --- Sottoclassi e Interfacce di supporto ---

export interface Subtitle {
    label: string;
    file: string;
    default: boolean;
    initialDefault: boolean;
}

// Namespace per organizzare i tipi interni come in Kotlin
export namespace VideoType {
    
    export interface Movie {
        kind: 'movie'; // Discriminante
        id: string;
        title: string;
        releaseDate: string;
        poster: string;
        imdbId: string | null;
    }

    export interface Episode {
        kind: 'episode'; // Discriminante
        id: string;
        number: number;
        title: string | null;
        poster: string | null;
        overview: string | null;
        tvShow: {
            id: string;
            title: string;
            poster: string | null;
            banner: string | null;
            releaseDate: string | null;
            imdbId: string | null;
        };
        season: {
            number: number;
            title: string | null;
        };
    }

    // Unione discriminata (Equivalente alla Sealed Class)
    export type Type = Movie | Episode;
}

// --- Classe Principale ---

export class Video {
    constructor(
        public source: string,
        public subtitles: Subtitle[] = [],
        public headers: Record<string, string> | null = null,
        public type: VideoType.Type | null = null,
        public extraBuffering: boolean = false,
        public useServerSubtitleSetting: boolean = false
    ) {}

    // Metodo helper per clonare (visto che era una data class)
    public copy(update: Partial<Video>): Video {
        return new Video(
            update.source ?? this.source,
            update.subtitles ?? [...this.subtitles],
            update.headers ?? (this.headers ? { ...this.headers } : null),
            update.type ?? this.type,
            update.extraBuffering ?? this.extraBuffering,
            update.useServerSubtitleSetting ?? this.useServerSubtitleSetting
        );
    }
}

// --- Classe Server ---

export class Server {
    public video: Video | null = null;

    constructor(
        public id: string,
        public name: string,
        public src: string = ""
    ) {}
}