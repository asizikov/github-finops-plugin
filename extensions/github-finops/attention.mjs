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
        const knownUsage = Boolean(budgetUnit(budget)) && validAmount(budget.amount) && validAmount(budget.consumed);
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

export function paginateAttention(rows, scope, product, page) {
    return paginateItems(rows.filter(({budget}) => (!scope || budget.scope === scope) &&
        (!product || budget.product === product)), page);
}
