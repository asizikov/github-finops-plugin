# GitHub FinOps

A GitHub Copilot app plugin with a React/Primer canvas for enterprise AI Credits
spending, budgets, cost centers, and on-demand user lookups. Data is read through
your locally authenticated GitHub CLI (`gh`) and cached locally in SQLite.
The plugin does not change enterprise settings.

## Manual installation (Copilot CLI)

Requires a Copilot app/runtime with canvas extension support and `gh` with
enterprise billing read access. Install from this repository using Copilot CLI:

```sh
copilot plugin install asizikov/github-finops-plugin
```

After installation, ask Copilot to run `github-finops-plugin:finops-init` to
verify prerequisites, authentication, and API access.

[Setup and development](docs/SETUP.md) | [MIT license](LICENSE)