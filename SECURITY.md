# Security reporting

Report vulnerabilities privately to **support@turret.capital**. Include the affected component or contract address, the source revision, a description of the issue, and reproduction steps or a minimal proof of concept.

Do not include private keys, seed phrases or unrelated personal data. Do not open a public issue containing an exploitable vulnerability before coordinated disclosure.

Turret is in open beta. Public source availability is not an audit claim or a guarantee that every included contract is deployed. Verify deployment manifests and bytecode before relying on a contract.

## Credentials and tests

Local environment files, operator data, signed transaction journals and release signing pages must stay outside Git. Some inherited Hardhat fixtures contain publicly known test keys; they are only for isolated local chains and must never hold real funds.

Workers should use observation mode for development. Tests and pull requests must not submit production transactions.
