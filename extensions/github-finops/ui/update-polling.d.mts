export function pollUpdates(check: () => Promise<void>, onError: (error: unknown) => void): () => void;
