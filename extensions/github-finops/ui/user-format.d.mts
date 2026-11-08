import type {BudgetRecord} from './budget-format.mjs';
import type {RelationshipsData} from './Relationships';
export type Membership = {id: string; name: string};
export type EnterpriseTeam = {id: number; name: string; slug: string; htmlUrl: string; createdAt?: string | null};
type AttributionCenter = {id: string; name: string};
type EvidenceCheck = {state: 'complete' | 'unavailable' | 'not_checked'; reason?: string};
export type Attribution = {
    status: 'confirmed' | 'provisional' | 'unresolved'; method: string; center: AttributionCenter | null;
    reason: string; checkedAt: string; invalidatedAt?: string; unresolved: string[];
    lastConfirmed?: {center: AttributionCenter | null; method: string; checkedAt: string} | null;
    via?: {kind: 'team'; name: string; slug: string; htmlUrl: string | null} | {kind: 'organization'; name: string} | null;
    evidence: {checkedAt: string; direct: EvidenceCheck; teams: EvidenceCheck; license: EvidenceCheck};
    alternatives: {method: string; name?: string; slug?: string; htmlUrl?: string; center?: AttributionCenter;
        centers?: AttributionCenter[]; createdAt?: string | null; reason: string}[];
};
export type EnterpriseTeamsData = {
    items: EnterpriseTeam[] | null; fetchedAt: string | null; error: string | null; status: number | null;
};
export type UserData = {
    login: string; id: number; accountType: string; period: {year: number; month: number};
    memberships: Membership[]; budgets: (BudgetRecord & {lookupSource?: 'user_filter' | 'effective_detail'})[]; filterVerified: boolean;
    effectiveStatus: 'reported' | 'none_reported' | 'not_returned';
    effective: {id: string; amount: number | null; consumed: number | null} | null;
    enterpriseTeams?: EnterpriseTeamsData;
    attribution?: Attribution;
    spending?: UserSpending;
};
type SpendingPeriod = {period: {year: number; month: number}; checkedAt?: string; retainedAfterError?: string};
export type UserSpending = SpendingPeriod & (
    | {status: 'available'; user: string; gross: number; discount: number; net: number}
    | {status: 'none_reported'; user: string; message: string}
    | {status: 'error'; message: string; denied?: boolean; retryAt: string | null});
type CenterMatch = Membership & {matchedBy: 'id' | 'exact_unique_name'};
export function normalizeUsername(value: string): string;
export function userBudgetEnforcement(budget: BudgetRecord): string;
export function resolveUserBudgets(user: UserData, relationships?: RelationshipsData): {
    effective: (NonNullable<UserData['effective']> & {budget: BudgetRecord}) | null;
    controls: {budget: BudgetRecord; center: CenterMatch | null; source: 'user_filter' | 'effective_detail' | 'saved_configuration'; state: 'effective' | 'overridden' | 'unconfirmed'}[];
    guardrails: {budget: BudgetRecord; center: CenterMatch | null; reason: string}[];
    excluded: number; headroom: number | null;
};
