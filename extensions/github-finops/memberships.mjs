import {validateCenterId} from "./cost-centers.mjs";
import {GitHubReadError} from "./github.mjs";
import {normalizeUsername} from "./ui/user-format.mjs";

export async function loadResourceMemberships({enterprise, host}, read, type, name) {
    if (!["user", "team"].includes(type)) throw new Error("Invalid membership resource type.");
    const base = `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/cost-centers/memberships`;
    const memberships = [];
    const ids = new Set();
    for (let page = 1; ; page++) {
        let response;
        try {
            response = await read(`${base}?resource_type=${type}&name=${encodeURIComponent(name)}&per_page=100&page=${page}`, host);
        } catch (error) {
            if (error.retryAt) throw error;
            if (error.status === 404) throw new GitHubReadError(
                `${type === "user" ? "User" : "Enterprise team"} memberships unavailable: the resource or endpoint is not visible to this account.`, null, 404);
            if (error.status === 401 || error.status === 403) throw new GitHubReadError(
                `Access denied while reading ${type} memberships. Check the active gh account and enterprise billing permissions.`, null, error.status);
            throw error;
        }
        const identifier = response.resource?.identifier?.[type === "user" ? "login" : "slug"];
        if (response.resource?.type !== type || typeof identifier !== "string" ||
            (type === "user" ? normalizeUsername(identifier) !== name : identifier !== name) ||
            !Array.isArray(response.memberships) ||
            (response.has_next_page != null && typeof response.has_next_page !== "boolean") ||
            (response.has_next_page && response.memberships.length === 0)) {
            throw new Error(`GitHub returned incomplete or mismatched ${type} memberships.`);
        }
        for (const membership of response.memberships) {
            const center = membership.cost_center;
            validateCenterId(center?.id);
            if (typeof center.name !== "string" || !center.name.length || ids.has(center.id)) {
                throw new Error(`GitHub returned invalid or repeated ${type} memberships.`);
            }
            ids.add(center.id);
            memberships.push({id: center.id, name: center.name});
        }
        if (!response.has_next_page) return memberships;
    }
}
