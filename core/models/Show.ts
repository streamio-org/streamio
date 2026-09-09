import { AppAdapter } from '../adapters/AppAdapter.js';

/**
 * In TypeScript, le interfacce possono estendere altre interfacce.
 * Per simulare il comportamento di una "sealed interface" (che limita le sottoclassi),
 * di solito si definisce l'interfaccia e poi si creano i tipi specifici.
 */
export interface Show extends AppAdapter {
    isFavorite: boolean;
}