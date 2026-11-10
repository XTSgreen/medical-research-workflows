# Validation scope

This is a development preview. The local baseline is Windows, Node 24.16.0 and dsh 0.2.2-rc.1. The four Node packages declare Node >=24.9.0 and only the tested dsh version. Med-Lab Mini requires Python >=3.11; numerical tests have run locally on 3.11 and 3.12.

The Node suite contains 66 checks covering parsing, missing evidence, state changes, cancellation, persistent files, fictional PDFs and loopback model protocols. The loopback endpoint returns prewritten fixture answers; it does not test a commercial model. The Python suite contains 23 checks, including independent numerical references and approval invalidation.

The package check packs and installs all four archives in a new directory, executes the CLIs and fictional examples, and confirms that the P1 context is read-only. It does not launch dsh or query literature services. The hosted matrix runs these deterministic checks on Windows and Linux; the actual workflow result is authoritative for each platform.

Separate local dsh checks installed the exact archives through the plugin manager, restarted the profile, compared installed package files and executed the tools. X1 has six tools, X2 six, X3 six and X4 eight, totalling 26 corresponding tools. Their versions are respectively 0.1.5, 0.1.3, 0.1.4 and 0.1.4. Model quality and graphical-interface validation are separate from these SDK checks.

Real arXiv and bioRxiv requests, DOI-list deduplication, Crossref metadata checks and three-process radar lifecycle checks have been recorded locally. PubMed deployment still needs a real contact email. No hosted unit-test success is used as evidence that an external API, a real model, the UI or a research conclusion works.

All included research inputs are fictional teaching material. No patient data, private manuscript, paid prompt collection or external paper PDF is distributed. Five explicitly MIT-licensed P1 basic templates are available in `content/review-basic-prompts.json`; this public source is sufficient to rebuild and test the review package without the paid collection.

The isolated Web host has also rendered the real application in a fresh Chrome profile. It reached model login/API-key onboarding; no credentials were entered and the plugin inventory was not viewed. This is partial startup evidence, not completed plugin UI validation.
