import { expect, test } from 'vitest';
import { nftErrorText } from './errors';
test('handles wallet rejection and pending requests nested in RPC wrappers',()=>{
 expect(nftErrorText({message:'RPC failure',data:{originalError:{code:4001,message:'User rejected'}}})).toContain('Wallet request declined');
 expect(nftErrorText({cause:{code:-32002}})).toContain('already open in your wallet');
});
test('preserves useful plain-object errors and bounds unknown messages',()=>{
 expect(nftErrorText({message:'Insufficient funds for gas'})).toBe('Insufficient funds for gas');
 expect(nftErrorText({shortMessage:'Contract reverted',message:'long stack'})).toBe('Contract reverted');
 const error:any={};error.cause=error;
 expect(nftErrorText(error)).toContain('Check your wallet’s activity');
 expect(nftErrorText({message:'x'.repeat(1000)})).toHaveLength(360);
});
