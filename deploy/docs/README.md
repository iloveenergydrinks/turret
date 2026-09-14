# Turret documentation service

The documentation is a separate Node service. It does not build or serve the main application.

Prepare a release from the repository root:

```sh
node scripts/gitbook.mjs check
node scripts/package-gitbook.mjs
```

The release directory is `output/turret-docs/release`. It contains only the documentation book, its reader, and deployment configuration. Copy its contents to a temporary directory outside this repository, then upload from that directory. The repository's inherited ignore rules exclude documentation and output directories, so an upload from inside the checkout can omit required files. The included `railway.toml` selects the Dockerfile and checks `/` before accepting the deployment.

Target the dedicated service explicitly from the temporary directory:

```sh
railway up . --path-as-root --detach --json \
  --project edf06c48-4331-4fd1-bf0c-04619089a315 \
  --environment 724dcf3f-d5c3-4507-97ee-8d78ce752e11 \
  --service c84dfa04-dcdd-4494-be48-5ed963672acd \
  --message "Update Turret documentation"
```

Capture the returned deployment ID and wait for that deployment to reach `SUCCESS` before reporting it live. The main application is a different service.

For a local production check:

```sh
cd output/turret-docs/release
npm ci --omit=dev --ignore-scripts
NODE_ENV=production PORT=4176 npm start
```

The service reads Railway's `PORT` and listens on `0.0.0.0` in production. Canonical URLs use `https://docs.turret.capital`; `DOCS_SITE_URL` can override that origin for another deployment. The homepage is `/`; product pages include `/platform/overview`, `/guides/borrow` and `/guides/p2p`. Legacy Markdown URLs redirect permanently to their clean equivalents.

Create the `docs.turret.capital` custom domain on the dedicated Railway service, then use the exact DNS records Railway supplies in Namecheap. DNS records cannot be determined from the source bundle. Verify the HTTPS custom domain after Railway provisions its certificate.

Diagram rendering loads the pinned Mermaid 11.12.0 module from jsDelivr. If that CDN cannot be reached, the page retains the diagram source and displays an explanatory message.

After documentation changes, regenerate the release before deploying it again. Changes to the source book are not automatically copied into an existing release directory.

## Editorial scope

Publish only documentation of the current Turret application: Borrow, Earn, P2P, Portfolio, supported assets, rates and risks. Verify behavior against the deployed frontend and contracts; repository variants are not automatically product features. Keep operational instructions, Solidity inventories, experimental versions and history outside `docs/gitbook`.

The previous repository reference is preserved at `docs/internal/repository-reference-2026-09-07`. It is excluded from the deployment bundle. `node scripts/gitbook.mjs inventory` updates that internal research, and `node scripts/gitbook.mjs check-inventory` checks its fingerprints separately from public documentation.
