import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {withConsent} from './consent-html.mjs';
async function cleanup(t) { await new Promise(resolve => setImmediate(resolve)); t.observers.forEach(observer=>observer.disconnect()); t.dom.window.close(); }
const code = readFileSync(new URL('../public/turret-consent-v2.js', import.meta.url), 'utf8');
async function setup({response=false, consent={}, missing=false, early=false}={}) {
 const dom = new JSDOM('<html><body><script id="Cookiebot"></script><footer class="rusd-footer-links"></footer><p data-consent-status></p><button data-cookie-withdraw>Withdraw</button></body></html>', {url:'https://turret.capital',runScripts:'outside-only'});
 const w=dom.window, calls=[], observers=[];
 const NativeObserver=w.MutationObserver; w.MutationObserver=class extends NativeObserver { constructor(fn){super(fn);observers.push(this);} };
 if(!missing) w.Cookiebot={hasResponse:response,consent:{necessary:true,preferences:false,statistics:false,marketing:false,...consent},hide(){},withdraw(){this.hasResponse=false;this.consent={necessary:true,preferences:false,statistics:false,marketing:false};},submitCustomConsent(...values){calls.push(values);this.hasResponse=true;['preferences','statistics','marketing'].forEach((key,i)=>this.consent[key]=values[i]);w.dispatchEvent(new w.Event('CookiebotOnConsentReady'));}};
 w.eval(code);
 if(early) w.dispatchEvent(new w.Event('CookiebotOnDialogDisplay'));
 await new Promise(resolve=>w.addEventListener('load',resolve,{once:true}));
 const q=s=>w.document.querySelector(s), click=s=>q(s).click();
 return {w,dom,q,click,calls,observers};
}
test('first visit is compact and does not grant consent; rejection saves all optional off',async()=>{
 const t=await setup({early:true});assert.equal(t.q('#turret-consent').hidden,false);assert.equal(t.q('[data-consent-details]').hidden,true);assert.deepEqual(t.calls,[]);t.click('[data-consent-reject]');assert.deepEqual(t.calls,[[false,false,false]]);assert.equal(t.q('#turret-consent').hidden,true);await cleanup(t);
});
test('accept all and footer reopen preserve choices; custom save changes only selected categories',async()=>{
 const t=await setup();t.click('[data-consent-accept]');assert.deepEqual(t.calls,[[true,true,true]]);t.q('[data-cookie-settings]').focus();t.click('[data-cookie-settings]');assert.equal(t.q('[data-consent-details]').hidden,false);assert.equal(t.q('[name=statistics]').checked,true);t.q('[name=marketing]').checked=false;t.q('[name=preferences]').checked=false;t.click('[data-consent-save]');assert.deepEqual(t.calls[1],[false,true,false]);assert.equal(t.w.document.activeElement,t.q('[data-cookie-settings]'));await cleanup(t);
});
test('returning visitor stays dismissed until explicitly reopened; withdrawal removes consent',async()=>{
 const t=await setup({response:true,consent:{statistics:true}});assert.equal(t.q('#turret-consent').hidden,true);assert.equal(t.w.document.documentElement.classList.contains('turret-consent-ready'),true);t.click('[data-cookie-settings]');assert.equal(t.q('[name=statistics]').checked,true);t.click('[data-cookie-withdraw]');assert.equal(t.q('[name=statistics]').checked,false);assert.equal(t.w.Cookiebot.hasResponse,false);assert.deepEqual(t.calls,[]);await cleanup(t);
});
test('missing SDK keeps fallback available and reports failure; submit errors remain visible',async()=>{
 const t=await setup({missing:true});assert.equal(t.q('#turret-consent').hidden,true);assert.equal(t.w.document.documentElement.classList.contains('turret-consent-ready'),false);t.click('[data-cookie-settings]');assert.match(t.q('[data-consent-status]').textContent,/could not load/);await cleanup(t);
 const e=await setup();e.w.Cookiebot.submitCustomConsent=()=>{throw new Error('blocked')};e.click('[data-consent-reject]');assert.equal(e.q('#turret-consent').hidden,false);assert.equal(e.q('[data-consent-error]').hidden,false);await cleanup(e);
});
test('late SDK display opens custom panel and repeat events do not duplicate footer controls',async()=>{
 const t=await setup({missing:true});t.w.Cookiebot={hasResponse:false,consent:{},hide(){},submitCustomConsent(){}};t.w.dispatchEvent(new t.w.Event('CookiebotOnDialogDisplay'));assert.equal(t.q('#turret-consent').hidden,false);t.w.document.body.append(t.w.document.createElement('div'));await Promise.resolve();assert.equal(t.w.document.querySelectorAll('[data-cookie-settings]').length,1);await cleanup(t);
});
test('HTML keeps automatic blocking first, loads versioned custom UI and remains idempotent',()=>{
 const html=withConsent('<html><head><title>T</title></head><body></body></html>');assert.match(html,/<head><style id="turret-consent-boot"/);assert.equal(new JSDOM(html).window.document.querySelector('script').id,'Cookiebot');assert.match(html,/data-blockingmode="auto"/);assert.match(html,/data-turret-consent-ui/);assert.equal(withConsent(html),html);assert.doesNotMatch(withConsent('<head></head><body></body>','blog.turret.capital'),/id="Cookiebot"/);
});
