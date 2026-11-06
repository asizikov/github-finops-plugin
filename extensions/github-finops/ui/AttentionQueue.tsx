import {Button, FormControl, Label, Select} from '@primer/react';
import {useState} from 'react';
import {buildAttentionQueue, mergeAttentionBudgets, paginateAttention} from '../attention.mjs';
import {budgetAmount, budgetEntity, scopeLabel, type BudgetRecord} from './budget-format.mjs';
import {SnapshotStatus, useSnapshot} from './Snapshot';

export default function AttentionQueue({openBudget}: {openBudget: (id: string) => void}) {
  const state = useSnapshot<BudgetRecord[]>('attention');
  const [scope, setScope] = useState('');
  const [product, setProduct] = useState('');
  const [page, setPage] = useState(1);
  const budgets = state.snapshot ? mergeAttentionBudgets(state.snapshot.data, state.snapshot.cache.fetchedAt,
    state.snapshot.relationships?.budgets) : [];
  const queue = buildAttentionQueue(budgets, state.now);
  const result = paginateAttention(queue.rows, scope, product, page);
  const scopes = [...new Set(budgets.map(budget => budget.scope))].sort();
  const products = [...new Set(budgets.map(budget => budget.product))].sort();
  return <section className="attention-section" aria-labelledby="attention-heading">
    <div className="overview-heading">
      <div><h3 id="attention-heading">Attention queue</h3><p className="muted">Signals from saved budget records.</p></div>
      <Button disabled={state.loading} onClick={() => void state.refresh(false)}>{state.loading ? 'Loading queue...' : 'Reload queue'}</Button>
    </div>
    <SnapshotStatus state={state} />
    <p className="section-intro">Reload reads local cache only. Refresh Budgets separately to update coverage.</p>
    {!state.loading && !state.snapshot && !state.error && <p className="empty-results">No saved budget list. Open Budgets and load a snapshot first.</p>}
    {state.snapshot && <>
      <div className="filter-bar">
        <FormControl><FormControl.Label>Scope</FormControl.Label>
          <Select value={scope} onChange={event => {setScope(event.target.value); setPage(1);}}>
            <Select.Option value="">All scopes</Select.Option>
            {scopes.map(value => <Select.Option key={value} value={value}>{scopeLabel(value)}</Select.Option>)}
          </Select>
        </FormControl>
        <FormControl><FormControl.Label>Product / SKU</FormControl.Label>
          <Select value={product} onChange={event => {setProduct(event.target.value); setPage(1);}}>
            <Select.Option value="">All products</Select.Option>
            {products.map(value => <Select.Option key={value} value={value}>{value}</Select.Option>)}
          </Select>
        </FormControl>
      </div>
      <p className="field-note">{queue.coverage.comparable} of {queue.coverage.total} cached budgets can be evaluated for usage; {queue.coverage.unavailable} cannot. Saved records may be stale and coverage incomplete.</p>
      <div className="table-scroll center-table wide-table" tabIndex={0} role="region" aria-label="Budget attention signals" aria-busy={state.loading}><table>
        <caption className="sr-only">Budget attention signals. Select a product to open its budget details.</caption>
        <thead><tr><th scope="col">Product / SKU</th><th scope="col">Scope / entity</th><th scope="col">Severity / reason</th><th scope="col">Consumption / limit</th></tr></thead>
        <tbody>{result.items.map(({budget, reasons, percent, severity}) => <tr key={budget.id}>
          <td><button className="row-link" type="button" onClick={() => openBudget(budget.id)}>{budget.product}</button><p className="caption">{budget.id}</p>
            {budget.fetchedAt && <p className="caption">Record saved {new Date(budget.fetchedAt).toLocaleString()}; may be stale.</p>}
          </td>
          <td>{scopeLabel(budget.scope)}<p className="caption">{budgetEntity(budget)}</p></td>
          <td><Label variant={severity === 'critical' ? 'danger' : 'attention'}>{severity === 'critical' ? 'Critical' : 'Warning'}</Label>
            {reasons.map(reason => <p className="caption" key={reason.code}>{reason.label}</p>)}
            {reasons.some(reason => reason.code === 'override-expiring') && <p className="caption">{budget.expiresAt}</p>}
          </td>
          <td>{budgetAmount(budget.consumed, budget)} / {budgetAmount(budget.amount, budget)}
            {budget.scope.startsWith('multi_user_') && <p className="caption">Per-user default, not an aggregate</p>}
            {percent !== null && <p className="caption">{new Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(percent)}% used</p>}
            {budget.amount === 0 && <p className="caption">Zero limit; percentage not applicable</p>}
          </td>
        </tr>)}</tbody>
      </table>{!result.total && <p className="empty-results">{queue.rows.length ? 'No attention signals match these filters.' : 'No attention signals in the available cached data. This does not confirm that all budgets are healthy.'}</p>}</div>
      <div className="pagination" aria-label="Attention queue pagination">
        <span role="status">Showing {result.start}-{result.end} of {result.total} budgets</span>
        <div><Button disabled={result.page === 1} onClick={() => setPage(result.page - 1)}>Previous</Button>
          <span>Page {result.page} of {result.pages}</span>
          <Button disabled={result.page === result.pages} onClick={() => setPage(result.page + 1)}>Next</Button></div>
      </div>
      <details className="section-details"><summary>How attention signals are evaluated</summary>
        <p>Usage signals require known limits, consumption, and supported units. Missing consumption is not a risk signal; expiration can flag independently. Near limit means at least 90%, below 100%.</p>
        <p>Expiring individual user overrides are within 7 UTC calendar days, including today; expired timestamps are excluded and date-only values use their UTC date. Only returned expirations are evaluated.</p>
        <p>The snapshot time describes the budget list. Newer cached detail/index records replace older records by budget ID; saved relationship-only budgets are included. Each signal shows its record time.</p>
        <p>Reload never queries GitHub or fetches budget details or user rosters. Usage is budget-tracked, not invoiced; budgets may overlap. No forecasts or inferred user usage.</p>
      </details>
    </>}
  </section>;
}
