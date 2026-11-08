export function normalizeSpending(response, period, user = null) {
    if (response.timePeriod?.year !== period.year || response.timePeriod?.month !== period.month ||
        response.timePeriod?.day != null) {
        throw new Error("GitHub returned a different AI spending period.");
    }
    if (user !== null && (typeof response.user !== "string" || response.user.toLowerCase() !== user.toLowerCase())) {
        throw new Error("GitHub did not confirm the requested user filter for AI spending.");
    }
    if (["costCenter", "organization", ...(user === null ? ["user"] : []), "model", "product"].some(key => response[key] != null)) {
        throw new Error(user === null ? "GitHub returned filtered AI spending instead of enterprise-wide usage."
            : "GitHub returned AI spending with an unexpected additional filter.");
    }
    if (!Array.isArray(response.usageItems)) {
        throw new Error("GitHub returned an unexpected AI usage report.");
    }
    if (response.usageItems.length === 0) {
        return user === null
            ? { status: "unavailable", period, message: "No AI usage items were returned for this month. Spending is unavailable, not assumed to be zero." }
            : { status: "none_reported", period, user: response.user, message: "The user-filtered report returned no AI usage items for this month. Reporting can lag; this is not shown as a confirmed zero." };
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
    return { status: "available", period, ...(user === null ? {} : { user: response.user }), ...totals };
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

// One user-filtered read for an explicit user lookup or refresh; never an enterprise aggregate.
export async function loadUserSpending({ enterprise, host }, read, login, now) {
    const period = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
    const checkedAt = now.toISOString();
    try {
        const response = await read(`/enterprises/${encodeURIComponent(enterprise)}/settings/billing/ai_credit/usage?year=${period.year}&month=${period.month}&user=${encodeURIComponent(login)}`, host);
        return { ...normalizeSpending(response, period, login), checkedAt };
    } catch (error) {
        if (["local_cache_error", "cache_cleared"].includes(error.code)) throw error;
        console.error("User AI spending read failed:", error);
        const denied = error.status === 401 || error.status === 403;
        return {
            status: "error", period, checkedAt, denied,
            message: error.retryAt ? "Rate limited; refresh this user after the cooldown."
                : denied ? `Access denied (HTTP ${error.status}). The usage report needs enterprise billing read access; authentication was not changed.`
                    : error.status === 404 ? "The user usage report is not visible to this account (HTTP 404)."
                        : "Could not read or validate this user's AI usage report; refresh to retry.",
            retryAt: error.retryAt ?? null,
        };
    }
}
