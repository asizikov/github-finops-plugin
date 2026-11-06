---
name: finops-init
description: Initialize or troubleshoot the GitHub FinOps canvas plugin. Verify GitHub CLI installation, enterprise target, account and credential source, scopes, and live read-only billing and enterprise-team access; guide approved remediation and report ready versus blocked capabilities.
---

# Initialize GitHub FinOps

Use for "set up GitHub FinOps", "initialize the FinOps plugin", missing gh CLI,
authentication failures, or checking whether the canvas can read an enterprise.
This sets up the local CLI-backed plugin, not a hosted service or a new GitHub
App registration/installation. Do not start a separate GitHub App onboarding
flow.

## Safety and scope

- Inspect first. Ask for explicit approval before installing software, starting
  interactive login, refreshing scopes, switching accounts, changing credential
  storage, or removing/replacing environment overrides. A setup request alone
  does not approve every remediation. Keep GitHub authorization prompts under
  the user's control.
- Never print tokens, run `gh auth token` to display a credential, use
  `gh auth status --show-token`, dump the environment, or echo raw sensitive
  auth output. Inspect environment variable presence only. Do not put actual
  enterprise identifiers, usernames, local config, snapshots or credentials in
  tracked files, public reports or screenshots.
- Only REST GET calls and the fixed read-only enterprise-identity GraphQL
  query. GraphQL queries use POST; never send a mutation. Do not change budgets, memberships, roles, enterprise
  settings or app installations. Do not crawl member/team rosters.
- Read-only checks can still consume rate limits. Respect Retry-After/reset
  cooldowns, never retry in a loop, and stop until the deadline when limited.
  Cached/offline data is useful but is not fresh proof of authorization.

## 1. Confirm prerequisites and target

1. Establish the operating system and whether `gh --version` succeeds. The
   installed Copilot runtime must support plugin canvas extensions and native
   Node `node:sqlite`; a working canvas's Settings page confirms its runtime
   can open the local cache. Consumers do not need npm or a frontend dev server.
2. If gh is absent, give official installation guidance:
   [GitHub CLI downloads](https://cli.github.com/) and
   [platform installation instructions](https://github.com/cli/cli#installation).
   Typical choices are `brew install gh` on macOS, `winget install --id
   GitHub.cli --exact` on Windows, or the official distribution-specific
   packages on Linux. Confirm the user's platform/package manager and obtain
   installation permission first; never assume sudo, Homebrew or curl-to-shell
   is appropriate. After an approved installation, rerun `gh --version`.
3. Ask for the intended enterprise URL/slug and host if not already provided.
   For `https://github.com/enterprises/example-enterprise`, use `github.com`
   and `example-enterprise`. For a data-resident `tenant.ghe.com` enterprise,
   keep that exact hostname; do not silently route it to github.com. Pass
   host/enterprise through canvas input, not tracked configuration. Reject
   malformed input; do not guess an account from the current Git remote.

## 2. Verify account and credential source

Use a filtered command such as:

```sh
gh auth status --hostname HOST --json hosts \
  --jq '.hosts[][] | {login,active,state,tokenSource}'
```

Replace `HOST` using a safely passed argument, never shell interpolation of
unvalidated pasted input. Only show account/source/state, not full credentials.
Check the source used by the extension itself in Settings as well: the parent
session and an extension can have different available environment variables.

For github.com and `*.ghe.com`, `GH_TOKEN` takes precedence over `GITHUB_TOKEN`;
for other enterprise hosts, `GH_ENTERPRISE_TOKEN` takes precedence over
`GITHUB_ENTERPRISE_TOKEN`. These override stored gh credentials. An existing
environment token cannot gain permissions in place through `gh auth refresh`.
Explain the options: the user replaces it at its source, or explicitly chooses
to remove the override and use suitable stored credentials. Never remove an
override, persist credentials in plaintext, switch accounts, or broaden scopes
without approval.

If needed and approved, guide `gh auth login --hostname HOST` for stored
credentials. For an approved scope expansion on the intended stored account,
use `gh auth refresh --hostname HOST --scopes read:enterprise`. A refresh does
not fix an active environment override. Do not request `admin:enterprise` or
write permissions as a shortcut. Explain any GitHub SSO authorization and
enterprise-owner/custom-role actions the user must complete. Verify the
intended account/source again after each approved change; never assume an
accepted device code means the whole setup works.

## 3. Check live capabilities

Prefer the plugin's own diagnostics so checks use the same credentials, local
cache and cooldown as the canvas:

1. Discover the `github-finops` canvas and open it with the confirmed
   `{enterprise, host}` input. Inspect its capabilities rather than guessing
   tool signatures.
2. Invoke `connection_status` with `{refresh:false}` to inspect local Settings
   and saved checks without GitHub API calls. Verify version, database
   availability, target and credential source. Saved check timestamps may be
   stale.
3. When the user requests connection verification, invoke `connection_status`
   with `{refresh:true}` once, or use Settings > Check connection. This performs
   explicit read-only probes for authentication, enterprise display identity, billing
   budgets, cost centers, current-month AI usage and the authenticated account's
   enterprise-team membership endpoint. It does not fetch a bulk roster or
   assert access to every user's data.
4. If canvas diagnostics are unavailable, explain that limitation. Equivalent
   targeted `gh api --hostname HOST --method GET` checks can use `/user`,
   `/enterprises/ENTERPRISE/settings/billing/budgets?per_page=1&page=1`,
   `/enterprises/ENTERPRISE/settings/billing/cost-centers`,
   `/enterprises/ENTERPRISE/settings/billing/ai_credit/usage?year=YEAR&month=MONTH`
   using the current UTC billing month, and
   `/enterprises/ENTERPRISE/members/LOGIN/teams?per_page=1&page=1` using the
   verified current login. Use API version `2026-03-10`. Inspect only status,
   sanitized scope metadata and required response shapes; do not print full
   customer billing data. Respect any returned cooldown.
   For display identity, use `gh api graphql --hostname HOST --method POST`
   with `--raw-field 'query=query($slug: String!) { enterprise(slug: $slug) {
   name slug } }'` and `--raw-field 'slug=ENTERPRISE'`, passing arguments safely.
   This is a fixed read-only query, not a mutation. GET `/graphql` returns
   schema introspection rather than executing this identity query.

Interpret results separately:

- Scope headers may be absent, including for non-classic credentials. Unknown
  is not missing, and a listed scope is not proof of enterprise role, SSO or
  endpoint access. Billing requires suitable enterprise billing read access;
  organization-owner visibility can be limited.
- Enterprise-team GET requires the new enterprise teams experience, a classic
  token with `read:enterprise` (or an accepted covering scope), and enterprise
  owner or `enterprise_teams:read` permission. Fine-grained PATs and GitHub App
  tokens are not supported by this endpoint.
- HTTP 401 is rejected authentication; 403 can mean role/scope/policy/SSO
  restrictions or a rate limit; inspect rate metadata first. HTTP 404 can hide
  a resource or unsupported experience and is not proof of no enterprise,
  membership or teams. Empty successful team lists mean only that the checked
  user's response was empty. Empty usage reports do not establish zero spend.
- Enterprise display-name lookup can fail while billing reads succeed.
  Report the configured target separately from the verified capabilities.
  Team membership or cost-center assignment alone is not evidence that a
  particular budget pays for a request or is the effective user limit.

## 4. Verify remediation and report readiness

After each approved installation/auth/SSO/role change, rerun the affected check
once, observing cooldowns. Changes in credential context intentionally isolate
old snapshots. Reopen or refresh the canvas after credential changes; do not
reveal old account data through a new context.

Finish with a concise ready/blocked/unknown capability summary and the remaining
user action. Distinguish "billing ready, team access blocked" from fully ready.
Only mark setup complete after fresh checks verify the requested capabilities
and the canvas loads successfully. If the user skips approval, authorization
fails, or runtime support is missing, stop and say what remains blocked.
Providing installation instructions or displaying a cached snapshot is not
completion.
