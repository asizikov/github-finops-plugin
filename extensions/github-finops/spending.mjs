export function normalizeSpending(response, period) {
    if (response.timePeriod?.year !== period.year || response.timePeriod?.month !== period.month ||
        response.timePeriod?.day != null) {
        throw new Error("GitHub returned a different AI spending period.");
    }
    if (["costCenter", "organization", "user", "model", "product"].some(key => response[key] != null)) {
        throw new Error("GitHub returned filtered AI spending instead of enterprise-wide usage.");
    }
    if (!Array.isArray(response.usageItems)) {
        throw new Error("GitHub returned an unexpected AI usage report.");
    }
    if (response.usageItems.length === 0) {
        return { status: "unavailable", period, message: "No AI usage items were returned for this month. Spending is unavailable, not assumed to be zero." };
    }
    const totals = { gross: 0, discount: 0, net: 0 };
    for (const item of response.usageItems) {
        if (item?.unitType !== "ai-credits") {
            throw new Error("GitHub returned an unexpected AI usage unit.");
        }
        for (const [key, field] of [["gross", "grossAmount"], ["discount", "discountAmount"], ["net", "netAmount"]]) {
            if (typeof item[field] !== "number" || !Number.isFinite(item[field])) {
                throw new Error(`GitHub returned invalid AI spending ${field}.`);
            }
            totals[key] += item[field];
        }
        const tolerance = Math.max(1, Math.abs(item.grossAmount), Math.abs(item.discountAmount)) * 1e-9;
        if (Math.abs(item.grossAmount - item.discountAmount - item.netAmount) > tolerance) {
            throw new Error("GitHub returned inconsistent AI spending amounts.");
        }
    }
    if (!Object.values(totals).every(Number.isFinite)) throw new Error("AI spending totals exceeded numeric limits.");
    return { status: "available", period, ...totals };
}

export async function loadSpending({ enterprise, host }, read, now) {
    const period = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
    try {
        // No cost-center, product, organization, or user filter: this is the enterprise total.
        const response = await read(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/ai_credit/usage?year=${period.year}&month=${period.month}`, host);
        return normalizeSpending(response, period);
    } catch (error) {
        if (error.code === "local_cache_error") throw error;
        console.error("Current AI spending read failed:", error);
        return {
            status: "error", period,
            message: "Could not read current AI spending. Check gh authentication, enterprise billing access, hostname, and connectivity, then refresh.",
            retryAt: error.retryAt ?? null,
        };
    }
}
