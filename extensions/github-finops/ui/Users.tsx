import {useState, type FormEvent, type Dispatch, type SetStateAction} from 'react';
import {Button, Flash, Label, TextInput} from '@primer/react';
import {useSnapshot, SnapshotStatus, RefreshButton} from './Snapshot';
import {budgetAmount, budgetEntity, scopeLabel} from './budget-format.mjs';
import {normalizeUsername, resolveUserBudgets, type UserData} from './user-format.mjs';

export type UserLookup = {query: string; login: string | null};
type Navigation = {openCenter: (id: string) => void; openBudget: (id: string) => void};
const usd = (value: number | null) => value == null ? 'Unavailable' :
  `${new Intl.NumberFormat(undefined, {style:'currency',currency:'USD'}).format(value)} USD`;
const enforcement = (value: boolean | null) => value === true ? 'Hard stop reported' :
  value === false ? 'No hard stop reported' : 'Enforcement not returned';

function UserResult({login, openCenter, openBudget}: {login: string} & Navigation) {
  const state = useSnapshot<UserData>(`users/${encodeURIComponent(login)}`);
  const user = state.snapshot?.data;
  const relationships = state.snapshot?.relationships;
  const impact = user ? resolveUserBudgets(user, relationships) : null;
  const effective = impact?.effective;
  const month = user ? new Intl.DateTimeFormat(undefined, {month:'long',year:'numeric',timeZone:'UTC'})
    .format(new Date(Date.UTC(user.period.year,user.period.month - 1))) : '';
  return <section aria-label="User lookup result">
    <div className="user-result-heading"><h3>{user ? `@${user.login}` : `@${login}`}</h3><RefreshButton state={state} /></div>
    <SnapshotStatus state={state} />
    {user && impact && <div aria-busy={state.loading}>
      <p className="muted">{month} / {user.accountType} / Budget-tracked amounts in USD, not credit quantities or net billed spending.</p>
      <section className="resource-section"><h3>Cost center memberships</h3>
        <p className="caption">Memberships reported for this username. Membership alone does not establish which organization or cost center pays for a request.</p>
        {user.memberships.length ? <div className="user-memberships">{user.memberships.map(center =>
          <div className="notice" key={center.id}><button className="row-link" type="button" onClick={() => openCenter(center.id)}>{center.name}</button><p className="caption">Membership API / matched by cost center ID</p></div>)}</div> :
          <p className="empty-results">No cost center memberships returned. This does not establish that the user's usage is unallocated.</p>}
      </section>
      <section className="spending-section user-effective" aria-labelledby="effective-budget-title">
        <h3 id="effective-budget-title">Effective per-user AI Credits budget</h3>
        {effective ? <>
          <p><button className="row-link" type="button" onClick={() => openBudget(effective.id)}>{scopeLabel(effective.budget.scope)}</button> <Label>Selected by GitHub for this user</Label></p>
          <div className="spending-metrics">
            <div><span className="muted">Per-user limit</span><strong>{usd(effective.amount)}</strong></div>
            <div><span className="muted">Budget-tracked consumption</span><strong>{usd(effective.consumed)}</strong></div>
            <div><span className="muted">Headroom</span><strong>{usd(impact.headroom)}</strong><p className="caption">Limit minus reported consumption; not a usage authorization decision.</p></div>
          </div>
          <p>{enforcement(effective.budget.preventFurtherUsage)}</p>
        </> : <Flash>{!user.filterVerified ? 'The response did not confirm the requested username; effective applicability is unverified.' :
          user.effectiveStatus === 'not_returned' ? 'The API did not return an effective per-user budget.' :
          user.effectiveStatus === 'none_reported' ? 'GitHub reported no effective per-user budget.' :
          'The reported effective budget could not be verified as an AI Credits control for this user.'} No zero limit, unlimited usage, or blocked status is inferred.</Flash>}
        <p className="caption">Policies, billing organization, included credits, and pool state can affect usage. A configured hard stop or exhausted headroom is not proof that this user is currently blocked.</p>
      </section>
      <section className="resource-section"><h3>Per-user controls and defaults</h3>
        <p className="caption">An individual override can supersede cost center and enterprise per-user defaults. Only the API-selected effective budget is marked active. Saved configurations outside the user-filtered response are candidates, not confirmed applicable controls.</p>
        {impact.controls.length ? <div className="table-scroll center-table"><table>
          <caption className="sr-only">AI Credits per-user controls, defaults and precedence</caption>
          <thead><tr><th scope="col">Budget</th><th scope="col">Limit / user</th><th scope="col">Status</th><th scope="col">Enforcement</th></tr></thead>
          <tbody>{impact.controls.map(({budget,center,state: status,source}) => <tr key={budget.id}>
            <td><button className="row-link" type="button" onClick={() => openBudget(budget.id)}>{scopeLabel(budget.scope)}</button>
              <p className="caption">{center ? <button className="row-link" type="button" onClick={() => openCenter(center.id)}>{center.name}</button> : budgetEntity(budget)}</p>
              {center && <span className="relationship-note">{center.matchedBy === 'id' ? 'Cost center matched by ID' : 'Exact unique name association from saved complete center list; may be stale'}</span>}
            </td>
            <td>{budgetAmount(budget.amount,budget)}</td>
            <td><Label>{status === 'effective' ? 'Effective' : status === 'overridden' ? 'Overridden default' : 'Applicability unconfirmed'}</Label><p className="caption">{source === 'user_filter' ? 'User-filtered API response' : source === 'effective_detail' ? 'Detail configuration / effective ID from user query' : 'Saved configuration; may be stale'}</p></td>
            <td>{enforcement(budget.preventFurtherUsage)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="empty-results">No verified per-user AI Credits candidates. Missing configuration is not an unlimited allowance.</p>}
        {impact.excluded > 0 && <p className="caption">{impact.excluded} unmatched user-filtered candidate{impact.excluded === 1 ? '' : 's'} omitted; the user filter alone is not proof of applicability.</p>}
      </section>
      <section className="resource-section"><h3>Metered spending guardrail candidates</h3>
        <p className="caption">Separate aggregate AI Credits spending controls, not additional per-user allowances. Membership and saved relationships do not prove billing assignment; applicability remains unknown.</p>
        {impact.guardrails.length ? <div className="table-scroll center-table"><table>
          <caption className="sr-only">Potential aggregate AI Credits spending guardrails, applicability unknown</caption>
          <thead><tr><th scope="col">Budget</th><th scope="col">Aggregate limit</th><th scope="col">Applicability</th><th scope="col">Enforcement</th></tr></thead>
          <tbody>{impact.guardrails.map(({budget,center,reason}) => <tr key={budget.id}>
            <td><button className="row-link" type="button" onClick={() => openBudget(budget.id)}>{scopeLabel(budget.scope)}</button>
              <p className="caption">{center ? <button className="row-link" type="button" onClick={() => openCenter(center.id)}>{center.name}</button> : budgetEntity(budget)}</p>
              {center && <span className="relationship-note">{center.matchedBy === 'id' ? 'Cost center matched by ID' : 'Exact unique name association; may be stale'}</span>}
            </td>
            <td>{budgetAmount(budget.amount,budget)}</td><td><Label>Unknown</Label><p className="caption">{reason}</p></td><td>{enforcement(budget.preventFurtherUsage)}</td>
          </tr>)}</tbody>
        </table></div> : <p className="empty-results">No matching saved guardrail candidates. This does not establish that no spending guardrails exist.</p>}
        <p className="caption">{relationships?.lists.budgets ? `Complete budget list saved ${new Date(relationships.lists.budgets.fetchedAt).toLocaleString()}; may be stale.` :
          'The complete budget list has not been loaded. Open Budgets separately to load it; lookup does not fetch it automatically.'} Organization/repository billing assignment and additional guardrails are not resolved. Other product budgets are not treated as controls on the AI Credits bundle.</p>
        {relationships?.lists.budgets?.error && <Flash variant="danger">{relationships.lists.budgets.error}</Flash>}
        {relationships?.lists.centers?.error && <Flash variant="danger">{relationships.lists.centers.error}</Flash>}
      </section>
    </div>}
  </section>;
}

export default function Users({lookup,setLookup,openCenter,openBudget}: {
  lookup: UserLookup; setLookup: Dispatch<SetStateAction<UserLookup>>;
} & Navigation) {
  const [error,setError] = useState<string | null>(null);
  function submit(event: FormEvent) {
    event.preventDefault();
    try {const login = normalizeUsername(lookup.query);setLookup({...lookup,login});setError(null);}
    catch (error) {setError(error instanceof Error ? error.message : 'Enter a GitHub username.');}
  }
  return <main>
    <div className="overview-heading"><div><div className="eyebrow">CONFIGURATION</div><h2>Users</h2><p className="muted">Look up one user's cost centers and AI Credits budget controls.</p></div></div>
    <form className="user-search" onSubmit={submit}>
      <label htmlFor="user-lookup">GitHub username</label>
      <div><TextInput id="user-lookup" block value={lookup.query} onChange={event => setLookup({...lookup,query:event.target.value})} placeholder="username or @username" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-describedby="user-lookup-help" /><Button type="submit">Search</Button></div>
      <p id="user-lookup-help" className="caption">Saved users load from local SQLite without querying GitHub. New lookups resolve and cache read-only billing data; Refresh checks for changes.</p>
    </form>
    {error && <div className="error" role="alert"><Flash variant="danger">{error}</Flash></div>}
    {lookup.login && <UserResult key={lookup.login} login={lookup.login} openCenter={openCenter} openBudget={openBudget} />}
  </main>;
}
