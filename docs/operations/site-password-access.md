# Website password access

The user requested a password-protected website with a “Coming soon” page. The frontend server gates the main site, blog, direct HTML/React payloads, public article documents, app bundles and the frontend RPC proxy before routing. Only the logo and display font needed by the holding page are public. Robots responses disallow indexing.

The holding page uses the existing Turret logo, warm paper palette and Libre Caslon Text. The form accepts a shared password and returns visitors to the requested page. Incorrect passwords have an inline error. Successful authentication sets an eight-hour signed, HttpOnly, Secure, SameSite=Lax cookie shared by `turret.capital` and its subdomains. The provider domain uses a host-only cookie. Authenticated responses use private/no-store caching.

The server stores a salted scrypt password hash and a separate session signing key in private Railway variables:

- `TURRET_SITE_GATE=1`
- `TURRET_SITE_PASSWORD_HASH`
- `TURRET_SITE_SESSION_KEY`

An enabled gate refuses to start with missing or malformed credentials. Login verification uses constant-time comparisons and bounded scrypt concurrency; password attempts are limited per running instance. Cross-origin login forms and unsafe return URLs are rejected. Password rotation invalidates existing sessions because their signature includes the configured password hash.

The generated password and credential material are outside the repository in a private directory. `output/site-password-gate/credential-paths.json` records their local paths without containing credentials. Never add these private files to a deployment archive. The plaintext password is not shipped to the server or browser; the hash and signing key are supplied through private runtime configuration.

To change the password, generate a new salted hash with `hashSitePassword` in `frontend/app/scripts/site-access.mjs`, update the private hash variable, and redeploy. To reopen the website, set `TURRET_SITE_GATE=0` and redeploy. Do not remove the credential variables as a way to disable the gate: the enabled server will fail closed.

The contracts and independent oracle, risk, alert and liquidation services are unchanged. This is website access control, not a pause of onchain lending.

Validation covers bypass attempts against pages, assets, exports and APIs; incorrect credentials; forged and expired sessions; credential rotation; unsafe redirects; cross-origin forms; rate limiting; and disabled/misconfigured gate behavior. Desktop and mobile browser checks exercise the actual form, error state, sign-in and secure cookie. The browser test caught a `no-referrer` policy that made form submissions send a null Origin; the holding page now uses `same-origin`, preserving the origin check without blocking its own form. The detector's initial font-alias warning was resolved by using the documented font name.

Release evidence and final deployment checks are in `output/site-password-gate/`. Source is synchronized in the primary checkout and CASHCAT worktree.

Production deployment `afe7a9c4-5523-498d-a61f-28a0b94ff8a8` is verified. The main domain, blog and provider domain show the holding page without authentication; direct assets and RPC requests are gated. Password login works on desktop and mobile, and the shared cookie unlocks both Turret domains. Authenticated pages match the prior exports, and authenticated RPC returns chain 4663. All 7,475 runtime files match the release.
