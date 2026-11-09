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

Further research tools will be released with their own usage boundaries and installation evidence.
