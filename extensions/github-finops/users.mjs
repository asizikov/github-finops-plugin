import {normalizeBudget} from "./budgets.mjs";
import {normalizeBudgetRecord, validateBudgetId} from "./budget-list.mjs";
import {GitHubReadError} from "./github.mjs";
import {normalizeUsername} from "./ui/user-format.mjs";
import {loadResourceMemberships} from "./memberships.mjs";
import {loadEnterpriseTeams, enterpriseTeamFailure} from "./enterprise-teams.mjs";
import {collectAttribution, evidenceFailure} from "./attribution.mjs";

async function userRead(read, path, host, stage) {
    try { return await read(path, host); } catch (error) {
        if (error.retryAt) throw error;
        if (error.status === 404) throw new GitHubReadError(stage === "profile"
            ? "User not found or not visible to the active account on this GitHub host."
            : `User ${stage} unavailable: the endpoint or enterprise membership is not visible to this account.`, null, 404);
        if (error.status === 401 || error.status === 403) {
            throw new GitHubReadError(`Access denied while reading user ${stage}. Check the active gh account and enterprise billing permissions.`, null, error.status);
        }
        throw error;
    }
}

function effectiveBudget(value) {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned an invalid effective budget.");
    const {amount, consumed} = normalizeBudget(value, "user");
    return {id: validateBudgetId(value.id), amount, consumed};
}

export async function loadUser({enterprise, host}, read, username, now = new Date()) {
    const requested = normalizeUsername(username);
    const profile = await userRead(read, `/users/${encodeURIComponent(requested)}`, host, "profile");
    if (typeof profile.login !== "string" || !Number.isSafeInteger(profile.id) || profile.id < 1 ||
        !["User", "Bot"].includes(profile.type)) throw new Error("GitHub did not return a valid user account.");
    const login = normalizeUsername(profile.login);
    const base = `/enterprises/${encodeURIComponent(enterprise)}/settings/billing`;
    let membershipEvidence;
    try {
        membershipEvidence = {state: "complete", items: await loadResourceMemberships({enterprise, host}, read, "user", login)};
    } catch (error) { membershipEvidence = {...evidenceFailure(error), items: []}; }
    const memberships = membershipEvidence.items;
    const budgets = [];
    const budgetIds = new Set();
    let effective = null;
    let effectiveStatus = "not_returned";
    let filterVerified = true;
    let effectiveSeen = false;
    for (let page = 1; ; page++) {
        const response = await userRead(read,
            `${base}/budgets?user=${encodeURIComponent(login)}&per_page=100&page=${page}`, host, "budgets");
        if (!Array.isArray(response.budgets) || typeof response.has_next_page !== "boolean" ||
            (response.has_next_page && response.budgets.length === 0)) throw new Error("GitHub returned an incomplete user budget list.");
        if (response.user == null) filterVerified = false;
        else if (typeof response.user !== "string" || normalizeUsername(response.user) !== login) {
            throw new Error("GitHub returned budgets for a different user.");
        }
        if (response.effective_budget !== undefined) {
            const next = effectiveBudget(response.effective_budget);
            if (effectiveSeen && JSON.stringify(next) !== JSON.stringify(effective)) {
                throw new Error("The effective user budget changed while paginating. Refresh to retry.");
            }
            effective = next;
            effectiveSeen = true;
            effectiveStatus = effective ? "reported" : "none_reported";
        }
        for (const raw of response.budgets) {
            const budget = normalizeBudgetRecord(raw);
            if (budgetIds.has(budget.id)) throw new Error("GitHub repeated user budgets while paginating.");
            budgetIds.add(budget.id);
            budgets.push({...budget, lookupSource: "user_filter"});
        }
        if (!response.has_next_page) break;
    }
    if (effective && !budgetIds.has(effective.id)) {
        const raw = await userRead(read, `${base}/budgets/${effective.id}`, host, "effective budget configuration");
        const budget = normalizeBudgetRecord(raw);
        if (budget.id !== effective.id) throw new Error("GitHub returned an unexpected effective budget identity.");
        // Detail consumption is not user-filtered, so it must not become this user's consumption.
        budgets.push({...budget, consumed: null, lookupSource: "effective_detail"});
    }
    let enterpriseTeams;
    try {
        enterpriseTeams = {items: await loadEnterpriseTeams({enterprise, host}, read, login),
            fetchedAt: now.toISOString(), error: null, status: 200};
    } catch (error) {
        enterpriseTeams = enterpriseTeamFailure(error);
    }
    const attribution = await collectAttribution({enterprise, host}, read, login, membershipEvidence, enterpriseTeams, now);
    return {login: profile.login, id: profile.id, accountType: profile.type, enterpriseTeams, attribution,
        period: {year: now.getUTCFullYear(), month: now.getUTCMonth() + 1},
        memberships, budgets, effective, effectiveStatus, filterVerified};
}
