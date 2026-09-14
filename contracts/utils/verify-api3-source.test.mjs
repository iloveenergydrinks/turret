import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyApi3NativeSource} from './verify-api3-source.mjs';

test('API3 source verification refuses wrong chains and runtimes before fetching or compiling',async()=>{
  const fetcher=async()=>assert.fail('Source fetch forbidden');
  await assert.rejects(verifyApi3NativeSource({client:{getChainId:async()=>1},solcPath:'/not-used',fetcher}),/WrongApi3SourceChain/);
  const client={getChainId:async()=>4663,getBlock:async()=>({number:1n,hash:'0x'+'a'.repeat(64),timestamp:1n}),getCode:async()=>'0x00'};
  await assert.rejects(verifyApi3NativeSource({client,solcPath:'/not-used',fetcher}),/Api3SourceRuntimeChanged/);
  await assert.rejects(verifyApi3NativeSource({client,solcPath:'',fetcher}),/Api3CompilerRequired/);
});
