// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

/// @notice Sandcastle risk manifest for the first ten Stock Token branches.
/// @dev Token addresses are canonical Robinhood Chain mainnet addresses as of
/// 2026-09-01. Deployment tooling must validate them against the live Robinhood
/// asset registry immediately before any production deployment.
library StockTokenConfig {
    uint256 internal constant DECIMAL_PRECISION = 1e18;

    struct Config {
        bytes32 symbol;
        address robinhoodChainToken;
        address chainlinkFeed;
        address secondaryChainlinkFeed;
        uint256 MCR;
        uint256 CCR;
        uint256 SCR;
        uint256 debtCeiling;
        uint256 maxOracleDeviationBps;
    }

    function all() internal pure returns (Config[] memory configs) {
        configs = new Config[](10);

        configs[0] = _config(
            "AAPL",
            0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9,
            0x6B22A786bAa607d76728168703a39Ea9C99f2cD0,
            0x4bDbb3150014c6Ab2C6D9347B0779c49015a2f3f,
            175,
            200,
            125,
            15_000_000,
            1_500
        );
        configs[1] = _config(
            "MSFT",
            0xe93237C50D904957Cf27E7B1133b510C669c2e74,
            0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E,
            0xaD6D88eab22aa4867Efe807a5311Ed64962f740D,
            175,
            200,
            125,
            15_000_000,
            1_500
        );
        configs[2] = _config(
            "GOOGL",
            0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3,
            0xF6f373a037c30F0e5010d854385cA89185AE638b,
            0xA04EE5c4c8827F17e82f93bE9e19DeA221A749a8,
            180,
            205,
            125,
            12_500_000,
            1_500
        );
        configs[3] = _config(
            "AMZN",
            0x12f190a9F9d7D37a250758b26824B97CE941bF54,
            0xD5a1508ceD74c084eBf3cBe853e2C968fB2a651C,
            0x9244830430bC7D9C9A48dd47603F24AD61f7c56e,
            185,
            210,
            125,
            10_000_000,
            1_750
        );
        configs[4] = _config(
            "META",
            0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35,
            0x7C38C00C30BEe9378381E7B6135d7283356D71b1,
            0x5cBC53D382E56cBb223f118CF8Eefb6c9c2759f5,
            190,
            215,
            125,
            10_000_000,
            1_750
        );
        configs[5] = _config(
            "NVDA",
            0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,
            0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15,
            0xCF169363636D73dbBf77733629CB38919d14232d,
            200,
            230,
            125,
            10_000_000,
            2_000
        );
        configs[6] = _config(
            "AMD",
            0x86923f96303D656E4aa86D9d42D1e57ad2023fdC,
            0x943A29E7ae51A4798823ca9eEd2ed533B2A22C72,
            0xF6d57763DFa625F4A413485261Ab2E71Ff4304CF,
            200,
            230,
            125,
            7_500_000,
            2_000
        );
        configs[7] = _config(
            "ORCL",
            0xb0992820E760d836549ba69BC7598b4af75dEE03,
            0x0e6a64a2B58A6693a531E6c555f3A5d042eEA844,
            0x2a07f8d87d369Bd8Bc36472337ae02d512a7b5e5,
            200,
            230,
            125,
            7_500_000,
            2_000
        );
        configs[8] = _config(
            "MU",
            0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD,
            0x425EEFdCf05ed6526C3cE61Af99429A228a6d596,
            0x5b40F4E78FA58B60a4F59b8cc8cB8d2Fb0690467,
            225,
            255,
            125,
            5_000_000,
            2_500
        );
        configs[9] = _config(
            "TSLA",
            0x322F0929c4625eD5bAd873c95208D54E1c003b2d,
            0x4A1166a659A55625345e9515b32adECea5547C38,
            0xE4479F01738B4e8C428CD8eB72D47AB9BC3c7de6,
            250,
            300,
            125,
            5_000_000,
            2_500
        );
    }

    function _config(
        bytes32 symbol,
        address token,
        address chainlinkFeed,
        address secondaryChainlinkFeed,
        uint256 mcrPercent,
        uint256 ccrPercent,
        uint256 scrPercent,
        uint256 debtCeilingDollars,
        uint256 maxOracleDeviationBps
    ) private pure returns (Config memory) {
        return Config({
            symbol: symbol,
            robinhoodChainToken: token,
            chainlinkFeed: chainlinkFeed,
            secondaryChainlinkFeed: secondaryChainlinkFeed,
            MCR: mcrPercent * DECIMAL_PRECISION / 100,
            CCR: ccrPercent * DECIMAL_PRECISION / 100,
            SCR: scrPercent * DECIMAL_PRECISION / 100,
            debtCeiling: debtCeilingDollars * DECIMAL_PRECISION,
            maxOracleDeviationBps: maxOracleDeviationBps
        });
    }
}
