import test from 'node:test';
import assert from 'node:assert/strict';
import {serveStandingConfig} from './standing-config-response.mjs';
const invoke=(config,method='GET',url='/standing-offers.json')=>{
 const captured={resumed:false};const request={url,method,resume(){captured.resumed=true;}};
 const response={writeHead(status,headers){Object.assign(captured,{status,headers});return this;},end(body){captured.body=body;}};
 captured.handled=serveStandingConfig(request,response,config,{'x-frame-options':'DENY'});return captured;
};
test('inactive factory responds as uncached JSON 404 instead of HTML redirect',()=>{
 const value=invoke(null);assert.equal(value.status,404);assert.equal(value.headers['cache-control'],'no-store');assert.equal(value.headers['x-frame-options'],'DENY');assert.equal(value.headers['content-length'],Buffer.byteLength(value.body));assert.match(value.body,/not active/);assert.equal(value.resumed,true);
});
test('active configuration and HEAD share headers without sending a HEAD body',()=>{
 const config={schemaVersion:1,factory:'test'};const get=invoke(config),head=invoke(config,'HEAD');assert.equal(get.status,200);assert.deepEqual(JSON.parse(get.body),config);assert.equal(head.body,undefined);assert.deepEqual(head.headers,get.headers);
});
test('other paths pass through and writes are rejected',()=>{
 assert.deepEqual(invoke(null,'GET','/borrow'),{resumed:false,handled:false});const post=invoke({},'POST');assert.equal(post.status,405);assert.equal(post.headers.allow,'GET, HEAD');
});
