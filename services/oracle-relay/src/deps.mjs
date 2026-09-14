// Reuse the pinned keeper runtime; Docker installs its frozen lockfile at /app.
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../liquidator/package.json',import.meta.url));
export const {createPublicClient,http,parseAbi,encodeFunctionData,decodeFunctionResult,decodeAbiParameters,encodeAbiParameters,encodePacked,recoverMessageAddress,keccak256,parseEther}=require('viem');
