export function resourceTypeLabels(resources?: readonly {type: string}[] | null, complete?: boolean): string[];

export function paginateCenters<T extends {name: string; id: string; state?: string | null}>(
    centers: T[], query: string, requestedPage: number
): {items: T[]; total: number; pages: number; page: number; start: number; end: number};
