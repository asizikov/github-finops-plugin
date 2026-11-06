const sourceDetails = {
    user: {
        kind: "individual",
        title: "Individual user override",
        rationale: "GitHub selected an individual user-scoped AI Credits budget as effective.",
    },
    multi_user_cost_center: {
        kind: "cost_center",
        title: "Cost-center per-user default",
        rationale: "GitHub selected a cost-center per-user default as effective. Membership and team links do not establish billing assignment.",
    },
    multi_user_customer: {
        kind: "enterprise",
        title: "Enterprise per-user default",
        rationale: "GitHub selected the enterprise per-user default as effective.",
    },
};

export function explainUserBudget(user, impact) {
    const effective = impact?.effective ?? null;
    if (!effective) {
        const reason = !user.filterVerified
            ? "The response did not confirm the requested username; the effective limit is unverified."
            : user.effectiveStatus === "not_returned"
                ? "The API did not return an effective per-user budget."
                : user.effectiveStatus === "none_reported"
                    ? "GitHub reported no effective per-user budget."
                    : "The reported effective budget could not be verified as an AI Credits control for this user.";
        return {effective: null, reason, overridden: []};
    }

    const source = Object.hasOwn(sourceDetails, effective.budget.scope)
        ? sourceDetails[effective.budget.scope] : {
        kind: "unknown",
        title: "Per-user limit source unknown",
        rationale: "GitHub selected a per-user budget, but its source type is not recognized. Billing assignment is not inferred.",
    };
    return {
        effective,
        ...source,
        expiration: typeof effective.budget.expiresAt === "string" && effective.budget.expiresAt.length > 0
            ? effective.budget.expiresAt : null,
        overridden: impact.controls.filter(control => control.state === "overridden"),
    };
}
