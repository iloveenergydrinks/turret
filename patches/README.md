# ConnectKit 1.9.1

`connectkit@1.9.1.patch` adds an optional `disableEns` provider setting. Dockyard
enables it outside Ethereum mainnet. The unpatched package creates its own
mainnet RPC client and queries ENS from its custom account button, wallet profile
and avatar, even when the application supports only Robinhood Chain. Its default
Ethereum endpoint returned responses without CORS permission.

The patch disables all six optional ENS queries through their existing query
options. It preserves hook ordering, wallet connection, account display and the
default ENS behavior when the option is absent. It is installed through pnpm's
`patchedDependencies`; do not edit `node_modules` directly. Recheck all ENS call
sites and the connected-wallet browser regression when upgrading ConnectKit.
