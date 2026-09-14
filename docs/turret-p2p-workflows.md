# P2P borrower request operations

Borrower requests and counteroffers are public, signed listings stored by the website. Publishing a request, proposing terms or agreeing to a proposal does not reserve USDG, transfer collateral or create debt. The lender separately funds a private offer in the existing registered market. The borrower then reviews and accepts that offer on-chain. Existing contracts and accepted loans keep their original rules.

## Server configuration

Set `P2P_REQUESTS_ORIGIN` to the exact public origin, including scheme and any nonstandard port; for example, `https://turret.capital`. Browser signatures and POST `Origin` must match this value. The server falls back to `NEXT_PUBLIC_APP_URL`, then `https://turret.capital`. Redirect alternate hostnames to the canonical origin before presenting the request form. Changing the origin requires a planned storage migration because the saved file and signatures are bound to it.

Set `P2P_REQUESTS_DIRECTORY` to a mounted persistent volume. Its default, `.data/p2p-requests` relative to the server working directory, is suitable for local operation but will not survive replacement of an ephemeral container. Back up `borrower-requests-v1.json`. Request and proposal history cannot be rebuilt from the blockchain; funded offers and loans remain discoverable on-chain even if listing data is lost.

Run one request-service process against this directory. The file adapter serializes writes inside one process and uses file synchronization, atomic rename and directory synchronization. It is not a shared database lock for multiple replicas. Horizontal scaling requires a transactional shared store with equivalent revision and nonce guarantees. Stop writes before restoring a backup; wait at least six minutes after the final accepted write before reopening, so signatures absent from the backup have expired, including the permitted clock tolerance. Do not edit the live file while the service holds its cached state.

The service uses the release-owned `public/p2p-markets.json` registry and the existing server RPC client. Requests cannot supply RPC URLs, runtime hashes, token addresses or alternate custody contracts. Registry entries must identify one chain and unique current V2/V3 markets. The deployed server must include `scripts/p2p-requests.mjs` and its shared signing module, `src/p2p/requests-shared.mjs`.

## API and authentication

`GET /api/p2p/requests` browses current requests. Optional filters are `market`, `account`, `requestId` and `cursor`. Each page contains at most 30 requests and an explicit `nextCursor`. The account filter includes requests created by that wallet and requests it has proposed to, including expired or cancelled history. These are public listings; the account filter is not a privacy boundary. Failed storage or RPC checks return an error, not a successful empty result.

`POST /api/p2p/requests` accepts `{ envelope, signature }`. Supported actions are `publish`, `propose`, `accept`, `cancel`, `cancelProposal` and `bind`. The signature covers the canonical site origin, chain, manager, acting wallet, action, exact raw-unit amounts and deadlines, relevant request/proposal IDs, current request revision, unique nonce, issue time and expiry. The shared module constructs the exact signing message. Signatures authorize listing changes only and expire within five minutes. The connected wallet and chain are checked before and after signing; the server checks its RPC chain before signature verification, including contract-wallet verification. Replay protection is persisted with the listing change, and stale revisions require a fresh read and signature.

The board limits each borrower to five active requests, each lender to three active proposals per request and each request to 20 proposals in its history. Request expiry is at most 30 days after publication; a proposal cannot outlive its request. A wallet may perform 12 signed actions per minute, and the HTTP handler permits 40 POST attempts per minute per direct network peer. Reverse proxies can make several users share that peer limit. Payloads are limited to 16 KiB; storage holds at most 10,000 requests. Capacity errors preserve existing records and do not affect on-chain recovery.

## Funding, linking and recovery

The request UI passes `RequestFundingDraft` into the existing private-offer review. `validateRequestFunding` refreshes the request immediately before funding and rejects a cancelled or expired request/proposal, a different lender, changed exact terms or an already linked offer. Editing away from the proposal creates a separate offer and must detach the request association.

Offchain cancellation cannot atomically prevent a wallet transaction already being approved or mined. A request may change after the last check. The resulting funded offer is still an ordinary private offer: its lender can cancel it while open, and only its named borrower can accept it. Neither cancelling a request nor cancelling a proposal cancels an existing offer or changes an accepted loan.

After funding confirms, `bindRequestOffer` requests a separate listing signature. The server verifies a canonical chain block, the registered manager runtime, immutable token addresses, exact parties and proposed terms. An open V3 offer must have its principal in that offer's vault; an open V2 offer must have enough shared USDG for reserved principal and all USDG withdrawal credits. A mismatched or unbacked offer cannot be linked as newly funded. A link identifies an offer, not a promise that the borrower will accept it.

If funding succeeds and the link signature or save fails, preserve the successful transaction and direct offer link. Do not fund again. The request UI provides **Already funded? Link the offer**, which verifies the supplied offer ID before saving it. Either named party may refresh an existing link; cancelled and expired offer states can be recorded without losing its history. Displayed linked states are explicitly the last verified state at the reported block. Open the direct loan view for its current state, acceptance or recovery. A failed refresh leaves the prior historical evidence intact.

## Repeatable checks

From `frontend/app`, run:

```sh
node --test scripts/p2p-requests.test.mjs scripts/p2p-requests.integration.test.mjs
pnpm exec vitest run src/p2p/requests.test.ts
pnpm exec tsc --noEmit
```

The integration test starts its own local Anvil chain and uses existing compiled `contracts/p2p/out` artifacts. Run `forge build --root contracts/p2p` from the repository root if those artifacts are absent. The test covers signed request publication, changed lender terms, borrower agreement, lender approval and funding, verified linking, borrower approval and actual loan acceptance. It accepts no external RPC or wallet key. Browser lifecycle checks cover the integrated Requests and private-offer screens separately.
