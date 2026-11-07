import { loadSpending } from "./spending.mjs";
import { ghRead } from "./github.mjs";

const scopes = ["enterprise", "multi_user_customer"];
export { ghRead } from "./github.mjs";

export function validateInput(input) {
    if (!input || typeof input.enterprise !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(input.enterprise)) {
        throw new Error("Provide a valid enterprise slug in the canvas input.");
    }
    const host = input.host ?? "github.com";
    if (typeof host !== "string" ||
        !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host) ||
        host.includes("..")) {
        throw new Error("Provide a GitHub hostname without a scheme or path.");
    }
    return { enterprise: input.enterprise, host };
}

function amount(value, field) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid ${field} returned by GitHub.`);
    }
    return value;
}

function flag(value, field) {
    if (value === undefined || value === null) return null;
    if (typeof value !== "boolean") throw new Error(`Invalid ${field} returned by GitHub.`);
    return value;
}

export function normalizeBudget(budget, scope) {
    return {
        ...(budget.id ? {id: budget.id} : {}),
        ...(budget.budget_type ? {type: budget.budget_type} : {}),
        ...(budget.budget_product_sku ? {product: budget.budget_product_sku} : {}),
        scope,
        configured: true,
        amount: amount(budget.budget_amount, "budget amount"),
        consumed: amount(budget.consumed_amount, "consumption"),
        preventFurtherUsage: flag(budget.prevent_further_usage, "enforcement"),
        alerts: flag(budget.budget_alerting?.will_alert, "alert setting"),
        excludeCostCenters: scope === "enterprise"
            ? flag(budget.exclude_cost_center_usage, "cost center coverage") : null,
    };
}

export async function loadOverview(input, read = ghRead, now = new Date()) {
    const { enterprise, host } = validateInput(input);
    const base = `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets`;
    const budgetReads = Promise.allSettled(scopes.map(async (scope) => {
        const matches = [];
        for (let page = 1; ; page++) {
            const response = await read(`${base}?scope=${scope}&per_page=100&page=${page}`, host);
            if (!Array.isArray(response.budgets) || typeof response.has_next_page !== "boolean") {
                throw new Error("GitHub returned an unexpected budget list.");
            }
            if (response.has_next_page && response.budgets.length === 0) {
                throw new Error("GitHub returned an incomplete budget list.");
            }
            matches.push(...response.budgets.filter((budget) => budget.budget_scope === scope &&
                (scope === "multi_user_customer" ||
                    (budget.budget_type === "BundlePricing" && budget.budget_product_sku === "ai_credits"))));
            if (!response.has_next_page) break;
        }
        if (matches.length === 0) return [{ scope, configured: false }];
        const budgets = [];
        const seen = new Set();
        for (const match of matches) {
            const id = match.id;
            if (typeof id !== "string" || !/^[a-zA-Z0-9-]+$/.test(id) || seen.has(id) ||
                typeof match.budget_type !== "string" || !match.budget_type ||
                typeof match.budget_product_sku !== "string" || !match.budget_product_sku) {
                throw new Error("GitHub returned an invalid or repeated budget ID.");
            }
            seen.add(id);
        }
        for (const match of matches) {
            const id = match.id;
            const detail = await read(`${base}/${id}`, host);
            if (detail.id !== id || detail.budget_type !== match.budget_type ||
                detail.budget_product_sku !== match.budget_product_sku || detail.budget_scope !== scope) {
                throw new Error("GitHub returned an unexpected budget detail.");
            }
            budgets.push(normalizeBudget(detail, scope));
        }
        return budgets;
    }));
    const [budgetResults, spending] = await Promise.all([
        budgetReads,
        loadSpending({ enterprise, host }, read, now),
    ]);
    const failed = budgetResults.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    const budgets = budgetResults.flatMap(result => result.value);
    return { budgets, spending, updatedAt: new Date().toISOString() };
}
