import type {BudgetRecord} from './ui/budget-format.mjs';

export type SavedAttentionBudget = BudgetRecord & {fetchedAt?: string};
export function mergeAttentionBudgets(budgets: BudgetRecord[], listFetchedAt: string,
    relationshipBudgets?: (BudgetRecord & {fetchedAt: string})[]): (BudgetRecord & {fetchedAt: string})[];
export type AttentionReason = {
    code: 'above-limit' | 'exhausted' | 'alerts-only-exceeded' | 'alerts-only-reached' | 'near-limit' | 'override-expiring' | 'baseline-near-limit';
    severity: 'critical' | 'warning'; label: string;
};
export type AttentionRow = {
    budget: SavedAttentionBudget; reasons: AttentionReason[]; percent: number | null; severity: 'critical' | 'warning';
    key?: string; user?: string; universalAmount?: number | null; targetAmount?: number | null;
    overrideBudgetId?: string | null; applicability?: string; limitLabel?: string;
};
export type UniversalUsers = {
    budgets: BudgetRecord[];
    states: {budgetId: string; user: string | null; consumed: number | null; target: number | null; overrideBudgetId: string | null}[];
    period: {year: number; month: number};
    coverage: {controls: number; records: number; unidentified: number; pages: number; pageLimit: number; complete: boolean};
};
export function buildUniversalAttention(data: UniversalUsers, now?: number | string | Date): {
    rows: AttentionRow[]; coverage: {total: number; comparable: number; unavailable: number};
};
export function mergeUserAttentionRows(budgetRows: AttentionRow[], userRows: AttentionRow[]): AttentionRow[];
export function expirationDays(expiresAt: string | null | undefined, now?: number | string | Date): number | null;
export function buildAttentionQueue(budgets: BudgetRecord[], now?: number | string | Date): {
    rows: AttentionRow[]; coverage: {total: number; comparable: number; unavailable: number};
};
export function paginateAttention(rows: AttentionRow[], scope: string, product: string, page: number): {
    items: AttentionRow[]; total: number; pages: number; page: number; start: number; end: number;
};
