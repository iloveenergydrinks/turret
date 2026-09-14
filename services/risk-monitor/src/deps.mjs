import {createRequire} from 'node:module';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
export const {createPublicClient,http,parseAbi,parseUnits,encodeAbiParameters,decodeAbiParameters,encodeFunctionData,keccak256}=require('viem');
export const {privateKeyToAccount}=require('viem/accounts');
