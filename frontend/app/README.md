# Turret frontend

Next.js frontend for USDG pool lending, P2P token and NFT loans, portfolio and rewards.

Start with the [repository setup](../../README.md#local-development). Use the public `.env.example` and configure your own WalletConnect project before testing wallet connections.

```sh
pnpm build:mvp
pnpm test:unit
pnpm test:server
```

The production TypeScript configuration checks application source; preview tools and test files run through their own commands. Tests use public environment defaults and do not load operator credentials.

The [inherited frontend reference](../../docs/legacy/frontend-reference.md) documents the older BOLD subsystem. Its Ethereum deployment configuration is not the Turret production configuration.

License: [MIT](LICENSE). See the root [licensing notes](../../LICENSING.md) for the other components.
