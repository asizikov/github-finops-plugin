import { normalizeBudget } from "./budgets.mjs";

export function validateBudgetId(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid budget ID.");
    return id;
}

function text(value, field) {
    if (value == null) return value;
    if (typeof value !== "string") throw new Error(`GitHub returned invalid budget ${field}.`);
    return value;
}

export function normalizeBudgetRecord(budget) {
    validateBudgetId(budget.id);
    if (![budget.budget_scope, budget.budget_type, budget.budget_product_sku]
        .every(value => typeof value === "string" && value.length > 0)) {
        throw new Error("GitHub returned an unexpected budget configuration.");
    }
    const recipients = budget.budget_alerting?.alert_recipients;
    if (recipients != null && (!Array.isArray(recipients) || recipients.some(value => typeof value !== "string"))) {
        throw new Error("GitHub returned invalid budget alert recipients.");
    }
    return {
        ...normalizeBudget(budget, budget.budget_scope),
        id: budget.id, type: budget.budget_type, product: budget.budget_product_sku,
        entity: text(budget.budget_entity_name, "entity"),
        user: text(budget.user, "user"), expiresAt: text(budget.expires_at, "expiration"),
        alertRecipients: recipients,
    };
}

export async function loadBudgets({enterprise, host}, read, id) {
    const base = `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/budgets`;
    if (id !== undefined) {
        validateBudgetId(id);
        const detail = normalizeBudgetRecord(await read(`${base}/${id}`, host));
        if (detail.id !== id) throw new Error("GitHub returned an unexpected budget identity.");
        return detail;
    }
    const budgets = [];
    const seen = new Set();
    for (let page = 1; ; page++) {
        const response = await read(`${base}?per_page=100&page=${page}`, host);
        if (!Array.isArray(response.budgets) || typeof response.has_next_page !== "boolean" ||
            (response.has_next_page && response.budgets.length === 0)) {
            throw new Error("GitHub returned an incomplete budget list.");
        }
        for (const raw of response.budgets) {
            const budget = normalizeBudgetRecord(raw);
            if (seen.has(budget.id)) throw new Error("GitHub repeated budgets while paginating. Refresh to retry.");
            seen.add(budget.id);
            budgets.push(budget);
        }
        if (!response.has_next_page) return budgets;
    }
}
