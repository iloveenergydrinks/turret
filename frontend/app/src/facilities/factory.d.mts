import type { Address, Abi, PublicClient } from 'viem';
import type { TokenBaseline } from '../p2p/health-core.mjs';
import type { FacilityMarket } from './ui-model';
export type StandingCollateral = {address:Address;symbol:string;name:string;decimals:number;logo?:string;category?:string};
export type FactoryConfig = {schemaVersion:1;chainId:number;factory:Address;runtimeHash:`0x${string}`;loanToken:Address;startBlock:string;collateral:StandingCollateral[];baseline:TokenBaseline};
export const factoryAbi:Abi;
export function validateFactoryConfig(config:unknown):FactoryConfig;
export function verifyFactory(client:any,config:FactoryConfig,options?:any):Promise<any>;
export function readFactoryFacility(client:any,config:FactoryConfig,address:Address,options?:{clock?:()=>number;qualify?:boolean}):Promise<{entry:FacilityMarket;creationHash:string;checkedAt:number}>;
