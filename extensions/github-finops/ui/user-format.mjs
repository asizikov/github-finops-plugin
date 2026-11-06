export function normalizeUsername(value) {
    if (typeof value !== "string") throw new Error("Enter a GitHub username.");
    const login = value.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(login)) {
        throw new Error("Enter a GitHub username, optionally beginning with @, not a profile URL.");
    }
    return login;
}

const isAiCredits = budget => budget.type === "BundlePricing" && budget.product === "ai_credits";
const perUserScopes = ["user", "multi_user_cost_center", "multi_user_customer"];
const priority = scope => ({user: 3, multi_user_cost_center: 2, multi_user_customer: 1})[scope] ?? 0;

function userTarget(budget, login) {
    const target = budget.user || budget.entity;
    return !target ? "unknown" : target.toLowerCase() === login.toLowerCase() ? "match" : "different";
}

function associatedCenter(budget, memberships, relationships) {
    const direct = memberships.find(center => center.id === budget.entity);
    if (direct) return {...direct, matchedBy: "id"};
    const link = relationships?.links.find(link => link.budgetId === budget.id);
    const saved = relationships?.centers.find(center => center.id === link?.centerId);
    if (!saved || !link || !memberships.some(center => center.id === saved.id)) return null;
    if ((link.matchedBy === "id" && budget.entity === saved.id) ||
        (link.matchedBy === "exact_unique_name" && relationships.lists.centers && budget.entity === saved.name)) {
        return {...saved, matchedBy: link.matchedBy};
    }
    return null;
}

export function resolveUserBudgets(user, relationships) {
    const filtered = user.budgets.filter(isAiCredits);
    const effectiveRecord = filtered.find(budget => budget.id === user.effective?.id);
    const effective = user.filterVerified && effectiveRecord && perUserScopes.includes(effectiveRecord.scope) &&
        !(effectiveRecord.scope === "user" && userTarget(effectiveRecord, user.login) === "different")
        ? {...user.effective, budget: effectiveRecord} : null;
    let excluded = 0;
    const controls = [];
    const candidates = new Map((relationships?.budgets ?? []).filter(isAiCredits).map(budget => [budget.id,budget]));
    for (const budget of filtered) candidates.set(budget.id,budget);
    for (const budget of [...candidates.values()].filter(budget => perUserScopes.includes(budget.scope))) {
        const fromFilter = filtered.some(item => item.id === budget.id);
        const center = associatedCenter(budget, user.memberships, relationships);
        const active = effective?.id === budget.id;
        const eligible = budget.scope === "user" ? userTarget(budget, user.login) === "match" :
            budget.scope === "multi_user_customer" || Boolean(center);
        if (!eligible && !active) {if (fromFilter) excluded++;continue;}
        controls.push({budget, center, source: fromFilter ? budget.lookupSource ?? "user_filter" : "saved_configuration",
            state: active ? "effective" : fromFilter && effective && eligible &&
            priority(effective.budget.scope) > priority(budget.scope) ? "overridden" : "unconfirmed"});
    }
    const guardrails = [];
    for (const budget of candidates.values()) {
        if (budget.scope === "enterprise") {
            guardrails.push({budget, center: null, reason: budget.excludeCostCenters === true
                ? "Excludes cost center usage; actual billing assignment is unknown."
                : "Enterprise spending guardrail; billing organization and policies determine applicability."});
        } else if (budget.scope === "cost_center") {
            const center = associatedCenter(budget, user.memberships, relationships);
            if (center) guardrails.push({budget, center,
                reason: "Membership-associated guardrail; actual billing assignment is unconfirmed."});
        } else if (["organization","repository"].includes(budget.scope) && filtered.some(item => item.id === budget.id)) {
            guardrails.push({budget, center: null, reason: "Referenced by the user query; billing organization and applicability are unconfirmed."});
        }
    }
    return {effective, controls, guardrails, excluded,
        headroom: effective?.amount != null && effective?.consumed != null ? effective.amount - effective.consumed : null};
}
