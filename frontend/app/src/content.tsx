/* oxlint-disable react/jsx-key */

import type { ReactNode as N } from "react";

import { css } from "@/styled-system/css";

export default {
  // Used in the top bar and other places
  appName: "Turret",
  appDescription: `
    Borrow USDG against memecoins, stocks and NFTs without selling them.
  `,
  appUrl: typeof window === "undefined"
    ? "https://turret.capital"
    : window.location.origin,
  appIcon: (
    typeof window === "undefined" ? "" : window.location.origin
  ) + "/brand/turret-mark.svg",

  // Menu bar
  menu: {
    dashboard: "Dashboard",
    borrow: "Borrow",
    multiply: "Multiply",
    earn: "Earn",
    stake: "Stake",
  },

  accountButton: {
    wrongNetwork: "Wrong network",
    connectAccount: "Connect",
  },

  generalInfotooltips: {
    loanLiquidationRisk: [
      "Liquidation risk",
      <>
        If the LTV of a loan goes above the max LTV, it becomes undercollateralized and will be liquidated. In that
        case, the borrower's debt is paid off but they lose most of their collateral. In order to avoid liquidation, one
        can increase the collateral or reduce the debt.
      </>,
    ],
    loanRedemptionRisk: [
      "Redemption risk",
      <>
        Users paying the lowest interest rate can get redeemed if the price of rUSD falls below $1. By raising your
        interest rate, you reduce this risk.
      </>,
    ],
    loanLtv: [
      "Loan-to-value ratio",
      <>
        The ratio between the amount of rUSD borrowed and the deposited collateral (in USD).
      </>,
    ],
    loanMaxLtv: [
      "Maximum Loan-To-Value (LTV) Ratio",
      <>
        The maximum ratio between the USD value of a loan (in rUSD) and the collateral backing it. The LTV will
        fluctuate as the price of the collateral changes. To decrease the LTV, add more collateral or reduce debt.
      </>,
    ],
    loanLiquidationPrice: [
      "Liquidation price",
      <>The collateral price at which a loan can be liquidated.</>,
    ],
    ethPrice: [
      "Collateral price",
      <>
        The current collateral price reported by the oracle. It is used to calculate the loan-to-value ratio.
      </>,
    ],
    interestRateBoldPerYear: [
      "Interest rate",
      <>
        The annualized interest amount in rUSD for the selected interest rate. The accumulated interest is added to the
        loan.
      </>,
    ],
    interestRateAdjustment: [
      "Interest rate adjustment",
      <>
        The interest rate can be adjusted at any time. If it is adjusted within less than seven days of the last
        adjustment, there is a fee.
      </>,
    ],
    redeemedLoan: {
      heading: "Your collateral and debt are reduced by the same value.",
      body: (
        <>
          When rUSD trades below $1, holders can redeem rUSD for collateral worth $1. Positions with the lowest interest
          rate get redeemed first.
        </>
      ),
      footerLink: {
        href: "https://docs.turret.capital",
        label: "Learn more",
      },
    },
  },

  // Redemption info box
  redemptionInfo: {
    title: "Redemptions in a nutshell",
    subtitle: (
      <>
        Redemptions help maintain the rUSD peg. If a position is redeemed, its collateral and debt are reduced equally,
        resulting in no net loss.
      </>
    ),
    infoItems: [
      {
        icon: "bold",
        text: "Redemptions occur when rUSD trades below $1.",
      },
      {
        icon: "redemption",
        text: "Redemptions first affect loans with the lowest interest rate.",
      },
      {
        icon: "interest",
        text: "Raising the interest rate reduces your redemption risk.",
      },
    ],
    learnMore: {
      text: "Learn more about redemptions",
      href: "https://docs.turret.capital",
    },
  },

  interestRateField: {
    delegateModes: {
      manual: {
        label: "Manual",
        secondary: <>The interest rate is set manually and can be updated at any time.</>,
      },
      delegate: {
        label: "Delegated",
        secondary: (
          <>The interest rate is automatically managed by a third party of your choice. They may charge a fee.</>
        ),
      },
    },

    delegatesModal: {
      title: "Set a delegate",
      intro: (
        <>
          The interest rate is automatically managed by a third party of your choice. They may charge a fee.
        </>
      ),
    },
  },

  closeLoan: {
    claimOnly: (
      <>
        You are reclaiming your collateral and closing the position. The deposit will be returned to your wallet.
      </>
    ),
    repayWithBoldMessage: (
      <>
        You are repaying your debt and closing the position. The deposit will be returned to your wallet.
      </>
    ),
    repayWithCollateralMessage: (collateralName: string) => (
      <>
        To close your position, part of your {collateralName}{" "}
        will be sold to pay back the debt. The rest will be returned to your wallet.
      </>
    ),
    buttonRepayAndClose: "Repay & close",
    buttonReclaimAndClose: "Reclaim & close",
  },

  // Home screen
  home: {
    openPositionTitle: "Open your first position",
    myPositionsTitle: "My positions",
    actions: {
      borrow: {
        title: "Borrow",
        description: "Borrow rUSD against Stock Token collateral at your chosen interest rate",
      },
      multiply: {
        title: "Multiply",
        description: "Increase your exposure to ETH and its staking yield with a single click",
      },
      earn: {
        title: "Earn with rUSD",
        description: "Deposit rUSD to earn protocol revenue and liquidation proceeds",
      },
      stake: {
        title: "Stake LQTY",
        description: "Direct protocol incentives with LQTY while earning from Liquity V1",
      },
    },
    redemptionShieldBanner: {
      badgeLabel: "Redemption shielded",
      headline: (symbols: string[]) =>
        `${
          symbols.length === 1
            ? symbols[0]
            : `${symbols.slice(0, -1).join(", ")} and ${symbols[symbols.length - 1]}`
        } borrowers are temporarily shielded from redemptions.`,
      detailSingle: (headroom: string) =>
        ` The Stability Pool exceeds total branch debt by $${headroom}, so you can currently borrow at the `,
      detailMultiple: " Their Stability Pools exceed their total branch debt, so you can currently borrow at the ",
      detailCompact: " Borrow at the ",
      learnMore: {
        text: "Learn more",
        href:
          "https://docs.turret.capital",
      },
    },
    earnTable: {
      title: "Earn rewards with rUSD",
      subtitle: "Deposit rUSD in a Stability Pool to earn rUSD and Stock Token rewards",
    },
    yieldTable: {
      title: "Top 3 external yield opportunities",
      hint: {
        title: "All yield sources on Dune",
        url: "https://dune.com/liquity/liquity-v2-yields",
        label: "Learn more",
      },
    },
    statsBar: {
      label: "Protocol stats",
    },
    infoTooltips: {
      avgInterestRate: [
        "The current average interest rate being paid by ETH-backed positions.",
      ],
      spApr: [
        "Annual Percentage Rate",
        "The annual percentage rate being earned by each stability pool’s deposits over the past 7 days.",
      ],
      spTvl: [
        "Total Value Locked",
        "The total amount of rUSD deposited in each Stability Pool.",
      ],
      borrowTvl: [
        "Total Value Locked",
        "The total amount of collateral deposited.",
      ],
    },
  },

  // Borrow screen
  borrowScreen: {
    headline: (eth: N, bold: N) => (
      <>
        Borrow {bold} with {eth}
      </>
    ),
    depositField: {
      label: "Collateral",
    },
    borrowField: {
      label: "Loan",
    },
    interestRateField: {
      label: "Interest rate",
    },
    action: "Next: Summary",
    infoTooltips: {
      interestRateSuggestions: [
        "Positions with lower interest rates are redeemed first by rUSD holders.",
      ],
    },
  },

  // Multiply screen
  leverageScreen: {
    headline: (tokensIcons: N) => (
      <>
        Multiply your exposure to {tokensIcons}
      </>
    ),
    depositField: {
      label: "Deposit",
    },
    liquidationPriceField: {
      label: "Liquidation price",
    },
    interestRateField: {
      label: "Interest rate",
    },
    action: "Next: Summary",
    infoTooltips: {
      leverageLevel: [
        "Multiply level",
        <>
          Choose the amplification of your exposure. Note that a higher level means higher liquidation risk. You are
          responsible for your own assessment of what a suitable level is.
        </>,
      ],
      interestRateSuggestions: [
        <>
          Positions with lower interest rates are redeemed first by rUSD holders.
        </>,
      ],
      exposure: [
        "Exposure",
        <>
          Your total exposure to the collateral asset after amplification.
        </>,
      ],
    },
  },

  // Earn home screen
  earnHome: {
    headline: (rewards: N, bold: N) => (
      <>
        Deposit
        <NoWrap>{bold} rUSD</NoWrap>
        to earn <NoWrap>rewards {rewards}</NoWrap>
      </>
    ),
    subheading: (
      <>
        An rUSD deposit earns a share of borrower interest. During liquidations, the Stability Pool uses deposited rUSD
        to cancel debt and distributes the liquidated Stock Token collateral to depositors.
      </>
    ),
    learnMore: ["https://docs.turret.capital", "Learn more"],
    poolsColumns: {
      pool: "Pool",
      apr: "APR",
      myDepositAndRewards: "My Deposits and Rewards",
    },
    infoTooltips: {
      tvl: (collateral: N) => [
        <>Total rUSD available for {collateral}-backed position liquidations</>,
      ],
    },
  },

  // Earn screen
  earnScreen: {
    backButton: "See all pools",
    headerPool: (pool: N) => <>{pool} pool</>,
    headerTvl: (tvl: N) => (
      <>
        <abbr title="Total Value Locked">TVL</abbr> {tvl}
      </>
    ),
    headerApr: () => (
      <>
        Current <abbr title="Annual percentage rate">APR</abbr>
      </>
    ),
    accountPosition: {
      depositLabel: "My deposit",
      shareLabel: "Pool share",
      rewardsLabel: "My rewards",
    },
    tabs: {
      deposit: "Update",
      claim: "Claim rewards",
      compound: "Compound",
    },
    depositPanel: {
      label: "Increase deposit",
      shareLabel: "Pool share",
      claimCheckbox: "Claim rewards",
      action: "Next: Summary",
    },
    withdrawPanel: {
      label: "Decrease deposit",
      action: "Next: Summary",
    },
    rewardsPanel: {
      boldRewardsLabel: "Your rUSD rewards will be paid out",
      collRewardsLabel: (collateral: N) => <>Your {collateral} rewards will be paid out</>,
      expectedGasFeeLabel: "Expected gas fee",
      action: "Next: Summary",
    },
    compoundPanel: {
      boldRewardsLabel: "Your rUSD rewards will be added to your deposit",
      collRewardsLabel: (collateral: N) => <>Your {collateral} rewards will remain in your deposit</>,
      expectedGasFeeLabel: "Expected gas fee",
      action: "Next: Summary",
    },
    infoTooltips: {
      tvl: (collateral: N) => [
        <>Total rUSD available for {collateral}-backed position liquidations.</>,
      ],
      depositPoolShare: [
        "Your rUSD deposit as a percentage of the Stability Pool.",
      ],
      alsoClaimRewardsDeposit: (collateral: N) => [
        <>
          If checked, rewards will be paid out as part of the deposit transaction. Otherwise, rUSD rewards will be
          compounded and {collateral} rewards will remain claimable.
        </>,
      ],
      alsoClaimRewardsWithdraw: (collateral: N) => [
        <>
          <div>
            If checked, rewards will be paid out as part of the withdrawal transaction. Otherwise, rUSD rewards will be
            compounded and {collateral} rewards will remain claimable.
          </div>
          <div className={css({ color: "content" })}>
            Rewards will always be claimed when fully withdrawing from the Stability Pool.
          </div>
        </>,
      ],
      currentApr: [
        "Average annualized return for rUSD deposits over the past 7 days.",
      ],
      rewardsEth: [
        "ETH rewards",
        "Your proceeds from liquidations conducted by this stability pool.",
      ],
      rewardsBold: [
        "rUSD rewards",
        "Your earnings from protocol revenue distributions to this stability pool.",
      ],
    },
  },

  // Stake screen
  stakeScreen: {
    headline: (lqtyIcon: N) => (
      <>
        <span>Stake</span>
        {lqtyIcon} <span>LQTY & get</span>
        <span>voting power</span>
      </>
    ),
    subheading: (
      <>
        This legacy LQTY staking interface is separate from TURRET staking and its USDG rewards.
      </>
    ),
    learnMore: [
      "https://docs.turret.capital",
      "Learn more",
    ],
    accountDetails: {
      myDeposit: "My deposit",
      votingPower: "Voting power",
      votingPowerHelp: (
        <>
          Voting power is the percentage of the total staked LQTY that you own.
        </>
      ),
      unclaimed: "Unclaimed rewards",
    },
    tabs: {
      deposit: "Staking",
      rewards: "Rewards",
      voting: "Voting",
    },
    depositPanel: {
      label: "Deposit",
      shareLabel: "Pool share",
      rewardsLabel: "Available rewards",
      action: "Next: Summary",
    },
    rewardsPanel: {
      label: "You claim",
      details: (usdAmount: N, fee: N) => (
        <>
          ~${usdAmount} • Expected gas fee ~${fee}
        </>
      ),
      action: "Next: Summary",
    },
    votingPanel: {
      title: "Allocate your voting power",
      intro: (
        <>
          Vote on initiatives and direct incentives from protocol revenue toward rUSD liquidity venues. Upvote from
          Thursday to Tuesday. Downvote all week. Get and claim bribes for some of them.
        </>
      ),
      resources: {
        overview: {
          description: "Learn more about voting accrual, initiative and protocol incentivized liquidity (PIL).",
          linkText: "LQTY Voting & Staking in V2",
          linkUrl: "https://docs.turret.capital",
        },
        discuss: {
          description: "Overview over the PIL initiatives – propose and discuss initiatives.",
          linkText: "Protocol Incentivized Liquidy (PIL) Initiatives",
          linkUrl: "https://voting.liquity.org/",
        },
        dashboard: {
          description: "Check Dune Dash for the weekly voting and reward distributions.",
          linkText: "Voting stats",
          linkUrl: "https://dune.com/liquity/protocol-incentivized-liquidity",
        },
        bribes: {
          description:
            "Initiatives can offer Bribes. Active bribing campaigns are visible below and can be claimed weekly.",
          linkText: "Bribing Markets",
          linkUrl: "https://www.liquity.org/blog/bribe-markets-in-liquity-v2-strategic-value-for-lqty-stakers",
        },
      },
    },
    infoTooltips: {
      alsoClaimRewardsDeposit: [
        <>
          Rewards will be paid out as part of the update transaction.
        </>,
      ],
      votingShare: (
        <>
          Your voting share is the amount of LQTY you have staked and that is available to vote, divided by the total
          amount of LQTY staked via the governance contract.
        </>
      ),
      votingPower: (
        <>
          Your relative voting power changes over time, depending on your and others allocations of LQTY.
        </>
      ),
    },
  },
  atRiskWarning: {
    delegated: (maxLtvAllowed: string) => (
      <div>
        When you delegate your interest rate management, your <abbr title="Loan-to-value ratio">LTV</abbr> must be below
        {" "}
        {maxLtvAllowed}. Please reduce your loan or add more collateral to proceed.
      </div>
    ),
    manual: (ltv: string, maxLtv: string) => ({
      message: (
        <div>
          Your position's <abbr title="Loan-to-value ratio">LTV</abbr> is {ltv}, which is close to the maximum of{" "}
          {maxLtv}. You are at high risk of liquidation.
        </div>
      ),
      checkboxLabel: "I understand. Let's continue.",
    }),
  },
  ccrWarning: {
    title: "Borrowing Restrictions Apply",
    learnMoreUrl:
      "https://docs.turret.capital",
    learnMoreLabel: "Learn more about borrowing restrictions",
    openPosition: (params: { tcr: N; ccr: N; newTcr: N; isOldTcrLtCcr: boolean }) => (
      <>
        {params.isOldTcrLtCcr && (
          <>
            The branch <abbr title="Total Collateral Ratio">TCR</abbr> of {params.tcr} is currently below the{" "}
            <abbr title="Critical Collateral Ratio">CCR</abbr> of {params.ccr}.{" "}
          </>
        )}
        Opening a position must bring the branch <abbr title="Total Collateral Ratio">TCR</abbr> {params.isOldTcrLtCcr
          ? <>above {params.ccr}.</>
          : (
            <>
              above the <abbr title="Critical Collateral Ratio">CCR</abbr> of {params.ccr}.
            </>
          )} Opening this loan would result in a <abbr title="Total Collateral Ratio">TCR</abbr> of{" "}
        {params.newTcr}. Please reduce your loan amount or increase your collateral to proceed.
      </>
    ),
    updatePushBelow: (params: { newTcr: N; ccr: N }) => (
      <>
        This update to your existing loan would bring the branch <abbr title="Total Collateral Ratio">TCR</abbr> to{" "}
        {params.newTcr}, which is below the <abbr title="Critical Collateral Ratio">CCR</abbr> of{" "}
        {params.ccr}. Please reduce your loan amount or increase your collateral to proceed.
      </>
    ),
    updateBorrowMore: (params: { tcr: N; ccr: N; newTcr: N; isNewTcrLteCcr: boolean }) => (
      <>
        The branch <abbr title="Total Collateral Ratio">TCR</abbr> of {params.tcr} is currently below the{" "}
        <abbr title="Critical Collateral Ratio">CCR</abbr> of {params.ccr}. {params.isNewTcrLteCcr
          ? (
            <>
              New borrowing must bring the <abbr title="Total Collateral Ratio">TCR</abbr> above{" "}
              {params.ccr}. Your current loan update would result in a <abbr title="Total Collateral Ratio">TCR</abbr>
              {" "}
              of {params.newTcr}.
            </>
          )
          : <>When borrowing, your collateral increase must exceed your debt increase.</>}{" "}
        Please reduce your loan amount or increase your collateral to proceed.
      </>
    ),
    updateWithdrawColl: (params: { tcr: N; ccr: N }) => (
      <>
        The branch <abbr title="Total Collateral Ratio">TCR</abbr> of {params.tcr} is currently below the{" "}
        <abbr title="Critical Collateral Ratio">CCR</abbr> of{" "}
        {params.ccr}. Collateral withdrawal must be matched by debt repayment. Please repay debt equal to or greater
        than the collateral value you wish to withdraw.
      </>
    ),
    interestRateAdjustment: (params: { tcr: N; ccr: N; cooldownDays: number }) => (
      <>
        The branch <abbr title="Total Collateral Ratio">TCR</abbr> of {params.tcr} is currently below the{" "}
        <abbr title="Critical Collateral Ratio">CCR</abbr> of{" "}
        {params.ccr}. Interest rate adjustments are restricted until either the{" "}
        <abbr title="Total Collateral Ratio">TCR</abbr> rises above {params.ccr}, or {params.cooldownDays}{" "}
        days have passed since your last adjustment.
      </>
    ),
  },
  shutdownWarning: {
    title: "Branch Shutdown",
    borrowMessage: (collName: string) => (
      <>
        The {collName} branch is in shutdown mode. New loans cannot be opened on this branch.
      </>
    ),
    loanMessage: (collName: string) => (
      <>
        The {collName} branch is in shutdown mode. Loan adjustments are not available. You can only close your loan.
      </>
    ),
  },
  urgentRedeemScreen: {
    headingTitle: "Shutdown Redemptions",
    headingTitleActive: "Shutdown Redemption",
    selectBranchLabel: "Select branch",
    redeemFieldLabel: "You redeem",
    insufficientBalance: (balance: string) => `Insufficient rUSD balance. You have ${balance} rUSD.`,
    amountCapped: (amount: string) => `Capped to ${amount} rUSD (maximum redeemable amount).`,
    youReceive: "You receive",
    bonusLabel: (bonusPct: string) => `Including ${bonusPct} bonus`,
    bonusTooltip: (bonusPct: string) => `Shutdown redemptions include a ${bonusPct} bonus on the collateral received.`,
    slippageTolerance: "Slippage tolerance",
    manualTrovesLabel: "Manually selected troves",
    autoTrovesLabel: "Auto-selected troves",
    useAutoSelection: "Use auto-selection",
    manuallySelectTroves: "Manually select troves",
    trovesCount: (count: number) => `${count} ${count === 1 ? "trove" : "troves"} will be used for this redemption.`,
    action: "Redeem",
    backLink: "Back",
    successLink: "Go to the Dashboard",
    successMessage: "The shutdown redemption was successful.",
    noShutdown: {
      title: "No Branches in Shutdown Mode",
      body: (
        <>
          Shutdown redemptions are only available when a branch is in shutdown mode. Currently, all branches are
          operating normally.
        </>
      ),
      link: "Go to standard redemptions",
    },
    noTroves: {
      title: "No Shutdown Redemptions Available",
      body: "No troves are currently available for shutdown redemption in this branch.",
    },
    troveTable: {
      trovesSelected: (count: number) => `${count} ${count === 1 ? "trove" : "troves"} selected`,
      totalDebt: "Total debt:",
      totalDebtUnit: "rUSD",
      totalColl: "Total coll:",
      deselectAll: "Clear all",
      selectAllOnPage: "Select all on page",
      clearSelection: "Clear selection",
      columnTroveId: "Trove ID",
      columnCollateral: "Collateral",
      columnDebt: "Debt",
      columnIcr: "ICR",
      noTrovesAvailable: "No troves available",
      page: (current: number, total: number) => `Page ${current} of ${total}`,
      previous: "Previous",
      next: "Next",
    },
    txFlow: {
      title: "Review & Send Transaction",
      youRedeemBold: "You redeem rUSD",
      redeemTooltip: (bonusPct: string) =>
        `Shutdown redemptions have 0% fee and include a ${bonusPct} collateral bonus.`,
      youReceiveToken: (tokenName: string) => `You receive ${tokenName}`,
      receiveTooltip: (tokenName: string, bonusPct: string) =>
        `This is the estimated amount of ${tokenName} you will receive, including`
        + ` the ${bonusPct} bonus. The actual amount may vary based on the selected troves.`,
      trovesLabel: "Troves to redeem from",
      trovesTooltip: (
        <>
          The number of troves that will be used for this redemption. Shutdown redemptions are competitive - other users
          may redeem from these troves before your transaction confirms.
        </>
      ),
      trovesValue: (count: number) => `${count} ${count === 1 ? "trove" : "troves"}`,
      slippageTooltip: (threshold: N) => (
        <>
          If the actual collateral received is less than {threshold}{" "}
          of the expected amount, the transaction will revert.
        </>
      ),
      approveStep: "Approve rUSD",
      redeemStep: "Execute Shutdown Redemption",
    },
  },
  dataSources: {
    title: "Data Sources",
    description:
      "The app uses public endpoints by default. If you experience connection issues or prefer to use your own infrastructure, you can specify custom URLs below.",
    rpcUrlLabel: "RPC URL",
    subgraphUrlLabel: "Subgraph URL",
    resetToDefault: "Reset to default",
    validationError: "Please enter a valid URL (http:// or https://)",
    usingCustom: (type: string, defaultUrl: string) => `Using custom ${type}. Default: ${defaultUrl}`,
    usingDefault: (type: string) => `Using default ${type}. Enter a URL to override.`,
    cancelButton: "Cancel",
    saveButton: "Save & Reload",
    resetButton: "Reset & Reload",
  },

  manualLoanIdInput: {
    title: "Data API error",
    description:
      "The list of loans below could be incomplete. If one of your loans doesn't appear, please enter your Loan ID manually to view it.",
    inputPlaceholder: "Loan ID (0x...)",
    branchDetected: (branchId: number) => `(Branch ${branchId} detected)`,
    buttonLabel: "View Loan",
    buttonDetecting: "Detecting...",
    errorInvalidFormat: "Invalid Loan ID format. Please enter a valid hexadecimal address starting with 0x.",
    errorNotFound: "Loan ID not found. Please check the ID and try again.",
    foundMultipleBranches: "Found on multiple collaterals. Select one to view:",
    tooltip: {
      heading: "How to get your Loan IDs",
      body: (address: string) => (
        <>
          Checkout{" "}
          <a
            href={`https://liquityv2.defiexplore.com/owner/${address.toLowerCase()}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            DefiExplore
          </a>{" "}
          or{" "}
          <a
            href={`https://rails.finance/troves?ownerAddress=${address.toLowerCase()}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Rails
          </a>{" "}
          to get your Loan IDs.
        </>
      ),
      footerLink: {
        label: "Check the docs for more details",
        href: "https://docs.turret.capital",
      },
    },
  },
} as const;

// function Link({
//   href,
//   children,
// }: {
//   href: string;
//   children: N;
// }) {
//   const props = !href.startsWith("http") ? {} : {
//     target: "_blank",
//     rel: "noopener noreferrer",
//   };
//   return (
//     <a href={href} {...props}>
//       {children}
//     </a>
//   );
// }

function NoWrap({
  children,
  gap = 8,
}: {
  children: N;
  gap?: number;
}) {
  return (
    <span
      className={css({
        display: "inline-flex",
        alignItems: "center",
        whiteSpace: "nowrap",
      })}
      style={{
        gap,
      }}
    >
      {children}
    </span>
  );
}
