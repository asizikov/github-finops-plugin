import type {BudgetRecord} from './budget-format.mjs';
import type {UserData, resolveUserBudgets, Attribution} from './user-format.mjs';
import type {explainUserBudget} from './user-explanation.mjs';
type Impact = ReturnType<typeof resolveUserBudgets>;
export type StepState = 'subject' | 'active' | 'provisional' | 'unknown' | 'none' | 'container';
export type ChainStep = {id: 'user' | 'route' | 'center' | 'enterprise'; kind: 'user' | 'direct' | 'team' | 'organization' | 'none' | 'unknown' | 'center' | 'enterprise';
    label: string; state: StepState; note: string; centerId?: string; htmlUrl?: string | null};
export type ChainLink = {kind: 'charges' | 'tentative' | 'unknown' | 'skipped' | 'contains'; label: string};
export type UserChain = {status: Attribution['status'] | 'unchecked'; verdict: string; steps: ChainStep[]; links: ChainLink[];
    summary: string; unresolved: string[]; lastConfirmed: Attribution['lastConfirmed'] | null; invalidatedAt: string | null; alternatives: number};
export type UsageState = 'no_cap' | 'unknown' | 'unknown_usage' | 'zero_cap' | 'within' | 'near' | 'reached' | 'exceeded';
export type UserUsage = {state: UsageState; note?: string; budgetId?: string; title?: string; enforcement?: string;
    limit?: number | null; consumed?: number | null; headroom?: number | null; percent?: number | null; budget?: BudgetRecord};
export type UserSpendingView =
    | {state: 'available'; gross: number; discount: number; net: number; retained: string | null; checkedAt: string | null}
    | {state: 'none_reported'; message: string; retained: string | null}
    | {state: 'not_checked' | 'unavailable' | 'denied'; message: string; retryAt?: string | null};
export type BudgetChip = {id: string; kind: 'per_user' | 'shared'; state: 'effective' | 'overridden' | 'candidate' | 'shared';
    scope: string; label: string; centerName: string | null; amount: string; enforcement: string};
export type PlacedBudgets = Record<'user' | 'center' | 'enterprise' | 'other', BudgetChip[]>;
export function withAttributionCenter(user: UserData): UserData;
export function userChain(user: UserData, enterprise?: string | null): UserChain;
export function userUsage(explanation: ReturnType<typeof explainUserBudget>, impact: Impact): UserUsage;
export function userSpending(spending: UserData['spending']): UserSpendingView;
export function placeBudgets(impact: Impact, chain: UserChain): PlacedBudgets;
export function freshness(cache: {source: 'cached' | 'live'; fetchedAt: string; error: string | null} | null | undefined,
    attribution: Attribution | undefined): {tone: 'unknown' | 'attention' | 'neutral' | 'success'; label: string; at?: string};
