# GitHub FinOps

A GitHub Copilot app plugin with a React/Primer canvas for enterprise AI Credits
spending, budgets, cost centers, and on-demand user lookups. Data is read through
your locally authenticated GitHub CLI (`gh`) and cached locally in SQLite.
The plugin does not change enterprise settings.

## Get started

Requires a Copilot app/runtime with canvas extension support and `gh` with
enterprise billing read access. Follow [local setup](docs/SETUP.md), then ask
Copilot to run `github-finops-plugin:finops-init` to verify prerequisites,
authentication, and API access.

One-click app installation is not configured for this repository yet: the
[documented app install flow](https://docs.github.com/en/copilot/how-tos/github-copilot-app/open-with-deep-links#plugin-parameters)
requires a plugin in a registered marketplace.

[Setup and development](docs/SETUP.md) | [MIT license](LICENSE)