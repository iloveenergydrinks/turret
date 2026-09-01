// SPDX-License-Identifier: BUSL-1.1

pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import "src/ActivePool.sol";
import "src/AddressesRegistry.sol";

contract DebtCeilingCollateralMock is ERC20 {
    constructor() ERC20("NVIDIA Stock Token", "NVDA") {}
}

contract BranchDebtCeilingTest is Test {
    uint256 internal constant DEBT_CEILING = 100e18;
    address internal constant DEFAULT_POOL = address(0xDEFA017);

    ActivePool internal activePool;

    function setUp() public {
        AddressesRegistry registry =
            new AddressesRegistry(address(this), 230e16, 200e16, 10e16, 125e16, 5e16, 10e16, DEBT_CEILING);
        DebtCeilingCollateralMock collateral = new DebtCeilingCollateralMock();

        registry.setAddresses(
            IAddressesRegistry.AddressVars({
                collToken: collateral,
                borrowerOperations: IBorrowerOperations(address(this)),
                troveManager: ITroveManager(address(0xB1)),
                troveNFT: ITroveNFT(address(0xB2)),
                metadataNFT: IMetadataNFT(address(0xB3)),
                stabilityPool: IStabilityPool(address(0xB4)),
                priceFeed: IPriceFeed(address(0xB5)),
                activePool: IActivePool(address(0xB6)),
                defaultPool: IDefaultPool(DEFAULT_POOL),
                gasPoolAddress: address(0xB7),
                collSurplusPool: ICollSurplusPool(address(0xB8)),
                sortedTroves: ISortedTroves(address(0xB9)),
                interestRouter: IInterestRouter(address(0xBA)),
                hintHelpers: IHintHelpers(address(0xBB)),
                multiTroveGetter: IMultiTroveGetter(address(0xBC)),
                collateralRegistry: ICollateralRegistry(address(0xBD)),
                boldToken: IBoldToken(address(0xBE)),
                WETH: IWETH(address(collateral))
            })
        );

        activePool = new ActivePool(registry);
        vm.mockCall(DEFAULT_POOL, IDefaultPool.getBoldDebt.selector, abi.encode(95e18));
    }

    function testAllowsDebtIncreaseUpToCeiling() public {
        activePool.mintAggInterestAndAccountForTroveChange(_change(5e18, 0), address(0));
        assertEq(activePool.aggRecordedDebt(), 5e18);
    }

    function testRevertsWhenDebtIncreaseExceedsCeiling() public {
        vm.expectRevert(ActivePool.DebtCeilingExceeded.selector);
        activePool.mintAggInterestAndAccountForTroveChange(_change(5e18 + 1, 0), address(0));
    }

    function testCountsNewUpfrontFeesAgainstCeiling() public {
        vm.expectRevert(ActivePool.DebtCeilingExceeded.selector);
        activePool.mintAggInterestAndAccountForTroveChange(_change(0, 5e18 + 1), address(0));
    }

    function _change(uint256 debtIncrease, uint256 upfrontFee) internal pure returns (TroveChange memory change) {
        change.debtIncrease = debtIncrease;
        change.upfrontFee = upfrontFee;
    }
}
