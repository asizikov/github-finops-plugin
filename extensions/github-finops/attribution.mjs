import {loadCostCenters} from "./cost-centers.mjs";
import {loadResourceMemberships} from "./memberships.mjs";
import {normalizeUsername} from "./ui/user-format.mjs";

const complete = data => ({state: "complete", ...data});
const skipped = reason => ({state: "not_checked", reason});

export function evidenceFailure(error) {
    if (["local_cache_error", "cache_cleared"].includes(error.code)) throw error;
    console.error("Attribution evidence read failed:", error);
    return {state: "unavailable", status: error.status ?? null,
        reason: error.retryAt ? "Rate limited; refresh after the cooldown."
            : error.status === 401 || error.status === 403
                ? `Access denied (HTTP ${error.status}); verify existing read permissions in Settings. Authentication was not changed.`
                : error.status === 404 ? "Endpoint or resource not visible (HTTP 404); absence is not confirmed."
                    : "Evidence could not be verified; refresh to retry."};
}

export function resolveAttribution(evidence) {
    const alternatives = [];
    const unresolved = [];
    const result = (method, center, reason, confirmed = true) => ({
        status: confirmed ? "confirmed" : center ? "provisional" : "unresolved",
        method, center, reason, checkedAt: evidence.checkedAt, alternatives, unresolved,
    });
    const direct = evidence.direct;
    for (const candidate of direct.candidates ?? []) alternatives.push({...candidate,
        method: "direct", reason: candidate.explicit ? "Explicit user resource." : "Membership alone is not a direct user assignment."});
    const explicit = (direct.candidates ?? []).filter(item => item.explicit);
    if (direct.state !== "complete" || explicit.length > 1) {
        unresolved.push(direct.reason ?? (explicit.length > 1 ? "Multiple explicit user assignments; no unique center." : "Direct assignment checks incomplete."));
        return result("direct", explicit.length === 1 ? explicit[0].center : null, unresolved[0], false);
    }
    if (explicit.length === 1) return result("direct", explicit[0].center, "Membership lookup and explicit user resource confirm direct assignment.");

    const teams = evidence.teams;
    const qualifying = [];
    for (const team of teams.items ?? []) {
        for (const center of team.centers ?? []) qualifying.push({team, center});
        alternatives.push({method: "team", name: team.name, slug: team.slug, htmlUrl: team.htmlUrl,
            createdAt: team.createdAt, centers: team.centers ?? [],
            reason: team.state !== "complete" ? team.reason : !team.centers.length
                ? "No cost center assigned to this team." : "Team assignment; oldest qualifying team takes precedence."});
    }
    if (teams.state !== "complete" || (teams.items ?? []).some(team => team.state !== "complete" || team.centers.length > 1)) {
        unresolved.push(teams.reason ?? "Team assignments are incomplete or ambiguous.");
        return result("team", null, unresolved[0], false);
    }
    if (qualifying.length) {
        if (qualifying.some(({team}) => !team.createdAt || !Number.isFinite(Date.parse(team.createdAt)))) {
            unresolved.push("A qualifying team has no valid creation date; precedence cannot be established.");
            return result("team", null, unresolved[0], false);
        }
        qualifying.sort((a, b) => Date.parse(a.team.createdAt) - Date.parse(b.team.createdAt));
        if (qualifying.length > 1 && Date.parse(qualifying[0].team.createdAt) === Date.parse(qualifying[1].team.createdAt)) {
            unresolved.push("Oldest qualifying teams have tied creation dates; no team winner is inferred.");
            return result("team", null, unresolved[0], false);
        }
        const winner = qualifying[0];
        for (const alternative of alternatives.filter(item => item.method === "team")) {
            if (alternative.centers.length) alternative.reason = alternative.slug === winner.team.slug
                ? "Selected: oldest qualifying team." : "Not selected: a qualifying team was created earlier.";
        }
        return result("team", winner.center, `Oldest qualifying enterprise team: ${winner.team.name} (${winner.team.createdAt}).`);
    }

    const license = evidence.license;
    for (const organization of license.organizations ?? []) alternatives.push({
        method: "organization", name: organization.name, centers: organization.centers ?? [],
        reason: license.organizations.length > 1 ? "Multiple seat-granting organizations; current billing organization is not confirmed."
            : organization.reason ?? (organization.centers?.length ? "Sole confirmed Copilot license organization." : "No assigned cost center."),
    });
    if (license.state !== "complete" || license.organizations?.length > 1 || license.unaffiliated ||
        (license.organizations ?? []).some(org => org.state !== "complete" || org.centers.length > 1)) {
        unresolved.push(license.reason ?? "Copilot billing organization or its cost center is ambiguous or incomplete. A detailed usage report may identify the charged organization.");
        return result("organization", null, unresolved[0], false);
    }
    const organization = license.organizations?.[0];
    if (organization?.centers.length === 1) return result("organization", organization.centers[0],
        `Only one Copilot license organization was returned: ${organization.name}; it is assigned to this center.`);
    return result("enterprise", null, "All higher-priority checks completed; no applicable cost center assignment was found.");
}

export async function collectAttribution(config, read, login, memberships, enterpriseTeams, now = new Date()) {
    const checkedAt = now.toISOString();
    const evidence = {checkedAt, direct: memberships, teams: skipped("Direct assignment takes precedence."),
        license: skipped("Direct or team assignment takes precedence.")};
    if (memberships.state === "complete") {
        const candidates = [];
        const errors = [];
        for (const member of memberships.items) {
            try {
                const center = await loadCostCenters(config, read, member.id);
                if (center.state && center.state !== "active") throw new Error("Cost center is not active.");
                candidates.push({center: {id: center.id, name: center.name},
                    explicit: center.resources.some(resource => resource.type === "User" &&
                        resource.name.toLowerCase() === login.toLowerCase())});
            } catch (error) { errors.push(evidenceFailure(error)); }
        }
        evidence.direct = {...(errors.length ? errors[0] : complete({})), candidates};
    }
    if (evidence.direct.state === "complete" && !evidence.direct.candidates.some(item => item.explicit)) {
        if (enterpriseTeams.error || enterpriseTeams.items == null) evidence.teams = {
            state: "unavailable", reason: enterpriseTeams.error ?? "Enterprise teams were not checked."};
        else {
            const items = [];
            for (const team of enterpriseTeams.items) {
                try { items.push({...team, ...complete({centers: await loadResourceMemberships(config, read, "team", team.slug)})}); }
                catch (error) { items.push({...team, ...evidenceFailure(error), centers: []}); }
            }
            evidence.teams = complete({items});
        }
        if (evidence.teams.state === "complete" && evidence.teams.items.every(team =>
            team.state === "complete" && team.centers.length === 0)) {
            evidence.license = await collectLicense(config, read, login);
        }
    }
    return {evidence, ...resolveAttribution(evidence)};
}

async function collectLicense({enterprise, host}, read, login) {
    try {
        const organizations = new Map();
        const users = new Set();
        let unaffiliated = false;
        const pages = new Set();
        let total;
        for (let page = 1; ; page++) {
            const response = await read(`/enterprises/${encodeURIComponent(enterprise)}/copilot/billing/seats?per_page=100&page=${page}`, host);
            if (!Array.isArray(response.seats) || response.seats.length > 100 ||
                !Number.isSafeInteger(response.total_seats) || response.total_seats < 0 ||
                (total !== undefined && total !== response.total_seats)) throw new Error("Incomplete Copilot seat list.");
            total = response.total_seats;
            const fingerprint = JSON.stringify(response.seats);
            if (response.seats.length && pages.has(fingerprint)) throw new Error("Repeated Copilot seat page.");
            pages.add(fingerprint);
            for (const seat of response.seats) {
                if (typeof seat.assignee?.login !== "string") throw new Error("Missing Copilot assignee.");
                const assignee = normalizeUsername(seat.assignee.login);
                users.add(assignee);
                if (assignee !== login) continue;
                if (!seat.organization) unaffiliated = true;
                else {
                    const name = normalizeUsername(seat.organization.login);
                    organizations.set(name, {name});
                }
            }
            // total_seats counts unique users, not seat records. A short page ends pagination.
            if (response.seats.length < 100) break;
        }
        if (users.size !== total) throw new Error("Copilot seat count changed or pagination was incomplete.");
        const items = [...organizations.values()];
        if (items.length <= 1 && !unaffiliated) {
            for (const organization of items) {
                try { Object.assign(organization, complete({centers: await loadResourceMemberships(
                    {enterprise, host}, read, "organization", organization.name)})); }
                catch (error) { Object.assign(organization, evidenceFailure(error), {centers: []}); }
            }
        }
        return complete({organizations: items, unaffiliated});
    } catch (error) {
        const failure = evidenceFailure(error);
        if ([401, 403].includes(error.status)) failure.reason +=
            " Enterprise seats accept read:enterprise OR manage_billing:copilot with enterprise owner or billing manager access; prefer existing authorized least privilege.";
        return failure;
    }
}
