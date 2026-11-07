import {createContext, useContext, type ReactNode} from 'react';
import {LinkExternalIcon} from '@primer/octicons-react';
import {budgetEntityLink, resourceLink, trustedEnterpriseTeamUrl, userLogin} from './resource-links.mjs';
import {budgetEntity, type BudgetRecord} from './budget-format.mjs';

type Links = {host: string | null; enterprise: string | null; openUser: ((login: string) => void) | null};
const LinksContext = createContext<Links>({host: null, enterprise: null, openUser: null});
export const ResourceLinksProvider = LinksContext.Provider;
export const useResourceLinks = () => useContext(LinksContext);

export function ExternalLink({href, children}: {href: string; children: ReactNode}) {
  const destination = new URL(href);
  return <a className="external-link" href={href} target="_blank" rel="noopener noreferrer"
    title={`Opens ${destination.host}${destination.pathname} in your browser`} onClick={event => event.stopPropagation()}>
    {children}<LinkExternalIcon size={12} className="external-link-icon" aria-hidden="true" />
    <span className="sr-only"> (opens on GitHub in your browser, new tab)</span>
  </a>;
}

export function UserLink({login, children}: {login: string; children?: ReactNode}) {
  const {openUser} = useResourceLinks();
  const normalized = userLogin(login);
  if (!normalized || !openUser) return <>{children ?? login}</>;
  return <button type="button" className="row-link" title={`View @${normalized} on the Users page`}
    onClick={event => {event.stopPropagation();openUser(normalized);}}>
    {children ?? login}<span className="sr-only"> (view on Users page)</span>
  </button>;
}

export function ResourceName({type, name}: {type: string; name: string}) {
  const target = useResourceLinks();
  const link = resourceLink(type, name, target);
  if (link?.kind === 'user') return <UserLink login={link.login}>{name}</UserLink>;
  if (link?.kind === 'external') return <ExternalLink href={link.href}>{name}</ExternalLink>;
  return <>{name}</>;
}

export function TeamLink({htmlUrl, children}: {htmlUrl: string | null | undefined; children: ReactNode}) {
  const {host} = useResourceLinks();
  const href = trustedEnterpriseTeamUrl(host, htmlUrl);
  return href ? <ExternalLink href={href}>{children}</ExternalLink> : <>{children}</>;
}

export function BudgetEntity({budget}: {budget: BudgetRecord}) {
  const target = useResourceLinks();
  const label = budgetEntity(budget);
  const link = budgetEntityLink(budget, target);
  if (link?.kind === 'user') return <UserLink login={link.login}>{label}</UserLink>;
  if (link?.kind === 'external') return <ExternalLink href={link.href}>{label}</ExternalLink>;
  return <>{label}</>;
}
