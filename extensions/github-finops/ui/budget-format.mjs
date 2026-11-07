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

const SKU_LABELS = {
    ai_credits: "AI Credits", actions: "Actions", packages: "Packages", codespaces: "Codespaces",
    git_lfs: "Git LFS", models: "GitHub Models", spark: "Spark", sandbox: "Sandbox",
    ghec: "GitHub Enterprise Cloud", ghec_licenses: "GitHub Enterprise Cloud licenses",
    ghas_licenses: "Advanced Security licenses", ghas_code_security_licenses: "Code Security licenses",
    ghas_secret_protection_licenses: "Secret Protection licenses", code_quality_licenses: "Code Quality licenses",
    copilot_for_business: "Copilot Business", copilot_enterprise: "Copilot Enterprise",
    copilot_standalone: "Copilot standalone", premium_requests: "Premium requests",
    copilot_ai_credit: "Copilot AI credits", coding_agent_ai_credit: "Coding agent AI credits",
    code_quality_ai_credit: "Code Quality AI credits", spark_ai_credits: "Spark AI credits",
    code_security_ai_unit: "Code Security AI units", deep_security_research_ai_unit: "Deep security research AI units",
    secret_protection_ai_unit: "Secret Protection AI units",
};

export function skuLabel(sku) {
    const key = sku.toLowerCase();
    return Object.hasOwn(SKU_LABELS, key) ? SKU_LABELS[key] : null;
}

export function budgetSkuOptions(budgets) {
    const counts = new Map();
    for (const budget of budgets) counts.set(budget.product, (counts.get(budget.product) ?? 0) + 1);
    return [...counts].map(([sku, count]) => ({sku, label: skuLabel(sku), count}))
        .sort((a, b) => (a.label ?? a.sku).localeCompare(b.label ?? b.sku) || a.sku.localeCompare(b.sku));
}

export function paginateBudgets(budgets, query, requestedPage, sku = null) {
    const search = query.trim().toLowerCase();
    const filtered = budgets.filter(budget => (sku === null || budget.product === sku) && [budget.id, budget.product, budget.type, scopeLabel(budget.scope),
        budget.scope, budgetEntity(budget), budget.expiresAt ?? ""].some(value => value.toLowerCase().includes(search)));
    return paginateItems(filtered, requestedPage);
}
import {paginateItems} from './pagination.mjs';
