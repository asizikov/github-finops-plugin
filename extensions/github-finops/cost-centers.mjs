export function validateCenterId(id) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]+$/.test(id)) {
        throw new Error("Invalid cost center ID.");
    }
    return id;
}

function optional(value, type, field) {
    if (value == null) return value;
    if (typeof value !== type || (type === "number" && !Number.isFinite(value))) {
        throw new Error(`GitHub returned invalid cost center ${field}.`);
    }
    return value;
}

export function normalizeCenter(center) {
    validateCenterId(center.id);
    if (typeof center.name !== "string" || !Array.isArray(center.resources)) {
        throw new Error("GitHub returned an unexpected cost center.");
    }
    if (center.has_next_page !== undefined && typeof center.has_next_page !== "boolean") {
        throw new Error("GitHub returned invalid cost center resource pagination.");
    }
    const pool = center.ai_credit_pool_state;
    if (pool != null && (typeof pool !== "object" || Array.isArray(pool))) {
        throw new Error("GitHub returned invalid AI credit pool state.");
    }
    return {
        id: center.id, name: center.name,
        state: optional(center.state, "string", "state"),
        azureSubscription: optional(center.azure_subscription, "string", "Azure subscription"),
        aiCreditPoolEnabled: optional(center.ai_credit_pool_enabled, "boolean", "pool cap"),
        aiCreditPoolState: pool == null ? pool : {
            targetAmount: optional(pool.target_amount, "number", "pool target"),
            currentAmount: optional(pool.current_amount, "number", "pool current amount"),
        },
        resourcesComplete: center.has_next_page !== true,
        resources: center.resources.map(resource => {
            if (typeof resource?.type !== "string" || typeof resource.name !== "string") {
                throw new Error("GitHub returned invalid cost center resources.");
            }
            return { type: resource.type, name: resource.name };
        }),
    };
}

export async function loadCostCenters({ enterprise, host }, read, id) {
    const base = `/enterprises/${encodeURIComponent(enterprise)}/settings/billing/cost-centers`;
    if (!id) {
        const response = await read(base, host);
        if (!Array.isArray(response.costCenters)) throw new Error("GitHub returned an unexpected cost center list.");
        return response.costCenters.map(normalizeCenter).sort((a, b) => a.name.localeCompare(b.name));
    }
    validateCenterId(id);
    let center;
    const resources = new Map();
    const seenPages = new Set();
    for (let page = 1; ; page++) {
        const response = await read(`${base}/${encodeURIComponent(id)}?per_page=100&page=${page}`, host);
        const current = normalizeCenter(response);
        if (current.id !== id || typeof response.has_next_page !== "boolean") {
            throw new Error("GitHub returned an unexpected cost center resource page.");
        }
        if (center && (center.name !== current.name || center.state !== current.state)) {
            throw new Error("Cost center configuration changed while loading. Refresh to retry.");
        }
        center ??= current;
        const fingerprint = JSON.stringify(current.resources);
        if (response.has_next_page && (current.resources.length === 0 || seenPages.has(fingerprint))) {
            throw new Error("GitHub returned non-progressing cost center resource pagination.");
        }
        seenPages.add(fingerprint);
        for (const resource of current.resources) resources.set(JSON.stringify([resource.type, resource.name]), resource);
        if (!response.has_next_page) break;
    }
    return { ...center, resources: [...resources.values()], resourcesComplete: true };
}
