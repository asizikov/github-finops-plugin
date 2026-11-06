import type {BudgetRecord} from './budget-format.mjs';
import type {UserData, resolveUserBudgets} from './user-format.mjs';
type Impact = ReturnType<typeof resolveUserBudgets>;
type Override = {budget: BudgetRecord; center: Impact['controls'][number]['center']; state: 'overridden'};
export function explainUserBudget(user: UserData, impact: Impact):
    | {effective: null; reason: string; overridden: []}
    | {
        effective: NonNullable<Impact['effective']>;
        kind: 'individual' | 'cost_center' | 'enterprise' | 'unknown';
        title: string;
        rationale: string;
        expiration: string | null;
        overridden: Override[];
    };
