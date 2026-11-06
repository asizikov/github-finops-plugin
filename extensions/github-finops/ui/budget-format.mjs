export function scopeLabel(scope) {
    const labels = {
        enterprise: "Enterprise", organization: "Organization", repository: "Repository",
        cost_center: "Cost center", user: "User", multi_user_customer: "Default per user",
        multi_user_cost_center: "Cost center per-user default",
    };
    return Object.hasOwn(labels, scope) ? labels[scope] : scope;
}

export function budgetEntity(budget) {
    if (budget.scope === "enterprise" || budget.scope === "multi_user_customer") return "Enterprise-wide";
    return budget.scope === "user" ? budget.user || budget.entity || "Not returned" : budget.entity || "Not returned";
}

export function budgetUnit(budget) {
    const product = budget.product.toLowerCase();
    const licenses = ["ghec_licenses", "ghas_licenses", "ghas_code_security_licenses",
        "ghas_secret_protection_licenses", "code_quality_licenses", "copilot_for_business",
        "copilot_enterprise", "copilot_standalone"];
    if ((budget.type === "ProductPricing" && product === "ghec") ||
        (budget.type === "SkuPricing" && licenses.includes(product))) return "licenses";
    if (budget.type === "BundlePricing" && product === "ai_credits") return "USD";
    if (budget.type === "ProductPricing" && ["actions", "packages", "codespaces", "git_lfs", "models", "spark", "sandbox"].includes(product)) return "USD";
    if (budget.type === "SkuPricing" && (/^(actions|codespaces|packages|git_lfs|models|sandbox)_/.test(product) ||
        ["ai_credits", "premium_requests", "copilot_ai_credit", "coding_agent_ai_credit", "code_quality_ai_credit",
            "spark_ai_credits", "code_security_ai_unit", "deep_security_research_ai_unit", "secret_protection_ai_unit"].includes(product))) return "USD";
    return null;
}

export function budgetAmount(value, budget) {
    if (value == null) return "Unavailable";
    const unit = budgetUnit(budget);
    return unit === "USD" ? `${new Intl.NumberFormat(undefined, {style: "currency", currency: "USD"}).format(value)} USD`
        : `${new Intl.NumberFormat().format(value)} ${unit ?? "(unit not returned)"}`;
}

export function paginateBudgets(budgets, query, requestedPage) {
    const search = query.trim().toLowerCase();
    const filtered = budgets.filter(budget => [budget.id, budget.product, budget.type, scopeLabel(budget.scope),
        budget.scope, budgetEntity(budget), budget.expiresAt ?? ""].some(value => value.toLowerCase().includes(search)));
    return paginateItems(filtered, requestedPage);
}
import {paginateItems} from './pagination.mjs';
