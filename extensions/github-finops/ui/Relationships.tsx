import {Flash, Label} from '@primer/react';
import {budgetAmount, budgetEntity, scopeLabel, type BudgetRecord} from './budget-format.mjs';

type Coverage = {fetchedAt: string; error: string | null} | null;
export type RelationshipsData = {
  centers: {id: string; name: string; fetchedAt: string}[];
  budgets: (BudgetRecord & {fetchedAt: string})[];
  links: {budgetId: string; centerId: string; matchedBy: 'id' | 'exact_unique_name'}[];
  lists: {centers: Coverage; budgets: Coverage};
  unresolved: {budgetId: string; reason: string}[];
};

const matchLabel = (method: string) => method === 'id' ? 'Matched by ID' : 'Exact unique name match';

export function CostCenterLink({budget, relationships, open}: {
  budget: BudgetRecord; relationships?: RelationshipsData; open: (id: string) => void;
}) {
  if (!['cost_center', 'multi_user_cost_center'].includes(budget.scope)) return <>{budgetEntity(budget)}</>;
  const link = relationships?.links.find(link => link.budgetId === budget.id);
  const center = relationships?.centers.find(center => center.id === link?.centerId);
  const reason = relationships?.unresolved.find(item => item.budgetId === budget.id)?.reason;
  return center && link ? <>
    <button className="row-link" type="button" onClick={event => {event.stopPropagation();open(center.id);}}>{center.name}</button>
    <span className="relationship-note">{matchLabel(link.matchedBy)} / center saved {new Date(center.fetchedAt).toLocaleString()}; may be stale.</span>
  </> : <>
    {budgetEntity(budget)}
    <span className="relationship-note">{reason === 'ambiguous_name' ? 'Unresolved: duplicate cost center names.' :
      reason === 'entity_unavailable' ? 'Unresolved: no entity returned.' :
      !relationships?.lists.centers ? 'Cost center list not loaded; relationship unresolved.' :
      'No unique ID or exact name match in saved centers.'}</span>
  </>;
}

export function RelatedBudgets({centerId, relationships, open}: {
  centerId: string; relationships?: RelationshipsData; open: (id: string | null) => void;
}) {
  const links = relationships?.links.filter(link => link.centerId === centerId) ?? [];
  const coverage = relationships?.lists.budgets;
  return <section className="resource-section"><h3>Related budgets</h3>
    <p className="caption">{coverage ? `Saved budget list from ${new Date(coverage.fetchedAt).toLocaleString()}. Relationships may be stale.` :
      'The complete budget list has not been loaded. Saved matches may be incomplete.'}</p>
    <p className="caption">Name-based associations use exact, unique names from the saved complete cost center list, not an API-supplied foreign key.</p>
    {relationships?.lists.centers && <p className="caption">Cost center list saved {new Date(relationships.lists.centers.fetchedAt).toLocaleString()}.</p>}
    {coverage?.error && <Flash variant="danger">{coverage.error}</Flash>}
    {relationships?.lists.centers?.error && <Flash variant="danger">{relationships.lists.centers.error}</Flash>}
    {links.length ? <div className="table-scroll center-table"><table>
      <caption className="sr-only">Saved budgets associated with this cost center</caption>
      <thead><tr><th scope="col">Product / SKU</th><th scope="col">Control</th><th scope="col">Limit</th><th scope="col">Association</th></tr></thead>
      <tbody>{links.map(link => {
        const budget = relationships?.budgets.find(budget => budget.id === link.budgetId);
        return budget && <tr key={link.budgetId}>
          <td><button className="row-link" type="button" onClick={() => open(budget.id)}>{budget.product}</button><p className="caption">{budget.type}</p></td>
          <td>{budget.scope === 'cost_center' ? 'Aggregate spending' : scopeLabel(budget.scope)}</td>
          <td>{budgetAmount(budget.amount, budget)}{budget.scope === 'multi_user_cost_center' && ' / user'}</td>
          <td><Label>{matchLabel(link.matchedBy)}</Label><p className="caption">Saved {new Date(budget.fetchedAt).toLocaleString()}</p></td>
        </tr>;
      })}</tbody>
    </table></div> : <p className="muted">No resolved budget links in saved data. This does not establish that no budgets exist.</p>}
    <p className="caption"><button type="button" className="row-link" onClick={() => open(null)}>Open Budgets</button> to load or refresh the complete list.</p>
  </section>;
}
