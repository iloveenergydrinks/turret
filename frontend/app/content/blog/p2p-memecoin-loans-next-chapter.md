---
title: "Turret is putting P2P memecoin loans first"
description: "Our next phase focuses on borrowing USDG against memecoins through loans funded by individual lenders, with agreed interest and repayment deadlines."
date: "2026-09-12"
author: "Turret"
category: "Product updates"
cover: "/blog/p2p-memecoin-loans-engraving-v1.png"
coverType: "artwork"
coverAlt: "Engraving of one person passing coins to another above a loan agreement, beside cat, frog and dog medallions and a padlock"
draft: false
---

Turret is putting P2P memecoin lending at the centre of its next phase. We want more holders on Robinhood Chain to be able to borrow USDG against their coins, on terms agreed with someone willing to lend.

The starting point is straightforward. You have tokens you want to keep exposure to. A lender has USDG and is willing to accept those tokens as collateral. You agree on the loan amount, the collateral, the total interest and a repayment deadline. Once the lender funds the offer and you accept it, the contract holds your collateral and sends you the USDG.

Repay as agreed, then withdraw your coins. You have accessed USDG without selling them at the start of the loan. Your collateral stays locked until repayment and withdrawal, and missing the final deadline puts all of it at risk.

That is the product we are expanding.

P2P gives each lender room to make a specific decision about a memecoin: how much would they lend against it, for how long, and for what interest? Different lenders can offer different terms for the same token. Borrowers can compare funded offers or publish a request for the amount and terms they need.

A request is an invitation to lenders. It does not reserve USDG or guarantee a loan. The lender must fund an onchain offer, and the borrower must accept it before borrowing begins. Loan funding comes from individual lenders supplying their own USDG. Adding support for a token does not depend on Turret allocating treasury money to a lending pool.

The repayment rules are equally specific. These P2P loans have no price-triggered liquidation: a fall in the token's market price does not automatically liquidate your position. The obligation is to repay the agreed USDG principal and fixed interest by the final deadline, including the 24-hour grace period. Early repayment still owes the full agreed interest.

After that deadline, the lender can claim the pledged collateral. A claim requires an onchain transaction; the tokens do not automatically arrive in the lender's wallet when the clock runs out. For lenders, this means being prepared to receive the token instead of USDG. Its value may have fallen below the amount lent, and selling it may be difficult. Once a loan is active, the lender cannot simply withdraw their principal on demand.

You can already find CASHCAT and PONS in the memecoin subsection of Turret's P2P marketplace. We have kept memecoins inside the existing borrowing experience, alongside stock and other token collateral. Pool loans and NFT loans remain available too. Our wider message still applies: borrow against memecoins, stocks and NFTs.

We are now working on a broader set of Robinhood Chain memecoins. A market cap above $5 million is our starting screen for new candidates. We also check the exact contract address, local trading liquidity, token behaviour and compatibility with the full loan lifecycle, including collateral recovery. A market-cap figure alone does not qualify a token, and the next batch will only appear as supported once its markets are deployed and verified.

More supported coins should give borrowers more opportunities to find a lender. Actual borrowing availability will still depend on funded offers and terms both sides accept.

[Explore P2P memecoin loans on Turret](https://turret.capital/borrow/p2p?category=memecoins).
