export type BudgetRecord = {
    id: string; scope: string; type: string; product: string;
    amount: number | null; consumed: number | null; preventFurtherUsage: boolean | null;
    alerts: boolean | null; excludeCostCenters: boolean | null;
    entity?: string | null; user?: string | null; expiresAt?: string | null;
    alertRecipients?: string[] | null;
};
export function scopeLabel(scope: string): string;
export function budgetEntity(budget: BudgetRecord): string;
export function budgetUnit(budget: BudgetRecord): 'USD' | 'licenses' | null;
export function budgetAmount(value: number | null, budget: BudgetRecord): string;
export function paginateBudgets(budgets: BudgetRecord[], query: string, requestedPage: number):
    {items: BudgetRecord[]; total: number; pages: number; page: number; start: number; end: number};
