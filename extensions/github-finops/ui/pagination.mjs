export function resourceTypeLabels(resources, complete = true) {
    if (!Array.isArray(resources)) return ["Unavailable"];
    if (!complete) return ["Unavailable (partial assignments)"];
    if (resources.length === 0) return ["No assigned resources"];
    const labels = {
        org: "Organization", organization: "Organization",
        repo: "Repository", repository: "Repository",
        team: "Enterprise team", user: "User",
    };
    return [...new Set(resources.map(resource =>
        Object.hasOwn(labels, resource.type.trim().toLowerCase())
            ? labels[resource.type.trim().toLowerCase()]
            : resource.type.trim() || "Unknown resource type",
    ))].sort();
}

export function paginateCenters(centers, query, requestedPage) {
    const search = query.trim().toLowerCase();
    const filtered = centers.filter(center => [center.name, center.id, center.state ?? ""]
        .some(value => value.toLowerCase().includes(search)));
    return paginateItems(filtered, requestedPage);
}

export function paginateItems(items, requestedPage) {
    const pages = Math.max(1, Math.ceil(items.length / 25));
    const page = Math.max(1, Math.min(pages, requestedPage));
    const offset = (page - 1) * 25;
    return {
        items: items.slice(offset, offset + 25), total: items.length, pages, page,
        start: items.length ? offset + 1 : 0, end: Math.min(offset + 25, items.length),
    };
}
