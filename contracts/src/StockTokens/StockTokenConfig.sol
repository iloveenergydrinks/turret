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
        uint256 MCR;
        uint256 CCR;
        uint256 SCR;
        uint256 debtCeiling;
        uint256 maxOracleDeviationBps;
    }

    function all() internal pure returns (Config[] memory configs) {
        configs = new Config[](10);

        configs[0] = _config("AAPL", 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9, 175, 200, 125, 15_000_000, 1_500);
        configs[1] = _config("MSFT", 0xe93237C50D904957Cf27E7B1133b510C669c2e74, 175, 200, 125, 15_000_000, 1_500);
        configs[2] = _config("GOOGL", 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3, 180, 205, 125, 12_500_000, 1_500);
        configs[3] = _config("AMZN", 0x12f190a9F9d7D37a250758b26824B97CE941bF54, 185, 210, 125, 10_000_000, 1_750);
        configs[4] = _config("META", 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35, 190, 215, 125, 10_000_000, 1_750);
        configs[5] = _config("NVDA", 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, 200, 230, 125, 10_000_000, 2_000);
        configs[6] = _config("AVGO", 0x156E175DD063a8cE274C50654eF40e0032b3fbcF, 200, 230, 125, 7_500_000, 2_000);
        configs[7] = _config("LLY", 0x8005d266423c7ea827372c9c864491e5786600ea, 200, 230, 125, 7_500_000, 2_000);
        configs[8] = _config("MU", 0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD, 225, 255, 125, 5_000_000, 2_500);
        configs[9] = _config("TSLA", 0x322F0929c4625eD5bAd873c95208D54E1c003b2d, 250, 300, 125, 5_000_000, 2_500);
    }

    function _config(
        bytes32 symbol,
        address token,
        uint256 mcrPercent,
        uint256 ccrPercent,
        uint256 scrPercent,
        uint256 debtCeilingDollars,
        uint256 maxOracleDeviationBps
    ) private pure returns (Config memory) {
        return Config({
            symbol: symbol,
            robinhoodChainToken: token,
            MCR: mcrPercent * DECIMAL_PRECISION / 100,
            CCR: ccrPercent * DECIMAL_PRECISION / 100,
            SCR: scrPercent * DECIMAL_PRECISION / 100,
            debtCeiling: debtCeilingDollars * DECIMAL_PRECISION,
            maxOracleDeviationBps: maxOracleDeviationBps
        });
    }
}
