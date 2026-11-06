# GitHub FinOps

A GitHub Copilot app plugin with a React/Primer canvas for enterprise AI Credits
spending, budgets, cost centers, and on-demand user lookups. Data is read through
your locally authenticated GitHub CLI (`gh`) and cached locally in SQLite.
The plugin does not change enterprise settings.

Users includes **AI spending attribution**: current direct user assignment
(membership plus explicit user resource), otherwise the oldest qualifying enterprise
team, otherwise a sole confirmed Copilot license organization. Missing access,
incomplete evidence, tied/missing team creation dates, or multiple license
organizations leave the result unresolved rather than assuming Enterprise Only.
This follows [GitHub's cost center allocation rules](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/cost-center-allocation);
it is not historical monthly allocation or effective per-user budget selection.

Evidence is collected only for an explicit user lookup/refresh and saved with
timestamps in the existing account/host/enterprise-scoped SQLite snapshot.
Warm views make no additional API requests. Refreshing cost center or team
configuration marks saved attribution provisional/unresolved until that user is
refreshed; failed checks retain the last confirmed result separately, never as
a current winner. Cache clear removes both results and evidence.
Copilot fallback reads the paginated enterprise seats endpoint only when needed,
retaining only the requested user's organization candidates, not other users'
seat data. That endpoint accepts existing `read:enterprise` **or**
`manage_billing:copilot`; the plugin never changes authentication or requests
broader permissions automatically. Multiple seat-granting organizations do not
identify the charged organization; use a detailed usage report for that case.

## Install

Requires a Copilot app/runtime with canvas extension support and `gh` with
enterprise billing read access.

Add the marketplace first, then install the plugin. Confirm each action in the app.

[![Add marketplace](https://img.shields.io/badge/Add-marketplace-0969da?logo=github)](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Fmarketplace%2Fadd%3Fsource%3Dasizikov%252Fgithub-finops-plugin)
[![Install to Copilot app](https://img.shields.io/badge/Install%20to-Copilot%20app-24292f?logo=github)](https://github.com/copilot/app/launch?open=ghapp%3A%2F%2Fplugins%2Finstall%3Fsource%3Dgithub-finops-plugin%2540github-finops)

Or use Copilot CLI:

```sh
copilot plugin marketplace add asizikov/github-finops-plugin
copilot plugin install github-finops-plugin@github-finops
```

After installation, ask Copilot to run `github-finops-plugin:finops-init` to
verify prerequisites, authentication, and API access.

[Setup and development](docs/SETUP.md) | [MIT license](LICENSE)