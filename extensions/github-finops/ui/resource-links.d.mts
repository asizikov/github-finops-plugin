import type {BudgetRecord} from './budget-format.mjs';
export type LinkTarget = {host?: string | null; enterprise?: string | null};
export type ResourceLink = {kind: 'user'; login: string} |
    {kind: 'external'; type: 'organization' | 'repository' | 'team'; href: string};
export function organizationUrl(host: string, login: string): string | null;
export function repositoryUrl(host: string, fullName: string): string | null;
export function enterpriseTeamUrl(host: string, enterprise: string, slug: string): string | null;
export function trustedEnterpriseTeamUrl(host: string | null | undefined, value: string | null | undefined): string | null;
export function userLogin(value: unknown): string | null;
export function resourceKind(type: unknown): 'user' | 'organization' | 'repository' | 'team' | null;
export function resourceLink(type: string, name: string | null | undefined, target?: LinkTarget): ResourceLink | null;
export function budgetEntityLink(budget: BudgetRecord, target?: LinkTarget): ResourceLink | null;
