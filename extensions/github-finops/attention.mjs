import {budgetUnit} from "./ui/budget-format.mjs";
import {paginateItems} from "./ui/pagination.mjs";

const day = 86_400_000;
const validAmount = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const utcDay = value => Math.floor(value / day);

export function mergeAttentionBudgets(budgets, listFetchedAt, relationshipBudgets = []) {
    const records = new Map(budgets.map(budget => [budget.id, {...budget, fetchedAt: listFetchedAt}]));
    for (const budget of relationshipBudgets) {
        const saved = records.get(budget.id);
        const fetchedAt = Date.parse(budget.fetchedAt);
        if (!Number.isFinite(fetchedAt)) continue;
        if (!saved || !Number.isFinite(Date.parse(saved.fetchedAt)) || fetchedAt >= Date.parse(saved.fetchedAt)) {
            // Replace the record as a whole; newer unknown values must not inherit older usage.
            records.set(budget.id, {...budget});
        }
    }
    return [...records.values()];
}

export function expirationDays(expiresAt, now = Date.now()) {
    const current = new Date(now).getTime();
    if (!Number.isFinite(current) || typeof expiresAt !== "string") return null;
    const match = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/.exec(expiresAt);
    if (!match) return null;
    const date = Date.parse(`${match[1]}T00:00:00Z`);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1]) return null;
    if (match[2] && (+match[2] > 23 || +match[3] > 59 || +match[4] > 59)) return null;
    const expiration = Date.parse(expiresAt);
    if (!Number.isFinite(expiration)) return null;
    // Date-only expirations have day precision; timestamps must still be in the future.
    if (match[2] ? expiration < current : utcDay(expiration) < utcDay(current)) return null;
    const days = utcDay(expiration) - utcDay(current);
    return days >= 0 && days <= 7 ? days : null;
}

export function buildAttentionQueue(budgets, now = Date.now()) {
    const rows = [];
    let comparable = 0;
    for (const budget of budgets) {
        const reasons = [];
        let percent = null;
        const knownUsage = !budget.scope.startsWith("multi_user_") && Boolean(budgetUnit(budget)) &&
            validAmount(budget.amount) && validAmount(budget.consumed);
        if (knownUsage) {
            comparable++;
            if (budget.amount > 0) {
                const ratio = budget.consumed / budget.amount * 100;
                if (Number.isFinite(ratio)) percent = ratio;
            }
            if (budget.consumed >= budget.amount) {
                const above = budget.consumed > budget.amount;
                if (budget.preventFurtherUsage === false && budget.alerts === true) {
                    reasons.push({code: above ? "alerts-only-exceeded" : "alerts-only-reached", severity: "critical",
                        label: above ? "Alerts-only threshold exceeded" : "Alerts-only threshold reached"});
                } else {
                    reasons.push({code: above ? "above-limit" : "exhausted", severity: "critical",
                        label: above ? "Above limit" : "Budget exhausted"});
                }
            } else if (budget.consumed >= budget.amount * 0.9) {
                reasons.push({code: "near-limit", severity: "warning", label: "Near limit (at least 90%)"});
            }
        }
        const days = budget.scope === "user" ? expirationDays(budget.expiresAt, now) : null;
        if (days !== null) reasons.push({code: "override-expiring", severity: "warning",
            label: `User override expires ${days === 0 ? "today" : `in ${days} UTC day${days === 1 ? "" : "s"}`}`});
        if (reasons.length) rows.push({budget, reasons, percent,
            severity: reasons.some(reason => reason.severity === "critical") ? "critical" : "warning"});
    }
    rows.sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical") ||
        a.budget.id.localeCompare(b.budget.id));
    return {rows, coverage: {total: budgets.length, comparable, unavailable: budgets.length - comparable}};
}

export function buildUniversalAttention(data, now = Date.now()) {
    const rows = [];
    let comparable = 0;
    const controls = new Map(data.budgets.filter(budget => budget.scope === "multi_user_customer").map(budget => [budget.id, budget]));
    const allBudgets = new Map(data.budgets.map(budget => [budget.id, budget]));
    const seen = new Set();
    for (const state of data.states) {
        const control = controls.get(state.budgetId);
        const key = `${state.budgetId}:${state.user?.toLowerCase()}`;
        if (!control || !state.user || seen.has(key)) continue;
        seen.add(key);
        const override = allBudgets.get(state.overrideBudgetId);
        const expired = override?.expiresAt && Number.isFinite(Date.parse(override.expiresAt)) &&
            Date.parse(override.expiresAt.length === 10 ? `${override.expiresAt}T23:59:59.999Z` : override.expiresAt) < new Date(now).getTime();
        const conflict = override?.scope === "user" && override.user?.toLowerCase() === state.user.toLowerCase() &&
            override.type === control.type && override.product === control.product &&
            validAmount(override.amount) && validAmount(state.target) && override.amount !== state.target;
        const knownTarget = validAmount(state.target) && !expired && !conflict;
        const limit = knownTarget ? state.target : control.amount;
        if (!budgetUnit(control) || !validAmount(state.consumed) || !validAmount(limit)) continue;
        if (knownTarget) comparable++;
        if (state.consumed < limit * 0.9) continue;
        const universal = knownTarget && !state.overrideBudgetId && state.target === control.amount;
        const severity = knownTarget && state.consumed >= limit ? "critical" : "warning";
        const percent = limit > 0 ? state.consumed / limit * 100 : null;
        rows.push({
            budget: {...control, consumed: state.consumed, amount: limit, user: state.user, expiresAt: override?.expiresAt},
            user: state.user, key, universalAmount: control.amount, targetAmount: state.target,
            overrideBudgetId: state.overrideBudgetId,
            applicability: expired ? "Saved override has expired; refresh to resolve the current limit." :
                conflict ? "Reported target conflicts with the saved individual override; current limit unverified. Refresh this user to resolve." :
                !knownTarget ? "Reported target unavailable; universal baseline only, applicability unverified." :
                universal ? "Reported per-user target matches the universal baseline; no override ID returned." :
                state.overrideBudgetId ? "Reported per-user target with an override; not the universal cap." :
                "Reported per-user target differs from the universal baseline; more-specific control may apply.",
            limitLabel: knownTarget ? "Reported per-user target" : "Universal baseline (not a confirmed limit)",
            reasons: [{code: knownTarget ? state.consumed >= limit ? "exhausted" : "near-limit" : "baseline-near-limit",
                severity, label: knownTarget ? state.consumed >= limit ? "Per-user target reached" : "Near per-user target (at least 90%)" :
                    "At least 90% of universal baseline; current target unknown"},
                ...(expirationDays(override?.expiresAt, now) !== null ? [{code: "override-expiring", severity: "warning",
                    label: "Individual override expires within 7 UTC days"}] : [])],
            percent: Number.isFinite(percent) ? percent : null, severity,
        });
    }
    return {rows, coverage: {total: data.states.length, comparable, unavailable: data.states.length - comparable}};
}

export function paginateAttention(rows, scope, product, page) {
    return paginateItems(rows.filter(({budget}) => (!scope || budget.scope === scope) &&
        (!product || budget.product === product)), page);
}
