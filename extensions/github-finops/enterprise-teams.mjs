import {loadResourceMemberships} from "./memberships.mjs";
import {normalizeUsername} from "./ui/user-format.mjs";

export function validateTeamSlug(slug) {
    if (typeof slug !== "string" || !/^(?:ent:)?[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) {
        throw new Error("Invalid enterprise team slug.");
    }
    return slug;
}

export async function loadEnterpriseTeams({enterprise, host}, read, username) {
    const login = normalizeUsername(username);
    const base = `/enterprises/${encodeURIComponent(enterprise)}/members/${encodeURIComponent(login)}/teams`;
    const teams = [];
    const ids = new Set();
    const slugs = new Set();
    for (let page = 1; ; page++) {
        const response = await read(`${base}?per_page=100&page=${page}`, host);
        if (!Array.isArray(response) || response.length > 100) {
            throw new Error("GitHub returned an invalid enterprise team page.");
        }
        for (const team of response) {
            if (!Number.isSafeInteger(team?.id) || team.id < 1 || typeof team.name !== "string" || !team.name.length) {
                throw new Error("GitHub returned an invalid enterprise team identity.");
            }
            validateTeamSlug(team.slug);
            let url;
            try { url = new URL(team.html_url); } catch { throw new Error("GitHub returned an invalid enterprise team link."); }
            if (url.protocol !== "https:" || url.host.toLowerCase() !== host.toLowerCase() || url.username || url.password) {
                throw new Error("GitHub returned an unexpected enterprise team link host.");
            }
            if (ids.has(team.id) || slugs.has(team.slug)) throw new Error("GitHub repeated enterprise teams while paginating.");
            ids.add(team.id);
            slugs.add(team.slug);
            teams.push({id: team.id, name: team.name, slug: team.slug, htmlUrl: url.href,
                createdAt: typeof team.created_at === "string" && Number.isFinite(Date.parse(team.created_at))
                    ? team.created_at : null});
        }
        if (response.length < 100) return teams;
    }
}

export function enterpriseTeamFailure(error) {
    if (error.code === "local_cache_error") throw error;
    const status = error.status ?? null;
    const message = error.retryAt ? "Enterprise team lookup is rate-limited. Saved teams, if available, have not been refreshed."
        : status === 401 || status === 403
            ? `Enterprise teams access denied (HTTP ${status}). Check classic-token read:enterprise scope and enterprise owner or enterprise_teams:read permission.`
            : status === 404
                ? "Enterprise teams unavailable (HTTP 404). The endpoint or membership may be hidden, access may be missing, or the enterprise may not use the new teams experience. This does not mean the user has no teams."
                : error.publicMessage ?? error.message ?? "Could not read enterprise teams. Refresh to retry.";
    console.error("Enterprise team lookup failed:", error);
    return {items: null, fetchedAt: null, error: message, status};
}

export async function loadTeamCostCenters(config, read, slug) {
    validateTeamSlug(slug);
    return {slug, memberships: await loadResourceMemberships(config, read, "team", slug)};
}
