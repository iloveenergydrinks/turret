# Wallet profiles

Private, single-instance service storing shared wallet avatar choices. Reads never require wallet ownership; updates require a fresh signature authorizing one exact avatar change. The frontend proxy still enforces the site's password gate. No wallet key is loaded and the service never submits a blockchain transaction.

## Public avatar format

`{ "kind": "generated", "version": 1, "seed": "64 lowercase hex characters", "palette": 0 }`

`palette` is an integer from 0 through 7. `shared/wallet-avatar.mjs` exports `defaultWalletAvatar(address)`, `validateWalletAvatar(value)`, `renderWalletAvatar(avatar, {size: 128})`, `normalizeWalletAddress(address)`, and `WALLET_AVATAR_PALETTES`. The default is deterministic for every viewer. A shuffled avatar uses a fresh 32-byte seed. The renderer produces only fixed SVG shapes and allowlisted colors.

Uploaded photos use `{ "kind": "image", "version": 1, "hash": "64 lowercase SHA-256 hex characters" }`. The browser converts a chosen photo to a 256×256 PNG, center-cropped with metadata removed, and hashes those exact bytes. The server accepts only 8-bit RGB/RGBA, non-interlaced PNGs up to 300 KiB. It checks chunk layout and CRCs, exact bounded decompression, trailing data, and pixel decoding with pinned pngjs. Only basic color/density ancillary chunks are accepted; EXIF, text, compressed profiles, animation, external URLs, HTML and SVG uploads are rejected. Photo avatars use the PNG endpoint, not `renderWalletAvatar`.

## Frontend proxy contract

All `/profiles/*` requests require `Authorization: Bearer <PROFILE_PROXY_TOKEN>` and `X-Profile-Client-IP` containing the frontend's trusted client IP. The token must never enter browser code. POST requests additionally require `X-Profile-Origin: https://turret.capital`. The frontend must reject cross-origin browser mutations before forwarding and must overwrite, not forward, these authentication/metadata headers. No CORS is enabled on the private service.

- `GET /profiles/:address` → `{address, avatar, revision, updatedAt}`. Address is lowercase; default revision is zero and `updatedAt` is null. Saved timestamps are Unix milliseconds.
- `POST /profiles/challenge` with `{address, avatar, expectedRevision}` → `{nonce, message}`. New image avatars additionally require `image`, the raw canonical base64 PNG without a data-URL prefix. If that exact image hash is already stored, image bytes can be omitted.
- Ask the connected wallet to sign the exact returned UTF-8 `message` using its message-signing API. This is not an approval or transaction. Do not alter it.
- `POST /profiles/save` with `{nonce, signature}` → the saved profile. The server uses the avatar and revision from the stored challenge, not from save input.
- `GET /profiles/avatar/:hash.png` returns the exact validated image with `image/png`, `nosniff`, and immutable content-addressed caching. The frontend password gate must override caching to private while access is restricted.
- `GET /healthz` is the only token-free endpoint, returning only `{ok:true}` after a database read.

The SIWE message is restricted to chain 4663, the configured origin, a five-minute nonce, the exact canonical avatar SHA-256 and expected profile revision. SQLite atomically verifies the revision, saves the profile, and removes outstanding nonces for that wallet. Signatures are not stored. Rejected signatures consume their nonce; temporary RPC failures can be retried before expiry. Signature checks use pinned viem's public-client verification with bounded read-only RPC and fail closed on network errors, including its ECDSA fallback path.

Pending image bytes live only in expiring challenges, capped at 32 MiB globally and 5,000 pending challenges. Only a successful signed save adds an image to durable public storage. Durable image blobs are capped at 256 MiB total by default (`PROFILE_MAX_IMAGE_BYTES`, maximum 4 GiB). Previously published hashes remain available; this first version does not garbage-collect historical image blobs. When the cap is reached, a new photo returns a clear 429 without changing the current profile; existing-hash reuse and generated avatar saves still work. Operational storage monitoring and volume backups remain necessary. The JSON request cap is 420,000 bytes for challenges and 12,288 bytes for saves. Four signature verifications can run at once.

The service stores at most 100,000 wallet profiles by default (`PROFILE_MAX_PROFILES`, maximum 1,000,000). The cap is checked before creating new-wallet challenges and again atomically on save. At capacity, new wallets receive a clear 429; existing wallets can still change their picture. Public reads never create a stored profile row.

HTTP errors: 400 invalid input, 401 missing proxy authentication/wrong signature, 403 wrong origin, 404 unknown route, 409 expired/replayed/stale update, 413 oversized body, 415 wrong content type, 429 rate/concurrency limit, 503 temporary storage/RPC failure. Clients should keep the previous avatar until save succeeds and fall back to the deterministic avatar if profile reads fail. A 409 should refresh the profile before requesting a new challenge.

## Production operation

The profile service runs in the dedicated `turret-profiles` Railway project because the lending project reached its volume quota. Its public Railway HTTPS endpoint requires the server-only bearer token for every profile and image route; only `/healthz` is unauthenticated. Browsers use the password-protected frontend proxy. Existing lending services and volumes are separate.

The source Dockerfile is `services/wallet-profiles/Dockerfile`. Set `RAILWAY_DOCKERFILE_PATH` to that path; the current Railway CLI does not apply the legacy `railway.toml` during an upload. Configure the Dockerfile path, `/healthz` check (60 seconds), one replica and failure restart policy on the service itself. The scoped preparation and verification scripts are in `output/platform-loading-profiles/frontend-integration/`.

The service needs `PROFILE_PROXY_TOKEN`, `PROFILE_APP_ORIGIN=https://turret.capital` and `PORT=3031`. The production Docker image supplies `NODE_ENV=production`; the SQLite database is `/data/wallet-profiles.sqlite` on its own persistent volume. Daily Railway volume backups are enabled. The frontend receives the same private token, `PROFILE_SERVICE_URL` and `PROFILE_APP_ORIGIN`; none belong in `NEXT_PUBLIC_*` or browser assets.

For release verification, check authenticated and unauthenticated HTTPS requests, exact runtime source hashes, an avatar-only signature from an unfunded test wallet, and the saved revision after an observed service-process restart. Preserve the original volume during recovery. A restored profile backup can roll back avatar changes, but it never authorizes a loan.

Local checks: `pnpm --dir services/wallet-profiles install --ignore-workspace --frozen-lockfile --ignore-scripts`, then `pnpm --dir services/wallet-profiles test`. Tests use temporary databases and synthetic test-wallet keys only. Contract-wallet verification tests must run only against an isolated localhost Anvil chain 31337.
