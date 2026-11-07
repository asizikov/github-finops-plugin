import {Button, Label, TextInput, FormControl} from '@primer/react';
import {useSnapshot, SnapshotStatus, RefreshButton} from './Snapshot';
import {budgetAmount, budgetUnit, paginateBudgets, scopeLabel, type BudgetRecord} from './budget-format.mjs';
import {CostCenterLink} from './Relationships';
import type {ListState} from './pagination.mjs';

const enforcement = (value: boolean | null) => value === true ? 'Hard stop' : value === false ? 'Not enforced' : 'Unknown';
const enabled = (value: boolean | null) => value === true ? 'Enabled' : value === false ? 'Disabled' : 'Unknown';
const perUser = (budget: BudgetRecord) => budget.scope.startsWith('multi_user_') ? ' / user' : '';

function Details({id, back, backLabel, openCenter}: {id: string; back: () => void; backLabel: string; openCenter: (id: string) => void}) {
  const state = useSnapshot<BudgetRecord>(`budgets/${encodeURIComponent(id)}`);
  const budget = state.snapshot?.data;
  return <main>
    <Button variant="invisible" onClick={back}>{backLabel}</Button>
    <div className="overview-heading"><div><h2>{budget?.product ?? 'Budget configuration'}</h2><p className="muted">{budget ? `${scopeLabel(budget.scope)} budget settings and reported consumption.` : 'Budget settings and reported consumption.'}</p></div><RefreshButton state={state} /></div>
    <SnapshotStatus state={state} />
    {budget && <div aria-busy={state.loading}>
      <section className="spending-section" aria-labelledby="budget-spending-title"><h3 id="budget-spending-title">Spending and limits</h3>
        <div className="spending-metrics">
          <div><span className="muted">Budget limit{perUser(budget)}</span><strong>{budgetAmount(budget.amount, budget)}</strong></div>
          <div><span className="muted">Budget-tracked consumption</span><strong>{budgetAmount(budget.consumed, budget)}</strong></div>
        </div>
        {budget.scope.startsWith('multi_user_') && <p className="field-note">A per-user default, not an aggregate member spending budget. Missing consumption is unavailable.</p>}
        {!budgetUnit(budget) && <p className="field-note">Units were not returned and this product has no supported unit mapping. No currency is assumed.</p>}
        <p className="field-note">Consumption is not a finalized invoice. Budgets may overlap; do not sum them.</p>
      </section>
      <section className="budget-card config-details" aria-labelledby="budget-configuration-title"><h3 id="budget-configuration-title">Configuration</h3><dl>
      <div><dt>ID</dt><dd>{budget.id}</dd></div>
      <div><dt>Pricing type</dt><dd>{budget.type}</dd></div>
      <div><dt>Scope</dt><dd>{scopeLabel(budget.scope)}</dd></div>
      <div><dt>Entity</dt><dd><CostCenterLink budget={budget} relationships={state.snapshot?.relationships} open={openCenter} /></dd></div>
      <div><dt>Enforcement</dt><dd>{enforcement(budget.preventFurtherUsage)}</dd></div>
      <div><dt>Alerts</dt><dd>{enabled(budget.alerts)}</dd></div>
      <div><dt>Alert recipients</dt><dd>{budget.alertRecipients == null ? <span className="missing-value">Not reported</span> : budget.alertRecipients.length ? budget.alertRecipients.join(', ') : 'None configured'}</dd></div>
      <div><dt>Expiration</dt><dd>{budget.expiresAt === undefined ? <span className="missing-value">Not reported</span> : budget.expiresAt || 'No expiration'}</dd></div>
      {budget.scope === 'enterprise' && <div><dt>Cost center usage</dt><dd>{budget.excludeCostCenters === true ? 'Excluded' : budget.excludeCostCenters === false ? 'Included' : 'Unknown'}</dd></div>}
    </dl>
    </section></div>}
  </main>;
}

export default function Budgets({selected, list, setList, select, back, backLabel, canGoBack, openCenter}: {
  selected?: string; list: ListState; setList: (value: ListState) => void; select: (id: string) => void;
  back: () => void; backLabel: string; canGoBack: boolean; openCenter: (id: string) => void;
}) {
  return selected ? <Details key={selected} id={selected} back={back} backLabel={backLabel} openCenter={openCenter} /> :
    <BudgetList query={list.query} setQuery={query => setList({query,page:1})} page={list.page} setPage={page => setList({...list,page})} select={select} openCenter={openCenter} back={canGoBack ? back : undefined} backLabel={backLabel} />;
}

function BudgetList({query, setQuery, page, setPage, select, openCenter, back, backLabel}: {
  query: string; setQuery: (value: string) => void; page: number; setPage: (value: number) => void; select: (id: string) => void;
  openCenter: (id: string) => void;
  back?: () => void; backLabel: string;
}) {
  const state = useSnapshot<BudgetRecord[]>('budgets');
  const result = paginateBudgets(state.snapshot?.data ?? [], query, page);
  return <main>
    {back && <Button variant="invisible" onClick={back}>{backLabel}</Button>}
    <div className="overview-heading"><div><h2>Budgets</h2><p className="muted">Search budgets across available enterprise scopes and products.</p></div><RefreshButton state={state} /></div>
    <SnapshotStatus state={state} />
    {state.snapshot && <>
      <FormControl><FormControl.Label>Search by product, scope, entity, or ID</FormControl.Label><TextInput block value={query} onChange={event => setQuery(event.target.value)} placeholder="Search all budgets" /></FormControl>
      <div className="table-scroll center-table budget-table" tabIndex={0} role="region" aria-label="Budget list" aria-busy={state.loading}><table>
        <caption className="sr-only">Budgets. Select a product or SKU to view configuration.</caption>
        <thead><tr><th scope="col">Product / SKU</th><th scope="col">Scope / entity</th><th scope="col">Limit</th><th scope="col">Consumption</th><th scope="col">Enforcement</th><th scope="col">Alerts</th></tr></thead>
        <tbody>{result.items.map(budget => <tr key={budget.id} onClick={() => select(budget.id)} className="clickable-row">
          <td><button type="button" className="row-link" onClick={event => {event.stopPropagation();select(budget.id);}}>{budget.product}</button><p className="caption">{budget.type}</p></td>
          <td>{scopeLabel(budget.scope)}<div className="caption"><CostCenterLink budget={budget} relationships={state.snapshot?.relationships} open={openCenter} /></div></td>
          <td>{budgetAmount(budget.amount, budget)}{perUser(budget)}</td><td>{budgetAmount(budget.consumed, budget)}</td>
          <td><Label>{enforcement(budget.preventFurtherUsage)}</Label></td><td>{enabled(budget.alerts)}</td>
        </tr>)}</tbody>
      </table>{result.total === 0 && <p className="empty-results">{query ? 'No budgets match this search.' : 'No budgets returned by GitHub.'}</p>}</div>
      <div className="pagination" aria-label="Budget pagination"><span role="status">Showing {result.start}-{result.end} of {result.total} results{query && ` (${state.snapshot.data.length} total)`}</span><div><Button disabled={result.page === 1} onClick={() => setPage(result.page - 1)}>Previous</Button><span>Page {result.page} of {result.pages}</span><Button disabled={result.page === result.pages} onClick={() => setPage(result.page + 1)}>Next</Button></div></div>
      <p className="field-note section-note">Consumption is budget-tracked, not invoiced; budgets may overlap. Open a budget for detailed consumption and unit information.</p>
    </>}
  </main>;
}
