import {normalizeUsername} from "./user-format.mjs";

// Only hosts the onboarding flow accepts; anything else gets no external link.
const HOST = /^(?:github\.com|[a-z0-9][a-z0-9-]*\.ghe\.com)$/;
const ACCOUNT = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
const REPOSITORY = /^[a-zA-Z0-9._-]{1,100}$/;
const ENTERPRISE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/;
const TEAM_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,254}$/;

const validHost = host => typeof host === "string" && HOST.test(host.toLowerCase());
const base = host => `https://${host.toLowerCase()}`;

export function organizationUrl(host, login) {
    if (!validHost(host) || typeof login !== "string" || !ACCOUNT.test(login)) return null;
    return `${base(host)}/${encodeURIComponent(login)}`;
}

export function repositoryUrl(host, fullName) {
    if (!validHost(host) || typeof fullName !== "string") return null;
    const parts = fullName.split("/");
    if (parts.length !== 2) return null;
    const [owner, name] = parts;
    if (!ACCOUNT.test(owner) && !isUserLogin(owner)) return null;
    if (!REPOSITORY.test(name) || name === "." || name === "..") return null;
    return `${base(host)}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

// Route verified against the enterprise teams API html_url: /enterprises/{enterprise}/teams/{slug}.
// Prefixed "ent:" API slugs have no verified web route, so they are not linked.
export function enterpriseTeamUrl(host, enterprise, slug) {
    if (!validHost(host) || typeof enterprise !== "string" || !ENTERPRISE.test(enterprise) ||
        typeof slug !== "string" || !TEAM_SLUG.test(slug)) return null;
    return `${base(host)}/enterprises/${encodeURIComponent(enterprise)}/teams/${encodeURIComponent(slug)}`;
}

// Accept an API-supplied enterprise team html_url only if it is HTTPS on the configured host
// and points at an enterprise team page.
export function trustedEnterpriseTeamUrl(host, value) {
    if (!validHost(host) || typeof value !== "string") return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== host.toLowerCase() || url.port ||
        url.username || url.password || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/enterprises\/([^/]+)\/teams\/([^/]+)\/?$/);
    if (!match) return null;
    let enterprise, slug;
    try { enterprise = decodeURIComponent(match[1]); slug = decodeURIComponent(match[2]); } catch { return null; }
    if (!ENTERPRISE.test(enterprise) || !/^(?:ent:)?[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug)) return null;
    return url.href;
}

function isUserLogin(value) {
    try { return normalizeUsername(value) === value.toLowerCase() && !value.startsWith("@"); }
    catch { return false; }
}

export function userLogin(value) {
    if (typeof value !== "string" || value.trim() !== value || value.startsWith("@")) return null;
    try { return normalizeUsername(value); } catch { return null; }
}

const TYPES = {
    user: "user", org: "organization", organization: "organization",
    repo: "repository", repository: "repository",
    team: "team", enterpriseteam: "team", enterprise_team: "team",
};

export function resourceKind(type) {
    if (typeof type !== "string") return null;
    const key = type.trim().toLowerCase();
    return Object.hasOwn(TYPES, key) ? TYPES[key] : null;
}

// Returns {kind: "user", login} for in-app navigation, {kind: "external", href, type} for
// GitHub pages, or null when the value has no canonical, linkable identity.
export function resourceLink(type, name, {host, enterprise} = {}) {
    const kind = resourceKind(type);
    if (kind === "user") {
        const login = userLogin(name);
        return login ? {kind: "user", login} : null;
    }
    const href = kind === "organization" ? organizationUrl(host, name)
        : kind === "repository" ? repositoryUrl(host, name)
            : kind === "team" ? enterpriseTeamUrl(host, enterprise, name) : null;
    return href ? {kind: "external", type: kind, href} : null;
}

export function budgetEntityLink(budget, target) {
    if (budget.scope === "user") return resourceLink("user", budget.user || budget.entity, target);
    if (budget.scope === "organization") return resourceLink("organization", budget.entity, target);
    if (budget.scope === "repository") return resourceLink("repository", budget.entity, target);
    return null;
}
