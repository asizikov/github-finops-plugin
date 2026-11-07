import {useState} from 'react';
import {Button, Flash} from '@primer/react';
import {useSnapshot, SnapshotStatus, RefreshButton} from './Snapshot';
import {TeamLink} from './ResourceLinks';
import type {EnterpriseTeamsData, Membership} from './user-format.mjs';

function TeamCostCenters({slug, openCenter}: {slug: string; openCenter: (id: string) => void}) {
  const state = useSnapshot<{slug: string; memberships: Membership[]}>(`team-cost-centers/${encodeURIComponent(slug)}`);
  const memberships = state.snapshot?.data.memberships;
  return <section aria-label={`Cost centers for ${slug}`}>
    <div className="user-result-heading"><h4>Team cost center memberships</h4><RefreshButton state={state} /></div>
    <SnapshotStatus state={state} />
    {memberships && (memberships.length ? <div className="user-memberships">{memberships.map(center =>
      <button key={center.id} className="row-link" type="button" onClick={() => openCenter(center.id)}>{center.name}</button>)}</div> :
      <p className="empty-results">No cost center memberships returned for this team.</p>)}
  </section>;
}

export default function EnterpriseTeams({data, cached, disabled, refresh, openCenter}: {
  data: EnterpriseTeamsData | undefined; cached: boolean; disabled: boolean; refresh: () => void;
  openCenter: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  return <section className="resource-section" aria-labelledby="enterprise-teams-title">
    <h3 id="enterprise-teams-title">Enterprise teams</h3>
    <p className="section-intro">Team membership does not select an effective user budget or prove which cost center pays for a request.</p>
    {!data && <><p>Enterprise teams are not loaded in this saved lookup.</p><Button disabled={disabled} onClick={refresh}>Load enterprise teams</Button></>}
    {data?.error && <div className="error" role="alert"><Flash variant="danger">{data.error}</Flash></div>}
    {data?.fetchedAt && <p className="caption">Teams last read {new Date(data.fetchedAt).toLocaleString()}.{(cached || data.error) && ' Saved team membership may be stale.'}</p>}
    {data?.items && (data.items.length ? <div className="user-memberships">{data.items.map(team =>
      <div className="team-item" key={team.id}>
        <h4><TeamLink htmlUrl={team.htmlUrl}>{team.name}</TeamLink></h4>
        <p className="caption">{team.slug} / Team ID {team.id}</p>
        <Button size="small" onClick={() => setSelected(selected === team.slug ? null : team.slug)} aria-expanded={selected === team.slug}>
          {selected === team.slug ? 'Hide cost centers' : 'View cost centers'}
        </Button>
        {selected === team.slug && <TeamCostCenters slug={team.slug} openCenter={openCenter} />}
      </div>)}</div> : <p className="empty-results">No enterprise teams returned in the last successful read.</p>)}
    {data?.items === null && <Button disabled={disabled} onClick={refresh}>Retry enterprise teams</Button>}
    <details className="section-details"><summary>Enterprise team access requirements</summary>
      <p>Requires the new enterprise teams experience, a classic token with read:enterprise, and enterprise owner or enterprise_teams:read permission. Fine-grained tokens and GitHub App tokens are not supported by this endpoint.</p>
    </details>
  </section>;
}
