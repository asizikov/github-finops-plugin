import {loadBudgets} from "./budget-list.mjs";
import {normalizeUsername} from "./ui/user-format.mjs";

const pageLimit = 20;
const number = value => value == null ? null :
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export async function loadUniversalUsers(config, read, now = new Date()) {
    const budgets = await loadBudgets(config, read);
    const controls = budgets.filter(budget => budget.scope === "multi_user_customer");
    const states = [];
    let pages = 0;
    for (const budget of controls) {
        const seen = new Set();
        let expected = null;
        for (let page = 1; ; page++) {
            if (page > pageLimit) {
                throw Object.assign(new Error("Universal user-state coverage exceeded the 2,000-record safety limit per control."), {
                    publicMessage: "User-state refresh stopped at the 2,000-record safety limit per universal control. Last successful data is retained; coverage is not current.",
                });
            }
            // Do not filter by threshold: the API uses the universal denominator even for overrides.
            const response = await read(`/enterprises/${encodeURIComponent(config.enterprise)}/settings/billing/budgets/${budget.id}/user-states?per_page=100&page=${page}&sort_order=0`, config.host);
            pages++;
            if (!Array.isArray(response.user_states) || response.user_states.length > 100 || typeof response.has_next_page !== "boolean" ||
                !Number.isSafeInteger(response.total_count) || response.total_count < 0 ||
                (response.has_next_page && response.user_states.length === 0)) {
                throw new Error("GitHub returned incomplete universal user states.");
            }
            expected ??= response.total_count;
            if (response.total_count !== expected) throw new Error("Universal user states changed during pagination. Refresh to retry.");
            for (const raw of response.user_states) {
                const user = raw.user == null || raw.user === "" ? null : normalizeUsername(raw.user);
                const consumed = number(raw.consumed_amount);
                const target = number(raw.target_amount);
                const overrideBudgetId = raw.override_budget_id ?? null;
                if (consumed === undefined || target === undefined ||
                    (overrideBudgetId !== null && (typeof overrideBudgetId !== "string" || !/^[a-zA-Z0-9-]+$/.test(overrideBudgetId)))) {
                    throw new Error("GitHub returned invalid universal user-state fields.");
                }
                if (user && seen.has(user.toLowerCase())) throw new Error("GitHub repeated a user during pagination. Refresh to retry.");
                if (user) seen.add(user.toLowerCase());
                states.push({budgetId: budget.id, user, consumed, target, overrideBudgetId});
            }
            if (!response.has_next_page) break;
        }
        if (states.filter(state => state.budgetId === budget.id).length !== expected) {
            throw new Error("GitHub returned an incomplete universal user-state count.");
        }
    }
    return {budgets, states, period: {year: now.getUTCFullYear(), month: now.getUTCMonth() + 1},
        coverage: {controls: controls.length, records: states.length, unidentified: states.filter(state => !state.user).length,
            pages, pageLimit, complete: true}};
}
