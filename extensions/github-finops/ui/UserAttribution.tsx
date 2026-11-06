import {Flash, Label} from '@primer/react';
import type {UserData} from './user-format.mjs';
import type {RelationshipsData} from './Relationships';
import {scopeLabel} from './budget-format.mjs';

type Props = {user: UserData; relationships?: RelationshipsData; cached: boolean;
  openCenter: (id: string) => void; openBudget: (id: string) => void};
const methodLabel = (method: string) => ({direct: 'Direct user assignment', team: 'Enterprise team',
  organization: 'Copilot license organization', enterprise: 'Enterprise only'}[method] ?? method);

export default function UserAttribution({user, relationships, cached, openCenter, openBudget}: Props) {
  const attribution = user.attribution;
  if (!attribution) return <section className="resource-section"><h3>AI spending attribution</h3>
    <Flash>Attribution has not been checked in this saved snapshot. Refresh this user to collect evidence.</Flash></section>;
  const {center, evidence} = attribution;
  const links = relationships?.links.filter(link => link.centerId === center?.id) ?? [];
  return <section className="spending-section user-effective" aria-labelledby="attribution-title">
    <h3 id="attribution-title">AI spending attribution</h3>
    <p className="caption">Current attribution, not historical monthly allocation. This is separate from GitHub's effective per-user budget selection.</p>
    <p><Label>{attribution.status === 'confirmed' ? 'Confirmed at last check' :
      attribution.status === 'provisional' ? 'Provisional' : 'Unresolved'}</Label>{' '}
      {center ? <button className="row-link" type="button" onClick={() => openCenter(center.id)}>{center.name}</button> :
        attribution.status === 'confirmed' ? <strong>Enterprise only</strong> : <strong>No confirmed winner</strong>}
    </p>
    <p><strong>{methodLabel(attribution.method)}</strong>{attribution.unresolved.length === 0 && ` / ${attribution.reason}`}</p>
    {attribution.unresolved.length > 0 && <Flash variant="warning">{attribution.unresolved.join(' ')}</Flash>}
    <p className="caption">Evidence checked {new Date(attribution.checkedAt).toLocaleString()}.{cached && ' Saved evidence may be stale; opening this view makes no additional GitHub requests.'}</p>
    {attribution.invalidatedAt && <p className="caption">Configuration refreshed {new Date(attribution.invalidatedAt).toLocaleString()}; user evidence needs rechecking.</p>}
    {attribution.lastConfirmed && attribution.status !== 'confirmed' && <p className="caption">
      Last confirmed {new Date(attribution.lastConfirmed.checkedAt).toLocaleString()}: {' '}
      {attribution.lastConfirmed.center ? <button className="row-link" type="button"
        onClick={() => openCenter(attribution.lastConfirmed!.center!.id)}>{attribution.lastConfirmed.center.name}</button> : 'Enterprise only'}.
      {' '}Retained for reference, not a current attribution decision.
    </p>}
    <p className="caption">Checks: direct assignment {evidence.direct.state.replaceAll('_', ' ')}; enterprise teams {evidence.teams.state.replaceAll('_', ' ')}; Copilot organization {evidence.license.state.replaceAll('_', ' ')}.</p>
    {evidence.license.state === 'not_checked' && <p className="caption">Copilot organization not checked: a higher-priority assignment wins or higher-priority evidence is incomplete.</p>}
    <details><summary>Alternative memberships and evidence</summary>
      {attribution.alternatives.length ? attribution.alternatives.map((item, index) => <div className="notice" key={index}>
        <p><strong>{item.method === 'direct' ? 'User membership check' : methodLabel(item.method)}</strong>{' / '}
          {item.htmlUrl ? <a href={item.htmlUrl} target="_blank" rel="noreferrer">{item.name}</a> : item.name}
          {item.center && <button className="row-link" type="button" onClick={() => openCenter(item.center!.id)}>{item.center.name}</button>}
        </p>
        {item.centers?.map(candidate => <p key={candidate.id}><button className="row-link" type="button" onClick={() => openCenter(candidate.id)}>{candidate.name}</button></p>)}
        <p className="caption">{item.reason}{item.createdAt && ` Created ${new Date(item.createdAt).toLocaleString()}.`}</p>
      </div>) : <p className="caption">No alternative assignments verified.</p>}
      {user.enterpriseTeams?.items?.filter(team => !attribution.alternatives.some(item => item.slug === team.slug)).map(team =>
        <p className="caption" key={team.id}>{team.name}: lower-priority team assignment not evaluated; a direct assignment takes precedence or direct checks are incomplete.</p>)}
    </details>
    {center && <div className="resource-section"><h4>Related saved budgets</h4>
      {links.map(link => {
        const budget = relationships?.budgets.find(item => item.id === link.budgetId);
        return budget && <p key={link.budgetId}><button className="row-link" type="button" onClick={() => openBudget(budget.id)}>
          {scopeLabel(budget.scope)} / {budget.product}
        </button><span className="caption"> / {link.matchedBy === 'id' ? 'Center ID match' : 'Unique name association; may be stale'}</span></p>;
      })}
      <p className="caption">{links.length ? 'Saved associations are not proof that a budget is effective or blocking.' :
        'No related budgets in saved data. Open Budgets to load configuration; no extra budget requests are made here.'}</p>
    </div>}
    <p className="caption">Repository membership does not establish user AI credit attribution. For historical charges or ambiguous Copilot billing organizations, consult a detailed usage report.</p>
  </section>;
}
