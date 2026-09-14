import { createPublicClient, createWalletClient, defineChain, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { vaultAbi, tokenAbi } from './abi.mjs';
import {createRpcPacer,paceRpcTransport} from './rpc-pacing.mjs';

// RPC errors can include URL credentials, signed transactions and full request bodies.
// Only emit a bounded classification, never a provider's raw message or stack.
export function errorCode(error) {
  let value = error;
  for (let i = 0; value && i < 12; i++, value = value.cause) {
    if (value.data?.errorName) return String(value.data.errorName).replace(/[^a-zA-Z0-9_]/g, '').slice(0,80);
  }
  return String(error?.name ?? 'Error').replace(/[^a-zA-Z0-9_]/g, '').slice(0,80);
}
export const log = (level, event, details = {}) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details }, (_, v) => typeof v === 'bigint' ? v.toString() : v));

function comparisonError(error) {
  const details={error:errorCode(error)};
  for(let value=error,i=0;value&&i<12;i++,value=value.cause){
    if(['TimeoutError','HttpRequestError','RpcRequestError','BlockNotFoundError'].includes(value.name))details.cause=value.name;
    if(Number.isInteger(value.status))details.httpStatus=value.status;
    if(Number.isInteger(value.code))details.rpcCode=value.code;
  }
  return details;
}

export class Chain {
  constructor(config) {
    this.config = config;
    this.account = config.privateKey ? privateKeyToAccount(config.privateKey) : config.observerAddress ? {address:config.observerAddress} : undefined;
    this.definition = defineChain({ id: config.chainId, name: 'Dockyard Robinhood Chain', nativeCurrency: { name:'Ether', symbol:'ETH', decimals:18 }, rpcUrls: { default: { http: config.rpcUrls } } });
    this.providers = config.rpcUrls.map((url, i) => {
      const raw=http(url,{timeout:config.rpcTimeoutMs,retryCount:0});
      const maxRps=i>0?config.fallbackRpcMaxRps??0:0;
      const transport=maxRps?paceRpcTransport(raw,createRpcPacer(maxRps)):raw;
      return {
        name: `rpc_${i + 1}`, host: new URL(url).hostname,
        client: createPublicClient({ chain: this.definition, transport, batch: { multicall: false }, cacheTime: 0 }),
        wallet: config.privateKey ? createWalletClient({ account: this.account, chain: this.definition, transport }) : undefined,
      };
    });
    this.active = this.providers[0];
  }
  recordFailure() {
    // Only penalize a provider actually selected for this observation cycle.
    // A failed selection already records each probe failure; extending the
    // previous provider's cooldown here can otherwise prevent recovery forever.
    if (this.providers.length > 1 && this.selectedForCycle) this.active.retryAfter=Date.now()+60000;
    this.selectedForCycle=false;
  }
  async select() {
    this.selectedForCycle=false;
    this.consistent=false;
    this.consistency={status:'unavailable',providers:[]};
    const probes = await Promise.all(this.providers.map(async provider => {
      if ((provider.retryAfter ?? 0) > Date.now()) return {provider,error:'request_failure_cooldown'};
      try {
        const [chainId, block] = await Promise.all([provider.client.getChainId(), provider.client.getBlock()]);
        if (chainId !== this.config.chainId) return { provider, error: 'wrong_chain' };
        const age = BigInt(Math.floor(Date.now()/1000)) - block.timestamp;
        if (age > BigInt(this.config.maxHeadAgeSeconds) || age < -30n) return { provider, error: 'stale_head' };
        return { provider, block };
      } catch (error) { return { provider, error: errorCode(error) }; }
    }));
    const live = probes.filter(x => x.block).sort((a,b) => a.block.number > b.block.number ? -1 : a.block.number < b.block.number ? 1 : 0);
    this.probeStatus = probes.map(x => ({ name:x.provider.name, host:x.provider.host, error:x.error, block:x.block?.number }));
    if (!live.length) throw new Error('No healthy RPC');
    const newest = live[0].block.number;
    // This L2 produces subsecond blocks. A few blocks of probe timing skew are
    // normal and must not switch a healthy primary to a less reliable public RPC.
    const preferred = live.find(x => x.provider === this.providers[0] && newest - x.block.number <= this.config.maxProviderLagBlocks) ?? live[0];
    this.active = preferred.provider;
    this.selectedForCycle=true;
    // A failed comparison read is not evidence of two conflicting hashes.
    // Retry only missing reads, once, at exactly the same block; retain every
    // attempt without recording RPC URLs, raw errors or request payloads.
    this.consistent = true;
    this.consistency={status:'single_provider',providers:live.map(x=>({name:x.provider.name,host:x.provider.host}))};
    if (live.length > 1) {
      const common = live.at(-1).block.number;
      const comparisons=live.map(x=>({name:x.provider.name,host:x.provider.host,attempts:[]}));
      const read=async(index)=>{
        const result=comparisons[index];
        try {
          const block=await live[index].provider.client.getBlock({blockNumber:common});
          if(block?.number!==common||!block.hash){result.attempts.push({error:block?.number!==common?'unexpected_block':'missing_block_hash'});return;}
          result.hash=block.hash;
          result.attempts.push({hash:block.hash});
        } catch(error) {result.attempts.push(comparisonError(error));}
      };
      await Promise.all(live.map((_,index)=>read(index)));
      const conflicting=()=>new Set(comparisons.filter(x=>x.hash).map(x=>x.hash)).size>1;
      // Never retry away an observed conflict, including with three providers
      // where a different provider's comparison request also failed.
      if(!conflicting())await Promise.all(comparisons.map((x,index)=>x.hash?undefined:read(index)));
      const status=conflicting()?'hash_mismatch':comparisons.every(x=>x.hash)?'agreed':'unavailable';
      this.consistency={status,blockNumber:common,providers:comparisons};
      this.consistent=status==='agreed';
    }
    for (const p of this.probeStatus) if (p.block !== undefined && newest - p.block > this.config.maxProviderLagBlocks) p.error = 'lagging_head';
    return preferred.block;
  }
  get client() { return this.active.client; }
  get wallet() { return this.active.wallet; }
  read(functionName, args = [], blockNumber) {
    return this.client.readContract({ address: this.config.vault, abi:vaultAbi, functionName, args, blockNumber });
  }
  token(address, functionName, args = [], blockNumber) {
    return this.client.readContract({ address, abi:tokenAbi, functionName, args, blockNumber });
  }
  async verifyDeployment() {
    const [code, usdg, scale, owner, decimals] = await Promise.all([
      this.client.getCode({ address:this.config.vault }), this.read('usdg'), this.read('usdgTo18Scale'), this.read('owner'), this.token(this.config.usdg,'decimals'),
    ]);
    if (!code || code === '0x') throw new Error('Vault bytecode missing');
    this.codeHash = keccak256(code);
    if (this.config.codeHash && this.codeHash.toLowerCase() !== this.config.codeHash.toLowerCase()) throw new Error('Vault bytecode mismatch');
    const gate=await this.read('executionGate').catch(()=>undefined);
    if(Boolean(gate)!==Boolean(this.config.executionGate)||gate?.toLowerCase()!==this.config.executionGate?.toLowerCase())throw new Error('Execution gate configuration mismatch');
    if (usdg.toLowerCase() !== this.config.usdg.toLowerCase() || decimals !== 6 || scale !== 10n**12n) throw new Error('USDG configuration mismatch');
    if (this.account?.address.toLowerCase() === owner.toLowerCase()) throw new Error('Keeper must not be the vault owner');
    this.scale = scale;
    return this.codeHash;
  }
}
