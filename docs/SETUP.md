# Local setup

The canvas requires a current Copilot runtime with canvas extensions and GitHub
CLI (`gh`) on PATH, authenticated to the target host with enterprise billing read
access. It only makes GET requests; tokens are never sent to the iframe.

Load this directory as a local plugin with `copilot --plugin-dir .`. Open the
`github-finops` canvas with input containing an `enterprise` slug and optional
`host` hostname (default: `github.com`). Enterprise identifiers belong in canvas
input, not tracked files. The overview intentionally does not display the slug.

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

The canvas reads the enterprise AI Credits budget and enterprise-wide default
per-user budget. Missing consumption is unavailable, not zero. Cost center
budgets and individual overrides are outside the overview's scope.

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
defaults returned for that user are labeled overridden. Missing or inconsistent
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
