# Research workflow starter

These MIT teaching exercises use the Python standard library: summarize eight fictional rows and perform one small arXiv metadata query. The CSV is not patient data or a statistical inference example. Python 3.12 is the tested interpreter.

```powershell
python -m unittest discover -s tests -v
python audit_csv.py --data data/demo.csv --output output/summary.json
```

The summary reports record counts, missing values, mean and sample standard deviation by group. Blank values are missing; zero is a value. Duplicate identifiers and non-finite values are rejected. Output creation is exclusive: reruns use a new file or remove only your own previous teaching output.

For an optional network exercise, run `python arxiv_once.py --output my-arxiv-run`. It requests at most five records, saves the query, retrieval time, versioned identifiers and raw Atom response, and does not retry automatically. Wait at least three seconds between invocations and follow the arXiv API terms. Metadata discovery does not independently establish peer-review status or support a scientific claim. Do not redistribute paper PDFs without the relevant permission.

For the public repository, the GitHub workflow lives at the repository root in `.github/workflows/tutorial-smoke.yml` and runs the offline tests and CSV summary from `examples/workflow-starter`. The report is uploaded as an Actions artifact. CI does not query arXiv. A successful run checks this small example; it does not establish that a research result is correct.
