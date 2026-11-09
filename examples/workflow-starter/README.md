# Research workflow starter

This MIT teaching example summarizes eight fictional rows using the Python standard library. It is not patient data or a statistical inference example. Python 3.12 is the tested interpreter.

```powershell
python -m unittest discover -s tests -v
python audit_csv.py --data data/demo.csv --output output/summary.json
```

The summary reports record counts, missing values, mean and sample standard deviation by group. Blank values are missing; zero is a value. Duplicate identifiers and non-finite values are rejected. Output creation is exclusive: reruns use a new file or remove only your own previous teaching output.

For the public repository, the GitHub workflow lives at the repository root in `.github/workflows/tutorial-smoke.yml` and runs these commands from `examples/workflow-starter`. The report is uploaded as an Actions artifact. A successful run checks this small example; it does not establish that a research result is correct.
