# Medical research workflows

MIT software and reproducible teaching examples by XTSgreen. The repository is under development. It contains no patient data, paid course materials or publication claims.

## Workflow starter

The first example uses eight fictional rows to demonstrate CSV checks, missing values, descriptive summaries and GitHub Actions artifacts.

```sh
cd examples/workflow-starter
python -m unittest discover -s tests -v
python audit_csv.py --data data/demo.csv --output output/summary.json
```

The workflow at `.github/workflows/tutorial-smoke.yml` uses Python 3.12 on a GitHub-hosted Ubuntu runner. A passing run validates this example only.

## Research software preview

Four MIT dsh plugins and the separate Med-Lab Mini source are now included. This repository remains under development; model quality, UI checks and npm publication are separate pending gates.

| Tool | Source and usage |
| :-- | :-- |
| Literature radar | [packages/literature-radar](packages/literature-radar/README.md) |
| Paper autopsy | [packages/paper-autopsy](packages/paper-autopsy/README.md) |
| Review copilot | [packages/review-copilot](packages/review-copilot/README.md) |
| Clinic writer | [packages/clinic-writer](packages/clinic-writer/README.md) |
| Med-Lab Mini | [packages/med-lab-mini](packages/med-lab-mini/README.md) |

Use Node >=24.9.0 (tested 24.16.0) for the four plugin packages. Run from the repository root:

```sh
npm ci --ignore-scripts
npm run check:prompts
npm test
npm run check:packages
```

Archives are produced in artifacts/packages and can be installed into a new directory with npm. npm publication is not yet available; do not assume a package-name download works. For dsh, install a bundle archive using the plugin manager and restart the same profile when requested. Only dsh 0.2.2-rc.1 is currently declared compatible.

Med-Lab Mini uses a separate Python >=3.11 environment:

```sh
python -m pip install -e "packages/med-lab-mini[test]"
python -m pytest packages/med-lab-mini/tests
```

The five P1-26 through P1-30 basic prompts are included under MIT, with their public source in content/review-basic-prompts.json. Paid examples and advanced materials are excluded. See [validation scope](docs/VALIDATION.md) and [release notes](docs/RELEASE-NOTES.md) before using generated research drafts.
