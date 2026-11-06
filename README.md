# GitHub FinOps

A GitHub Copilot app plugin with a React/Primer canvas for enterprise AI Credits
spending, budgets, cost centers, and on-demand user lookups. Data is read through
your locally authenticated GitHub CLI (`gh`) and cached locally in SQLite.
The plugin does not change enterprise settings.

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