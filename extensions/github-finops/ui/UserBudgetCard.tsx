import type {ReactNode} from 'react';
import {Label} from '@primer/react';
import {AlertIcon, CheckCircleIcon, CopilotIcon, GlobeIcon, InfoIcon, OrganizationIcon, PeopleIcon, PersonIcon,
  QuestionIcon, SkipIcon, StopIcon, ArrowRightIcon} from '@primer/octicons-react';
import type {RelationshipsData} from './Relationships';
import {TeamLink, useResourceLinks} from './ResourceLinks';
import {resolveUserBudgets, type UserData} from './user-format.mjs';
import {explainUserBudget} from './user-explanation.mjs';
import {freshness, placeBudgets, userChain, userSpending, userUsage,
  type BudgetChip, type ChainLink, type ChainStep, type UserUsage} from './user-card.mjs';

type Props = {user: UserData; relationships?: RelationshipsData; now: number;
  cache?: {source: 'cached' | 'live'; fetchedAt: string; error: string | null};
  openCenter: (id: string) => void; openBudget: (id: string) => void};

const money = (value: number) => `${new Intl.NumberFormat(undefined, {style: 'currency', currency: 'USD'}).format(value)} USD`;
const age = (at: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000));
  if (minutes < 1) return 'just now';
  const [count, unit] = minutes < 60 ? [minutes, 'min'] : minutes < 1440 ? [Math.floor(minutes / 60), 'h'] : [Math.floor(minutes / 1440), 'd'];
  return `${count} ${unit} ago`;
};
const stateText: Record<ChainStep['state'], string> = {subject: 'Looked-up user', active: 'Current path', provisional: 'Provisional', unknown: 'Unknown',
  none: 'Not applicable', container: 'Contains'};
const linkText: Record<ChainLink['kind'], string> = {charges: 'confirmed', tentative: 'provisional', unknown: 'not established',
  skipped: 'skipped', contains: 'containment, not billing'};

function StepIcon({step}: {step: ChainStep}) {
  const Icon = step.kind === 'user' ? PersonIcon : step.kind === 'team' ? PeopleIcon : step.kind === 'organization' ? CopilotIcon
    : step.kind === 'direct' ? ArrowRightIcon : step.kind === 'center' ? (step.state === 'unknown' ? QuestionIcon : step.state === 'none' ? SkipIcon : OrganizationIcon)
    : step.kind === 'enterprise' ? GlobeIcon : step.kind === 'none' ? SkipIcon : QuestionIcon;
  return <span className="chain-icon" aria-hidden="true"><Icon size={16} /></span>;
}

function Chip({chip, openBudget}: {chip: BudgetChip; openBudget: (id: string) => void}) {
  const status = chip.state === 'effective' ? 'Effective for this user' : chip.state === 'overridden' ? 'Overridden'
    : chip.state === 'candidate' ? 'Applicability unconfirmed' : 'Shared; applicability unconfirmed';
  return <li><button type="button" className={`budget-chip chip-${chip.state}`} onClick={() => openBudget(chip.id)}
    title={`${chip.label}${chip.centerName ? ` / ${chip.centerName}` : ''} / ${chip.enforcement}. Open budget.`}>
    <span className="chip-kind">{chip.kind === 'per_user' ? 'Per-user cap' : 'Shared spending'}</span>
    <span className="chip-amount">{chip.amount}{chip.kind === 'per_user' ? ' / user' : ' / month'}</span>
    <span className="chip-state">{chip.state === 'effective' && <CheckCircleIcon size={12} aria-hidden="true" />}{status}</span>
  </button></li>;
}

function Chips({items, openBudget}: {items: BudgetChip[]; openBudget: (id: string) => void}) {
  return items.length ? <ul className="chip-list" aria-label="Budgets at this level">{items.map(chip =>
    <Chip key={chip.id} chip={chip} openBudget={openBudget} />)}</ul> : null;
}

function StepName({step, openCenter}: {step: ChainStep; openCenter: (id: string) => void}) {
  if (step.kind === 'center' && step.centerId) return <button type="button" className="row-link" onClick={() => openCenter(step.centerId!)}>{step.label}</button>;
  if (step.kind === 'team') return <TeamLink htmlUrl={step.htmlUrl}>{step.label}</TeamLink>;
  return <>{step.label}</>;
}

const role = (step: ChainStep) => step.id === 'user' ? 'User' : step.id === 'center' ? 'Cost center' : step.id === 'enterprise' ? 'Enterprise'
  : step.kind === 'team' ? 'Enterprise team' : step.kind === 'organization' ? 'Copilot license org' : 'Assignment route';

function UsageMeter({usage, openBudget}: {usage: UserUsage; openBudget: (id: string) => void}) {
  if (usage.state === 'no_cap') return <div className="scan-cell">
    <span className="scan-label">Budget-tracked usage</span>
    <strong className="scan-value scan-muted">No verified per-user cap</strong>
    <p className="caption">{usage.note} Not treated as zero, unlimited or blocked.</p>
  </div>;
  const percent = usage.percent ?? null;
  const tone = usage.state === 'exceeded' || usage.state === 'reached' ? 'danger' : usage.state === 'near' ? 'attention' : 'accent';
  const Icon = tone === 'danger' ? StopIcon : tone === 'attention' ? AlertIcon : InfoIcon;
  const status = usage.state === 'exceeded' ? `Over cap by ${money((usage.consumed ?? 0) - (usage.limit ?? 0))}`
    : usage.state === 'reached' ? 'Cap reached' : usage.state === 'zero_cap' ? 'Zero cap configured; no usage tracked'
    : usage.state === 'unknown' ? 'Cap amount not returned' : usage.state === 'unknown_usage' ? 'Usage not returned for this user'
    : `${percent!.toFixed(percent! > 0 && percent! < 10 ? 1 : 0)}% used / ${money(usage.headroom ?? 0)} left`;
  return <div className="scan-cell">
    <span className="scan-label">Budget-tracked usage</span>
    <strong className="scan-value">{usage.consumed == null ? 'Unavailable' : money(usage.consumed)}
      <small> of {usage.limit == null ? 'unknown cap' : `${money(usage.limit)} cap`}</small></strong>
    <div className={`meter user-meter tone-${tone}`} role="progressbar" aria-label="Per-user cap used" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={percent == null ? undefined : Math.min(percent, 100)} aria-valuetext={status}>
      <div style={{width: `${percent == null ? (usage.state === 'exceeded' ? 100 : 0) : Math.min(percent, 100)}%`}} />
    </div>
    <p className={`meter-status tone-${tone}`}><Icon size={14} aria-hidden="true" />{status}</p>
    <p className="caption">
      <button type="button" className="row-link" onClick={() => openBudget(usage.budgetId!)}>{usage.title}</button>
      {' '}selected by GitHub / {usage.enforcement}. Includes covered usage; not net spending.
    </p>
  </div>;
}

function SpendingCell({spending, now}: {spending: ReturnType<typeof userSpending>; now: number}) {
  return <div className="scan-cell">
    <span className="scan-label">AI usage report for this user</span>
    {spending.state === 'available' ? <>
      <strong className="scan-value">{money(spending.net)}<small> net</small></strong>
      <dl className="spend-split">
        <div><dt>Gross usage value</dt><dd>{money(spending.gross)}</dd></div>
        <div><dt>Included / discounts</dt><dd>{money(spending.discount)}</dd></div>
      </dl>
      <p className="caption">User-filtered month-to-date report{spending.checkedAt ? `, read ${age(spending.checkedAt, now)}` : ''}; not a final invoice.</p>
    </> : spending.state === 'none_reported' ? <>
      <strong className="scan-value scan-muted">No usage reported</strong>
      <p className="caption">{spending.message}</p>
    </> : <>
      <strong className="scan-value scan-muted">{spending.state === 'denied' ? 'Access denied' : spending.state === 'not_checked' ? 'Not checked' : 'Unavailable'}</strong>
      <p className="caption">{spending.message} Not shown as zero.</p>
    </>}
    {(spending.state === 'available' || spending.state === 'none_reported') && spending.retained &&
      <p className="caption warning">Latest refresh failed ({spending.retained}); last good report shown.</p>}
  </div>;
}

export default function UserBudgetCard({user, relationships, cache, now, openCenter, openBudget}: Props) {
  const {enterprise} = useResourceLinks();
  const impact = resolveUserBudgets(user, relationships);
  const chain = userChain(user, enterprise);
  const usage = userUsage(explainUserBudget(user, impact), impact);
  const spending = userSpending(user.spending);
  const budgets = placeBudgets(impact, chain);
  const status = freshness(cache, user.attribution);
  const month = new Intl.DateTimeFormat(undefined, {month: 'long', year: 'numeric', timeZone: 'UTC'})
    .format(new Date(Date.UTC(user.period.year, user.period.month - 1)));
  const levelBudgets: Record<ChainStep['id'], BudgetChip[]> = {user: budgets.user, route: [], center: budgets.center, enterprise: budgets.enterprise};
  const parts: ReactNode[] = [];
  chain.steps.forEach((step, index) => {
    parts.push(<li key={step.id} className={`chain-step step-${step.state}`}>
      <div className="chain-head"><StepIcon step={step} /><span className="chain-role">{role(step)}</span></div>
      <p className="chain-name"><StepName step={step} openCenter={openCenter} /></p>
      <p className="chain-state">{stateText[step.state]}{step.note && <span className="sr-only">. {step.note}</span>}</p>
      {step.note && <p className="chain-note" aria-hidden="true">{step.note}</p>}
      <Chips items={levelBudgets[step.id]} openBudget={openBudget} />
    </li>);
    const link = chain.links[index];
    if (link) parts.push(<li key={`link-${index}`} className={`chain-link link-${link.kind}`} aria-label={`${link.label} (${linkText[link.kind]})`}>
      <span className="link-line" aria-hidden="true" /><span className="link-label" aria-hidden="true">{link.label}</span>
    </li>);
  });
  return <section className="profile-card" aria-labelledby="profile-card-title">
    <div className="profile-card-top">
      <h3 id="profile-card-title">Budget & spending</h3>
      <div className="profile-card-meta">
        <Label>{month} / UTC month to date</Label>
        <span className={`freshness tone-${status.tone}`} role="status">
          {status.tone === 'attention' ? <AlertIcon size={14} aria-hidden="true" /> : status.tone === 'success' ? <CheckCircleIcon size={14} aria-hidden="true" /> : <InfoIcon size={14} aria-hidden="true" />}
          {status.label}{status.at && ` / ${age(status.at, now)}`}
        </span>
      </div>
    </div>
    <div className="scan-row">
      <UsageMeter usage={usage} openBudget={openBudget} />
      <SpendingCell spending={spending} now={now} />
    </div>
    <div className="chain-block">
      <div className="chain-heading"><h4>Where usage is charged now</h4><Label variant={chain.status === 'confirmed' ? 'success' : 'attention'}>{chain.verdict}</Label></div>
      <p className="sr-only">{chain.summary}</p>
      <ol className="chain" aria-label="Current attribution path from user to enterprise">{parts}</ol>
      {chain.unresolved.length > 0 && <p className="caption warning"><AlertIcon size={12} aria-hidden="true" /> {chain.unresolved.join(' ')}</p>}
      {chain.lastConfirmed && <p className="caption">Last confirmed {new Date(chain.lastConfirmed.checkedAt).toLocaleString()}: {chain.lastConfirmed.center?.name ?? 'Enterprise only'}. Reference only.</p>}
      {budgets.other.length > 0 && <details className="section-details chain-other"><summary>{budgets.other.length} other candidate budget{budgets.other.length === 1 ? '' : 's'} off this path</summary>
        <Chips items={budgets.other} openBudget={openBudget} />
        <p>From other cost center memberships or organization/repository scopes. Membership does not establish billing assignment.</p>
      </details>}
      <p className="caption">Current assignment, not historical monthly billing. A per-user cap is the user's limit; shared spending budgets are group thresholds, never extra personal allowance, and are not added together.</p>
    </div>
  </section>;
}
