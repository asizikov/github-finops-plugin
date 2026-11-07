import {Flash, Label} from '@primer/react';
import {budgetAmount, budgetEntity, scopeLabel} from './budget-format.mjs';
import {userBudgetEnforcement, type UserData, resolveUserBudgets} from './user-format.mjs';
import {explainUserBudget} from './user-explanation.mjs';

type Impact = ReturnType<typeof resolveUserBudgets>;
type Props = {user: UserData; impact: Impact; openBudget: (id: string) => void};

const usd = (value: number | null) => value == null ? 'Unavailable' :
  `${new Intl.NumberFormat(undefined, {style:'currency',currency:'USD'}).format(value)} USD`;

export default function UserBudgetExplanation({user, impact, openBudget}: Props) {
  const explanation = explainUserBudget(user, impact);
  return <section className="spending-section user-effective" aria-labelledby="effective-budget-title">
    <h3 id="effective-budget-title">Effective per-user AI Credits budget</h3>
    {explanation.effective ? <>
      <p className="attribution-result"><button className="row-link" type="button" onClick={() => openBudget(explanation.effective.id)}>
        {scopeLabel(explanation.effective.budget.scope)}
      </button> <Label>Selected by GitHub for this user</Label></p>
      <div className="effective-summary" role="group" aria-label="Why this per-user limit">
        <div className="spending-metrics">
          <div><span className="muted">Effective per-user limit</span><strong>{usd(explanation.effective.amount)}</strong></div>
          <div><span className="muted">Reported consumption</span><strong>{usd(explanation.effective.consumed)}</strong></div>
          <div><span className="muted">Calculated headroom</span><strong>{usd(impact.headroom)}</strong>
            <p className="caption">Limit minus reported consumption; not a usage authorization decision.</p>
          </div>
        </div>
        <p><strong>{explanation.title}</strong></p>
        <p>{explanation.rationale}</p>
        <p>{userBudgetEnforcement(explanation.effective.budget)}</p>
        <p className="caption">{explanation.expiration
          ? `Expiration returned by GitHub: ${explanation.expiration}`
          : 'Expiration was not returned; expiry status is unknown.'}</p>
      </div>
      {explanation.overridden.length > 0 && <p className="caption">
        Other per-user defaults shown as overridden are not the API-selected effective limit: {explanation.overridden.map(({budget}, index) =>
          <span key={budget.id}>{index > 0 ? ', ' : ''}<button className="row-link" type="button" onClick={() => openBudget(budget.id)}>
            {scopeLabel(budget.scope)} ({budgetEntity(budget)})
          </button></span>)}.
      </p>}
    </> : <Flash>{explanation.reason} No zero limit, unlimited usage, or blocked status is inferred.</Flash>}
    <p className="field-note section-note">This cap limits total AI Credits usage value, including covered usage, not net charges or a personal credit grant.</p>
    <details className="section-details"><summary>How to interpret this limit</summary>
      <p>Included pools and shared metered spending thresholds are separate. Policies, billing organization, included credits, and pool state can affect usage. A configured hard stop or exhausted headroom is not proof that this user is currently blocked.</p>
    </details>
  </section>;
}
