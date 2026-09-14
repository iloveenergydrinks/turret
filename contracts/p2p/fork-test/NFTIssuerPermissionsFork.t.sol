// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {NFTLiveCollectionsForkTest} from "./NFTLiveCollectionsFork.t.sol";
interface IPyoRegistry {
    function listOwners(uint120) external view returns (address);
    function addAccountToWhitelist(uint120, address) external;
}
interface IHoodiesRegistry {
    function listOwners(uint48) external view returns (address);
    function addAccountsToList(uint48, uint8, address[] calldata) external;
    function addCodeHashesToList(uint48, uint8, bytes32[] calldata) external;
}
/// @dev Hypothetical issuer permission changes ONLY in an isolated fork. Tests the full
/// live manager lifecycle after additive permissions; no transfer restrictions are removed.
contract NFTIssuerPermissionsForkTest is NFTLiveCollectionsForkTest {
    IPyoRegistry constant PYO_REGISTRY = IPyoRegistry(0xA000027A9B2802E1ddf7000061001e5c005A0000);
    IHoodiesRegistry constant HOODIES_REGISTRY = IHoodiesRegistry(0x721C008fdff27BF06E7E123956E2Fe03B63342e3);
    function _prepareCollection(address collection, address market) internal override {
        if (collection == 0x08DC7Cb3f4CcC8Eea782e2924d151e2130F22b28) {
            vm.prank(PYO_REGISTRY.listOwners(27));
            PYO_REGISTRY.addAccountToWhitelist(27, market);
        } else if (collection == 0x9Ec6C5b9f572A9B02138E553BC5F5882Da735F45) {
            address[] memory accounts = new address[](1); accounts[0] = market;
            vm.prank(HOODIES_REGISTRY.listOwners(8));
            HOODIES_REGISTRY.addAccountsToList(8, 1, accounts);
        }
    }
    function _prepareVault(address collection, address vault) internal override {
        if (collection == 0x9Ec6C5b9f572A9B02138E553BC5F5882Da735F45) {
            bytes32[] memory hashes = new bytes32[](1); hashes[0] = vault.codehash;
            vm.prank(HOODIES_REGISTRY.listOwners(8));
            HOODIES_REGISTRY.addCodeHashesToList(8, 1, hashes);
        }
    }
}
