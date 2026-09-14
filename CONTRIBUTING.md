# Contributing to Turret

Start with the root README and the README of the component you want to change. Use a feature branch and open a pull request describing the problem, the resulting behavior and how it was verified.

- Keep changes focused. Include a regression test when fixing transaction, accounting or wallet-state behavior.
- For Solidity changes, preserve storage layout and deployed interfaces unless the change explicitly includes a reviewed migration plan.
- Never bypass account, network, amount, quote-expiry, pending-transaction or receipt checks to make a wallet button clickable.
- Run relevant unit tests and identify any integration tests that need external infrastructure.
- Include public configuration examples. Do not commit `.env` files, private keys, seed phrases, service credentials, databases, signed transactions or production signing pages.
- Keep contract license identifiers and upstream copyright notices intact.

Use local test accounts only. Deployment, contract administration and moving funds require separate operational authorization.

Report vulnerabilities privately as described in `SECURITY.md`.
