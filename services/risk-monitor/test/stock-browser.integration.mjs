// Explicit entrypoint: never silently downgrade a browser check to helper-only tests.
if(!process.env.DOCKYARD_PLAYWRIGHT_MODULE)throw Error('Set DOCKYARD_PLAYWRIGHT_MODULE to an installed Playwright entrypoint');
await import('./stock-services.integration.mjs');
