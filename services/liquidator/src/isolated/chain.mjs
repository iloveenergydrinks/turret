import { keccak256, parseAbi } from 'viem';
import { Chain } from '../chain.mjs';
import { isolatedAbi, capitalAbi, exitAbi, MARKET_HEALTH_TYPEHASH } from './abi.mjs';
import { fetchLiveness } from '../liveness.mjs';
import {verifyDependencyPins} from './dependencies.mjs';
const guardAbi=parseAbi(['function collateral() view returns(address)','function primaryOracle() view returns(address)','function guardian() view returns(address)']);
const gateAbi=parseAbi(['function guardian() view returns(address)','function MAX_LIFETIME() view returns(uint256)','function RECOVERY_DELAY() view returns(uint256)']);

const same = (a,b) => a.toLowerCase() === b.toLowerCase();
export class IsolatedChain extends Chain {
  async stockLiveness() { return fetchLiveness(this.config); }
  async stockPrice(blockNumber,liveness) {
    return (await this.client.simulateContract({address:this.config.vault,abi:isolatedAbi,functionName:'priceWithLiveness',
      args:[liveness],blockNumber})).result;
  }
  async stockQuote(borrower,maximum,blockNumber,liveness) {
    return (await this.client.simulateContract({address:this.config.vault,abi:isolatedAbi,functionName:'liquidationQuoteWithLiveness',
      args:[borrower,maximum,liveness],blockNumber})).result;
  }
  read(functionName, args = [], blockNumber) {
    return this.client.readContract({address:this.config.vault, abi:isolatedAbi, functionName, args, blockNumber});
  }
  capital(functionName, args = [], blockNumber) {
    return this.client.readContract({address:this.config.pool, abi:capitalAbi, functionName, args, blockNumber});
  }
  async verifyDeployment(blockNumber) {
    const bindings=await this.verifyBindings(blockNumber);
    if(this.account && same(bindings.owner,this.account.address))throw new Error('Keeper must not be the engine guardian');
    if(this.account && bindings.guardian && same(bindings.guardian,this.account.address))throw new Error('Stock dependency binding mismatch');
    return true;
  }
  // Shared read-only wiring verification. Callers must separately enforce their
  // signer role: a risk guardian is intentionally not a liquidation keeper.
  async verifyBindings(blockNumber) {
    const c=this.config;
    // Recheck immutable deployment bindings each scan and before a fresh send.
    // Code hashes alone cannot prove oracle data independence or proxy storage.
    for (const [address, expected] of [[c.vault,c.codeHash],[c.pool,c.poolCodeHash],
      [c.collateral,c.collateralCodeHash],[c.primary,c.primaryCodeHash],[c.secondary,c.secondaryCodeHash]]) {
      const code=await this.client.getCode({address,blockNumber});
      if (!code || code==='0x' || !same(keccak256(code),expected)) throw new Error('Isolated runtime mismatch');
    }
    const [usdg,collateral,pool,primary,secondary,owner,cap,asset,poolToken,engine,cashDecimals,tokenDecimals]=await Promise.all([
      this.read('usdg',[],blockNumber),this.read('collateralToken',[],blockNumber),this.read('pool',[],blockNumber),
      this.read('primary',[],blockNumber),this.read('secondary',[],blockNumber),this.read('owner',[],blockNumber),
      this.read('MAX_ACTIVE_POSITIONS',[],blockNumber),this.capital('asset',[],blockNumber),
      this.capital('collateralToken',[],blockNumber),this.capital('creditEngine',[],blockNumber),
      this.token(c.usdg,'decimals',[],blockNumber),this.token(c.collateral,'decimals',[],blockNumber),
    ]);
    if (!same(usdg,c.usdg) || !same(collateral,c.collateral) || !same(pool,c.pool)
      || !same(primary,c.primary) || !same(secondary,c.secondary) || same(primary,secondary)
      || !same(asset,c.usdg) || !same(poolToken,c.collateral) || !same(engine,c.vault)
      || cashDecimals!==6 || tokenDecimals!==18 || cap!==64n) throw new Error('Isolated deployment binding mismatch');
    const actualGate=await this.read('executionGate',[],blockNumber).catch(()=>undefined);
    if(Boolean(actualGate)!==Boolean(c.stock)||actualGate&& !same(actualGate,c.executionGate))throw new Error('Stock execution gate binding mismatch');
    if(c.stock){
      const s=c.stock;
      await verifyDependencyPins(this.client,s.dependencies??[],blockNumber);
      if(!same(await this.read('MARKET_HEALTH_TYPEHASH',[],blockNumber),MARKET_HEALTH_TYPEHASH))throw new Error('Stock market authorization mismatch');
      for(const [address,expected] of [[c.executionGate,s.executionGateCodeHash],[c.usdg,s.usdgCodeHash],
        [s.usdgPrimary,s.usdgPrimaryCodeHash],[s.usdgSecondary,s.usdgSecondaryCodeHash]]){
        const code=await this.client.getCode({address,blockNumber});
        if(!code||code==='0x'||!same(keccak256(code),expected))throw new Error('Stock dependency runtime mismatch');
      }
      const read=(address,abi,functionName)=>this.client.readContract({address,abi,functionName,blockNumber});
      const [guard,a,b,guardToken,guardFeed,guardSigner,gateSigner,age,delay]=await Promise.all([
        this.read('stockGuard',[],blockNumber),this.read('usdgPrimary',[],blockNumber),this.read('usdgSecondary',[],blockNumber),
        read(c.secondary,guardAbi,'collateral'),read(c.secondary,guardAbi,'primaryOracle'),read(c.secondary,guardAbi,'guardian'),
        read(c.executionGate,gateAbi,'guardian'),read(c.executionGate,gateAbi,'MAX_LIFETIME'),read(c.executionGate,gateAbi,'RECOVERY_DELAY'),
      ]);
      if(!same(guard,c.secondary)||!same(a,s.usdgPrimary)||!same(b,s.usdgSecondary)||!same(guardToken,c.collateral)
        ||!same(guardFeed,c.primary)||!same(guardSigner,s.guardian)||!same(gateSigner,s.guardian)||age!==45n||delay!==120n)throw new Error('Stock dependency binding mismatch');
    }
    if (c.executor) {
      const code=await this.client.getCode({address:c.executor,blockNumber});
      if (!code || !same(keccak256(code),c.executorCodeHash)) throw new Error('Exit runtime mismatch');
      const read=functionName=>this.client.readContract({address:c.executor,abi:exitAbi,functionName,blockNumber});
      const [exitEngine,exitCash,exitToken,healthy]=await Promise.all(['engine','usdg','collateral','routeHealthy'].map(read));
      if (!same(exitEngine,c.vault) || !same(exitCash,c.usdg) || !same(exitToken,c.collateral) || !healthy) throw new Error('Exit route binding mismatch');
      if(c.stock&&!same(await read('executionGate'),c.executionGate))throw new Error('Stock exit gate binding mismatch');
    }
    this.codeHash=c.codeHash;
    return {owner,guardian:c.stock?.guardian};
  }
}
