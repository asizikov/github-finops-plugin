import {budgetAmount, scopeLabel} from "./budget-format.mjs";
import {userBudgetEnforcement} from "./user-format.mjs";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function route(user, attribution) {
    const teams = user.enterpriseTeams?.items?.length ?? null;
    const teamNote = teams === null ? "Team memberships unavailable." : teams === 0 ? "No enterprise team memberships."
        : `${plural(teams, "team membership")} not used: direct assignment takes precedence.`;
    if (!attribution) return {kind: "unknown", label: "Not checked", state: "unknown",
        note: "Attribution was not checked in this saved snapshot."};
    const settled = attribution.status === "confirmed" ? "active" : attribution.status === "provisional" ? "provisional" : "unknown";
    if (attribution.method === "direct") {
        return settled === "unknown"
            ? {kind: "direct", label: "Direct assignment unresolved", state: "unknown", note: "Direct checks are incomplete; teams were not evaluated."}
            : {kind: "direct", label: "Direct user assignment", state: settled, note: teamNote};
    }
    if (attribution.method === "team") {
        const via = attribution.via?.kind === "team" ? attribution.via : null;
        return via && settled !== "unknown"
            ? {kind: "team", label: via.name, htmlUrl: via.htmlUrl ?? null, state: settled, note: "Oldest qualifying team assignment."}
            : {kind: "team", label: settled === "unknown" ? "Team precedence unresolved" : "Team (refresh to name)", state: settled,
                note: settled === "unknown" ? "Team evidence is incomplete or ambiguous; no team is selected." : "Selected team was not saved in this snapshot."};
    }
    if (attribution.method === "organization") {
        const via = attribution.via?.kind === "organization" ? attribution.via : null;
        return settled === "unknown"
            ? {kind: "organization", label: "Billing organization unresolved", state: "unknown",
                note: "Copilot billing organization is ambiguous or incomplete."}
            : via ? {kind: "organization", label: via.name, state: settled, note: "Sole Copilot license organization; no team assignment applies."}
                : {kind: "organization", label: "Organization (refresh to name)", state: settled,
                    note: "Billing organization was not saved in this snapshot."};
    }
    return {kind: "none", label: "No team or organization", state: settled === "active" ? "none" : "unknown",
        note: settled === "active" ? "No qualifying team or license organization assignment." : "Higher-level evidence is incomplete."};
}

// A confirmed charging center can come from a team or organization, so it may be missing from the user's own memberships.
export function withAttributionCenter(user) {
    const center = user.attribution?.status === "confirmed" ? user.attribution.center : null;
    if (!center || user.memberships.some(item => item.id === center.id)) return user;
    return {...user, memberships: [...user.memberships, {id: center.id, name: center.name}]};
}

export function userChain(user, enterprise = null) {
    const attribution = user.attribution ?? null;
    const via = route(user, attribution);
    const center = attribution?.center ?? null;
    const status = attribution?.status ?? "unchecked";
    const enterpriseOnly = status === "confirmed" && attribution.method === "enterprise";
    const pathState = status === "confirmed" ? "active" : status === "provisional" ? "provisional" : "unknown";
    const centerStep = center
        ? {kind: "center", label: center.name, centerId: center.id, state: pathState,
            note: status === "confirmed" ? "Current charging destination." : "Candidate only; not confirmed."}
        : enterpriseOnly ? {kind: "center", label: "No cost center", state: "none", note: "No applicable cost center assignment."}
            : {kind: "center", label: "Unknown", state: "unknown", note: "No confirmed cost center; absence is not inferred."};
    const steps = [
        {id: "user", kind: "user", label: `@${user.login}`, state: "subject", note: ""},
        {id: "route", ...via},
        {id: "center", ...centerStep},
        {id: "enterprise", kind: "enterprise", label: enterprise ?? "Enterprise", state: enterpriseOnly ? "active" : "container",
            note: enterpriseOnly ? "Charged at enterprise level." : center ? "Contains this cost center." : "Contains all usage."},
    ];
    const link = (kind, label) => ({kind, label});
    const lead = pathState === "active" ? "charges" : pathState === "provisional" ? "tentative" : "unknown";
    const links = enterpriseOnly
        ? [link("skipped", "no assignment"), link("skipped", "no cost center"), link("charges", "enterprise fallback")]
        : [
            link(via.state === "none" ? "skipped" : lead, via.state === "unknown" ? "not established" : via.state === "none" ? "no assignment"
                : via.kind === "direct" ? "assigned directly" : via.kind === "team" ? "selected team" : "license org"),
            link(center ? lead : "unknown", center ? "assigned to" : "not established"),
            link(center ? "contains" : "unknown", center ? "belongs to" : "destination unknown"),
        ];
    const verdict = status === "confirmed" ? "Confirmed at last check" : status === "provisional" ? "Provisional"
        : status === "unresolved" ? "Unresolved" : "Not checked";
    const destination = enterpriseOnly ? `enterprise ${steps[3].label} (no cost center)` : center ? `cost center ${center.name}` : "no confirmed destination";
    const summary = `${verdict}: @${user.login}${via.state === "unknown" ? "" : ` via ${via.label}`} to ${destination}.`;
    return {status, verdict, steps, links, summary, unresolved: attribution?.unresolved ?? [],
        lastConfirmed: status === "confirmed" ? null : attribution?.lastConfirmed ?? null,
        invalidatedAt: attribution?.invalidatedAt ?? null,
        alternatives: attribution?.alternatives?.length ?? 0};
}

export function userUsage(explanation, impact) {
    const effective = explanation.effective;
    if (!effective) return {state: "no_cap", note: explanation.reason};
    const base = {budgetId: effective.id, title: explanation.title, enforcement: userBudgetEnforcement(effective.budget),
        limit: effective.amount, consumed: effective.consumed, headroom: impact.headroom, budget: effective.budget};
    if (effective.amount == null) return {...base, state: "unknown", percent: null};
    if (effective.consumed == null) return {...base, state: "unknown_usage", percent: null};
    if (effective.amount === 0) return {...base, state: effective.consumed > 0 ? "exceeded" : "zero_cap", percent: null};
    const percent = effective.consumed / effective.amount * 100;
    return {...base, percent, state: percent > 100 ? "exceeded" : percent === 100 ? "reached" : percent >= 80 ? "near" : "within"};
}

export function userSpending(spending) {
    if (!spending) return {state: "not_checked", message: "Not checked in this saved snapshot. Refresh this user to read the usage report."};
    if (spending.status === "available") return {state: "available", gross: spending.gross, discount: spending.discount, net: spending.net,
        retained: spending.retainedAfterError ?? null, checkedAt: spending.checkedAt ?? null};
    if (spending.status === "none_reported") return {state: "none_reported", message: spending.message,
        retained: spending.retainedAfterError ?? null};
    return {state: spending.denied ? "denied" : "unavailable", message: spending.message, retryAt: spending.retryAt ?? null};
}

function chip(budget, kind, state, center = null) {
    return {id: budget.id, kind, state, scope: budget.scope, label: scopeLabel(budget.scope), centerName: center?.name ?? null,
        amount: budgetAmount(budget.amount, budget), enforcement: userBudgetEnforcement(budget)};
}

// Places each control on the level that owns it. Shared budgets are never summed with per-user caps.
export function placeBudgets(impact, chain) {
    const placed = {user: [], center: [], enterprise: [], other: []};
    const centerId = chain.steps[2].centerId ?? null;
    for (const control of impact.controls) {
        const state = control.state === "unconfirmed" ? "candidate" : control.state;
        const item = chip(control.budget, "per_user", state, control.center);
        const level = control.budget.scope === "user" ? "user" : control.budget.scope === "multi_user_customer" ? "enterprise"
            : control.center && control.center.id === centerId ? "center" : "other";
        placed[level].push(item);
    }
    for (const guardrail of impact.guardrails) {
        const item = chip(guardrail.budget, "shared", "shared", guardrail.center);
        const level = guardrail.budget.scope === "enterprise" ? "enterprise"
            : guardrail.budget.scope === "cost_center" && guardrail.center?.id === centerId ? "center" : "other";
        placed[level].push(item);
    }
    const rank = {effective: 0, overridden: 1, candidate: 2, shared: 3};
    for (const list of Object.values(placed)) list.sort((a, b) => rank[a.state] - rank[b.state]);
    return placed;
}

export function freshness(cache, attribution) {
    if (!cache) return {tone: "unknown", label: "Not loaded"};
    if (cache.error) return {tone: "attention", label: "Refresh failed; saved data shown", at: cache.fetchedAt};
    if (attribution?.invalidatedAt) return {tone: "attention", label: "Configuration changed; refresh to recheck", at: cache.fetchedAt};
    return cache.source === "cached" ? {tone: "neutral", label: "Saved snapshot", at: cache.fetchedAt}
        : {tone: "success", label: "Live", at: cache.fetchedAt};
}
