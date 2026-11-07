import {Button, FormControl, Label, Select} from '@primer/react';
import {useState} from 'react';
import {buildAttentionQueue, buildUniversalAttention, mergeAttentionBudgets, paginateAttention, type UniversalUsers} from '../attention.mjs';
import {budgetAmount, budgetEntity, scopeLabel, type BudgetRecord} from './budget-format.mjs';
import {SnapshotStatus, useSnapshot} from './Snapshot';

export default function AttentionQueue({openBudget, openUser}: {openBudget: (id: string) => void; openUser: (login: string) => void}) {
  const state = useSnapshot<BudgetRecord[]>('attention');
  const users = useSnapshot<UniversalUsers>('universal-users');
  const [scope, setScope] = useState('');
  const [product, setProduct] = useState('');
  const [page, setPage] = useState(1);
  const budgets = state.snapshot ? mergeAttentionBudgets(state.snapshot.data, state.snapshot.cache.fetchedAt,
    state.snapshot.relationships?.budgets) : [];
  const queue = buildAttentionQueue(budgets, state.now);
  const userQueue = users.snapshot ? buildUniversalAttention(users.snapshot.data, users.now) : null;
  const rows = [...queue.rows.filter(row => !userQueue?.rows.some(userRow =>
    userRow.overrideBudgetId === row.budget.id && userRow.user?.toLowerCase() === row.budget.user?.toLowerCase())),
    ...(userQueue?.rows ?? [])].sort((a,b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  const result = paginateAttention(rows, scope, product, page);
  const allBudgets = [...budgets, ...(users.snapshot?.data.budgets ?? [])];
  const scopes = [...new Set(allBudgets.map(budget => budget.scope))].sort();
  const products = [...new Set(allBudgets.map(budget => budget.product))].sort();
  return <section className="attention-section" aria-labelledby="attention-heading">
    <div className="overview-heading">
      <div><h3 id="attention-heading">Attention queue</h3><p className="muted">Budget risks and individual universal-budget usage.</p></div>
      <div className="action-row"><Button disabled={state.loading || users.loading} onClick={() => {void state.refresh(false); void users.refresh(false);}}>Reload queue</Button>
        <Button disabled={users.loading || users.blocked} onClick={() => void users.refresh(true)}>{users.loading ? 'Reading users...' : users.blocked ? 'Rate limited' : users.snapshot ? 'Refresh user states' : 'Load user states'}</Button></div>
    </div>
    {(state.snapshot || state.error) && <p className="caption">Budget records</p>}<SnapshotStatus state={state} />
    {(users.snapshot || users.error) && <p className="caption">Universal user states</p>}<SnapshotStatus state={users} />
    <p className="section-intro">Reload reads local cache only. Load / Refresh user states explicitly reads budget controls and paginated per-user states, not profiles or a member directory.</p>
    {!users.snapshot && !users.loading && <p className="field-note">Universal per-user usage has not been loaded for this account and UTC billing month. No user-level health conclusion is available.</p>}
    {users.snapshot && <p className="field-note">User states: {users.snapshot.data.period.year}-{String(users.snapshot.data.period.month).padStart(2,'0')} UTC; {users.snapshot.data.coverage.controls} universal controls, {users.snapshot.data.coverage.records} returned states; {userQueue?.coverage.comparable} have an identifiable user and comparable reported target. {users.snapshot.data.coverage.unidentified} have no user identity. Active users appear gradually each billing cycle; this is not a licensed-user roster. At most 2,000 records per control are read; incomplete refreshes retain the last successful snapshot.</p>}
    {!state.loading && !state.snapshot && !state.error && <p className="empty-results">No saved budget list. Open Budgets and load a snapshot first.</p>}
    {(state.snapshot || users.snapshot) && <>
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
        <tbody>{result.items.map(({budget, reasons, percent, severity, user, key, applicability, limitLabel, universalAmount}) => <tr key={key ?? budget.id}>
          <td><button className="row-link" type="button" onClick={() => openBudget(budget.id)}>{budget.product}</button><p className="caption">{budget.id}</p>
            {budget.fetchedAt && <p className="caption">Record saved {new Date(budget.fetchedAt).toLocaleString()}; may be stale.</p>}
          </td>
          <td>{user ? <button className="row-link" type="button" onClick={() => openUser(user)}>{user}</button> : scopeLabel(budget.scope)}<p className="caption">{user ? 'Universal per-user control' : budgetEntity(budget)}</p>
            {applicability && <p className="caption">{applicability}</p>}
          </td>
          <td><Label variant={severity === 'critical' ? 'danger' : 'attention'}>{severity === 'critical' ? 'Critical' : 'Warning'}</Label>
            {reasons.map(reason => <p className="caption" key={reason.code}>{reason.label}</p>)}
            {reasons.some(reason => reason.code === 'override-expiring') && <p className="caption">{budget.expiresAt}</p>}
          </td>
          <td>{budgetAmount(budget.consumed, budget)} / {budgetAmount(budget.amount, budget)}
            {limitLabel && <p className="caption">{limitLabel}. Universal baseline: {budgetAmount(universalAmount ?? null,budget)} / user.</p>}
            {percent !== null && <p className="caption">{new Intl.NumberFormat(undefined, {maximumFractionDigits: 2}).format(percent)}% used</p>}
            {budget.amount === 0 && <p className="caption">Zero limit; percentage not applicable</p>}
          </td>
        </tr>)}</tbody>
      </table>{!result.total && <p className="empty-results">{rows.length ? 'No attention signals match these filters.' : 'No attention signals in the available cached data. This does not confirm that all budgets are healthy.'}</p>}</div>
      <div className="pagination" aria-label="Attention queue pagination">
        <span role="status">Showing {result.start}-{result.end} of {result.total} attention signals</span>
        <div><Button disabled={result.page === 1} onClick={() => setPage(result.page - 1)}>Previous</Button>
          <span>Page {result.page} of {result.pages}</span>
          <Button disabled={result.page === result.pages} onClick={() => setPage(result.page + 1)}>Next</Button></div>
      </div>
      <details className="section-details"><summary>How attention signals are evaluated</summary>
        <p>Usage signals require known limits, consumption, and supported units. Missing consumption is not a risk signal; expiration can flag independently. Near limit means at least 90%, below 100%.</p>
        <p>Expiring individual user overrides are within 7 UTC calendar days, including today; expired timestamps are excluded and date-only values use their UTC date. Only returned expirations are evaluated.</p>
        <p>The snapshot time describes the budget list. Newer cached detail/index records replace older records by budget ID; saved relationship-only budgets are included. Each signal shows its record time.</p>
        <p>Multi-user aggregate consumption is never evaluated as one user's usage. Per-user signals use the returned target, not the universal denominator used by API threshold filters. Overrides or differing targets are labeled separately; expired saved overrides require refresh. Unknown targets only show an explicitly unverified universal-baseline warning. Cost center and individual controls can supersede the universal default; this is not a forecast or invoice.</p>
        <p>Reload never queries GitHub. User-state freshness is separate from the budget-list snapshot; failed or incomplete reads retain last-good states with an error. No profile or membership crawl is performed.</p>
      </details>
    </>}
  </section>;
}
