import {timingSafeEqual} from 'node:crypto';

export function weekendHttpResponse(path,authorization,token,observer){
 if(path==='/weekend/status')return {status:200,body:observer.publicSnapshot()};
 if(path!=='/weekend/observations')return null;
 const actual=Buffer.from(authorization??''),expected=Buffer.from(`Bearer ${token}`);
 if(typeof token!=='string'||token.length<32||actual.length!==expected.length||!timingSafeEqual(actual,expected))return {status:401,body:{}};
 return {status:200,body:observer.snapshot()};
}
