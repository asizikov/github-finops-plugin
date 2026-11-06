# Local setup

The canvas requires a current Copilot runtime with canvas extensions and GitHub
CLI (`gh`) on PATH, authenticated to the target host with enterprise billing read
access. REST reads use GET; enterprise display-name lookup uses one fixed
read-only GraphQL query via POST (never a mutation). Tokens are never sent to
the iframe.

Load this directory as a local plugin with `copilot --plugin-dir .`. Open the
`github-finops` canvas without input for the Connect your enterprise page, or
provide an `enterprise` slug and optional `host` hostname (default: `github.com`).
Without a saved overview for the active account, Check connection performs
deliberate read-only probes before Load overview. Enterprise teams are optional.
The confirmed target is remembered in user-local `target.json` beside the cache;
opening a cold canvas does not create the SQLite database. Valid saved overviews,
including empty results, open without live checks. Enterprise identifiers belong
in canvas input or user-local configuration, never tracked files.

Renderer assets are bundled inside the extension for distribution; consumers do
not need npm or a frontend server. After editing the UI, run:

```sh
npm ci
npm run check
npm test
npm run build
```

Include the updated `extensions/github-finops/assets/` files when distributing
the plugin, then reload extensions. Do not install the Copilot SDK as a package:
the runtime resolves it automatically.

The overview summary cards read the enterprise AI Credits budget and
enterprise-wide default per-user budget. Missing consumption is unavailable,
not zero; the separate cached attention queue can include other budget scopes.

Current spending uses the enterprise AI-credit usage report with an explicit
UTC current year/month and no cost-center, organization, user, model, or product
filters. The overview includes allocated and unallocated AI-credit usage across
products. Gross usage value, included usage/discounts, and net billed spending
are summed from the API's USD amount fields without rounding individual rows.
Net spending is not the budget's `consumed_amount` or a finalized invoice.
An empty report is unavailable, not assumed to be zero; failed spending reads
show an error while leaving successfully read budgets visible.

API fields and filters: [Billing usage](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/usage).
Amount interpretation: [Automating usage reporting](https://docs.github.com/en/enterprise-cloud@latest/billing/tutorials/automate-usage-reporting#step-5-interpret-usage-and-cost-fields-in-the-api-response).

## Local snapshot cache

The extension requires a Node runtime with native `node:sqlite` (verified with
the Copilot extension runtime on Node 24). Snapshots persist in
`$COPILOT_HOME/extensions/github-finops/artifacts/cache.sqlite`, with
`COPILOT_HOME` defaulting to `~/.copilot`. `GITHUB_FINOPS_CACHE_DIR` can select a
different user-local cache directory; keep it outside the repository and session
artifacts. Database files and their WAL/SHM companions are ignored by Git.

Warm opens read SQLite without calling GitHub. A cache miss fetches live data;
Refresh explicitly requests live data. Cache keys isolate hostname, enterprise,
active credential context and UTC billing month. The context is an irreversible
digest obtained via the local-only `gh auth token` command. Tokens are never
stored, logged, or sent to the iframe. Account changes or credential rotations
produce a separate cache context.

Cached data can be stale: age and last successful read times are displayed.
Failed refreshes retain successful snapshots; failed spending reads do not
replace previously successful spending. GitHub rate-limit reset and Retry-After
deadlines are persisted per host/access context; a rate-limit response without a
deadline pauses requests for 60 seconds. There are no automatic retries.
SQLite errors are surfaced, not bypassed with uncached reads.

Settings > Local cache lists recognized snapshot groups, their successful read
times, refresh errors, current refresh activity and any shared GitHub cooldown.
Reload status is local; Refresh overview deliberately refreshes only the overview.
Clear this cache requires confirmation for the current host, enterprise and
credential context. It transactionally removes recognized snapshots and derived
links, retains other contexts, credentials, the configured target and cooldown,
and returns to onboarding. In-flight requests cannot restore cleared snapshots.
Older unclassified rows cannot be selectively deleted; a durable generation
change invalidates them for this context without deleting another account's data.

Offline cache reads cannot check remotely revoked permissions or changed access
for an unchanged credential. Refresh is required to recheck GitHub access.

## Cost centers

The sidebar includes Overview, Cost Centers, Budgets, and Users.
All page headers stay at the top, including empty and loading states.
Cost center search covers the full loaded list by name, ID, and state;
visible list pages contain at most 25 rows. Selecting a name or row opens
read-only configuration and all assigned resources. The detail API's resource
pages are fetched until `has_next_page` is false.

The Type / scope column shows all distinct assigned resource types, including
mixed assignments, using the list endpoint's returned resources without extra
detail requests. Empty assignments are explicit; unavailable or explicitly
partial assignments are not classified as a complete scope.

Lists and details use the same local SQLite storage, credential/host/enterprise
isolation, explicit refresh, error retention, and shared rate-limit cooldown.
Configuration snapshots are keyed by resource/ID rather than billing month.
Missing pool state or Azure subscription fields are labeled as not returned.
The pool-enabled flag is a **cost-center pool cap**, not a statement that AI
credits are entirely unavailable when the flag is false.

Configuration fields: [Cost center API](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/cost-centers).

## Budgets

The Budgets page reads all accessible enterprise budgets across scopes and
products, fetching every list page without a scope filter. Search covers the
full list by product/SKU, pricing type, scope, entity, expiration, or ID.
Visible pages contain at most 25 rows. Selecting a product opens its read-only
configuration, reported consumption, alerts, enforcement, and optional expiration.
Back navigation preserves the search and page.

Lists and details use the same persistent SQLite caching and manual refresh as
cost centers, with independent resource/ID keys and shared rate-limit cooldown.
Budget keys also include the UTC billing month so consumption cannot carry over
silently into a new month's first open.
List consumption is shown only when returned; selecting a budget reads its
detail endpoint without fetching details for every list row. Missing consumption
is unavailable, never zero or an aggregate of member usage.

Known monetary products/SKUs use USD; documented license products/SKUs use
license counts. Unknown or ambiguous product units are explicitly unavailable,
not assumed to be dollars. Raw product/SKU and pricing identifiers remain visible.
Budgets overlap and must not be summed; tracked consumption is not an invoice.

The Overview attention queue evaluates cached budgets only; it never fetches a
list, every detail or users in the background. It flags known consumption at or
above 90%, exhausted/over-threshold controls, exceeded alert-only thresholds and
user overrides expiring within seven UTC calendar days. Zero limits are handled
without division; unknown units or consumption do not imply risk or zero use.
Scope/product filters and detail links retain the ordinary navigation history.
Coverage and saved read times stay visible; an empty queue is not an all-clear
for budgets or users that have not been loaded.

References: [Budget API](https://docs.github.com/en/enterprise-cloud@latest/rest/billing/budgets),
[Product and SKU names](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/product-and-sku-names).

## Cost center and budget relationships

SQLite tracks budget-to-cost-center links alongside successful snapshots in one
transaction, isolated by host, enterprise, and credential context. Only
`cost_center` and `multi_user_cost_center` budget scopes participate; aggregate
spending budgets and per-user defaults remain distinct, including multiple
products for one center.

An entity matching a cost center ID links directly. Some API responses instead
return display names: those are resolved only by an exact, case-sensitive,
unique name in a complete saved cost center list. Name-resolved links are
labeled as derived associations, not API-supplied foreign keys. Duplicate names,
unmatched entities, and unloaded lists remain explicitly unresolved. No fuzzy
matching or automatic API calls are used just to resolve a relationship.

Existing local snapshots are indexed on warm reads without calling GitHub.
Fresh complete lists and newer details reconcile removals, renames, and budget
reassignments; failed refreshes retain the last successful relationships.
Saved links show their provenance and age and may be stale. Missing saved links
do not establish that no related budgets exist.

Cost center details link to related budgets; budget lists and details link back
to resolved cost centers. In-app back navigation preserves the originating
detail view and each list's search and page.

## User lookup

Users accepts a single GitHub username (whitespace and one leading `@` are
removed; login matching is case-insensitive). Search explicitly resolves the
account, reads user resource memberships and all pages of user-filtered budgets,
and saves the result. It does not fetch a bulk roster or the complete budget
list. Warm searches use SQLite without GitHub requests. Refresh is explicit;
failed refreshes retain the last successful lookup. Keys include the normalized
username, host, enterprise, credential context, and UTC billing month.

Membership links use API-supplied cost center UUIDs. The user-filtered budget
response must echo the requested user before its `effective_budget` is trusted.
Only a matching AI Credits per-user control is marked effective; lower-priority
defaults returned for that user are labeled overridden. The explanation groups
the effective limit, user-specific consumption/remaining, selection evidence and
reported expiration without adding overridden defaults. Missing or inconsistent
effective configuration is unknown, not zero or unlimited. Detail endpoints can
enrich missing effective configuration but their unfiltered consumption is never
substituted for user-specific consumption.

Aggregate spending guardrails and additional defaults come from already saved
configuration, without automatic list fetches. Exact-unique-name relationship
provenance remains visible. Cost center membership does not prove which
organization pays for usage, so membership-associated cost center and enterprise
guardrails are candidates with unknown applicability. Unresolved organization,
repository, policy, and pool context stays explicit; unrelated enterprise
budgets are not presented as controls on this user. Consumption and headroom
are budget-tracked USD, not net billed spending or an authorization decision.
Shared spending budgets are monthly metered thresholds for the whole enterprise
or cost center, not personal allowances. Included credits are separate, and
alert-only budgets do not stop spending.

### Enterprise teams

User lookups also read every page of the user's enterprise teams (100 per
request). This endpoint requires the new enterprise teams experience, a classic
token with `read:enterprise`, and enterprise owner or `enterprise_teams:read`
permission. It does not support fine-grained PATs or GitHub App tokens. The
plugin never changes authentication or requests broader scopes automatically.
403/404 responses remain access-denied/unavailable, not empty membership.

Team failures leave working user billing data visible and preserve the last
successful team list and its own read timestamp. Older saved user lookups show
teams as not loaded until an explicit refresh; warm searches never fetch just
to fill the new field. Team results share the user's isolated persistent cache.
View cost centers loads only the selected team's resource memberships, cached
separately by team slug, host, enterprise, and credential context, with explicit
refresh and shared cooldown. Only one team lookup panel is open at a time; no
per-team fanout or roster crawl runs automatically. Returned center UUIDs link
to configuration, without treating team assignment as effective-budget evidence.

Reference: [Enterprise team memberships](https://docs.github.com/en/enterprise-cloud@latest/rest/enterprise-teams/enterprise-team-members#list-enterprise-teams-for-a-user).

## Settings and versions

The black header and navigation stay stationary; only page content scrolls.
Settings is always the last navigation entry. It displays the actual resolved
SQLite file location; Open reveals that file on macOS/Windows or opens its parent
folder on Linux. Only this backend-selected cache location can be opened.
Unsupported systems and file-manager errors are reported explicitly.

Root `VERSION` is the authoritative installed/published Semantic Versioning file.
Use `npm version patch --no-git-tag-version` (or `minor`/`major` as
appropriate) to update it: the version hook synchronizes `VERSION` and
`plugin.json` with npm's package/lock versions. Do not edit the copies separately.
Builds reject mismatched versions. Commit all version files and rebuilt assets
together when publishing to `main`; no release bump is needed for local development.
Settings reads the local `VERSION` at runtime, plus the checkout's short Git revision and
working-tree state when available. Distributed copies without their own Git
repository show no development revision; builds do not embed a precommit hash.

### Updating the plugin

The canvas checks the public repository's
[`main/VERSION`](https://raw.githubusercontent.com/asizikov/github-finops-plugin/main/VERSION)
on open and every 24 hours while open. Checks are backend-only, unauthenticated,
limited to 5 seconds and 200 bytes, and never send enterprise data or credentials.
Successful and failed attempts are cached for 24 hours in user-local
`$COPILOT_HOME/extensions/github-finops/artifacts/updates.json` (default
`~/.copilot`), separate from billing/authentication caches. Settings shows the
last successful public check or a nonblocking error; offline/invalid responses
never imply up-to-date. Only a strictly newer SemVer offers a bottom-right,
nonmodal reminder. Dismissal is saved for that exact version across restarts;
a later newer version can appear. Closing the canvas clears its check timer.

**How to update:** for a CLI-managed installation, run the documented
[`copilot plugin update`](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
command:

```sh
copilot plugin update github-finops-plugin@github-finops
```

Reopen the canvas after updating and verify its installed version in Settings.
For a Copilot desktop-managed installation, open **Customize > Installed** and
find **github-finops-plugin** in the **github-finops** marketplace; use the update
action if your app offers it. Desktop update availability depends on your app
version. No desktop update deep link or automatic upgrade is assumed: the
reminder opens these instructions, never an installer, and does not change files.
The [installation links](../README.md#install) remain explicit confirmation flows,
not guaranteed upgrades. Local development copies must be updated by their owner.

### Connection checks

Opening Settings does not query GitHub. Check connection explicitly checks
authentication, configured enterprise identity, billing budgets, cost centers,
current-month AI usage and the authenticated account's enterprise-team endpoint.
It is a capability probe, not a bulk roster or full data refresh. Saved checks
are isolated by host, enterprise and credential context, with timestamps and the
shared rate-limit cooldown. Failed checks remain distinct from successful empty
responses, preserve last verified identity/access timestamps, and never imply
zero spending or absent membership. The configured slug is not a verified
enterprise connection; each endpoint can have different permissions.

Reported OAuth scopes are sanitized metadata only, not tokens. Scope presence
does not prove role/SSO/policy access, and absent scope headers remain unknown.
Environment-token overrides are identified locally and cannot be elevated in
place: replace them at their source or deliberately use authorized stored gh
credentials. Settings never changes authentication. These checks cover the
read endpoints, not all users' visibility or write capabilities.

The distributable `finops-init` skill guides prerequisite checks, safe CLI
installation/authentication remediation, and fresh capability verification.
Ask Copilot to initialize GitHub FinOps (or invoke the plugin-qualified skill
name shown by the client). It reuses the canvas `connection_status` action:
`refresh:false` reads saved Settings; `refresh:true` deliberately probes GitHub.
Installation, login, account/scope changes and environment-token replacement
remain explicit user decisions; the skill does not install a new GitHub App.
