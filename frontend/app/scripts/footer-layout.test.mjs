import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {withFooter} from './footer-html.mjs';
const asset = name => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const fixture = `<footer class="rusd-footer"><section class="turret-technology">Technology</section><div class="rusd-footer-inner"><span>Independent collateral lending protocol · Robinhood Chain mainnet</span><div class="rusd-footer-links"><a href="https://x.com/turret_capital">X</a><a href="mailto:support@turret.capital">support@turret.capital</a><a href="https://blog.turret.capital/">Blog</a><a href="https://docs.turret.capital/">Documentation</a><a href="/terms">Terms</a><a href="https://docs.turret.capital/platform/risks">Risk</a><a href="/agent-brief.md">Agent brief</a><button id="about">About</button></div></div></footer>`;
test('legacy shell retains controls, groups late consent links and stays stable across updates', async () => {
 const dom = new JSDOM(`<html><head><script id="Cookiebot"></script></head><body>${fixture}</body></html>`, {url:'https://turret.capital',runScripts:'outside-only'});
 const w=dom.window, d=w.document; let about=0, writes=0;const observers=[];
 const Native=w.MutationObserver;w.MutationObserver=class extends Native {constructor(fn){super((...args)=>{writes++;fn(...args)});observers.push(this)}};
 d.querySelector('#about').addEventListener('click',()=>about++);
 w.eval(asset('turret-footer-v2.js'));w.eval(asset('turret-footer-legal-v1.js'));w.eval(asset('turret-consent-v2.js'));
 await new Promise(resolve=>w.addEventListener('load',resolve,{once:true}));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(d.querySelectorAll('.turret-footer-contact a').length,2);
 assert.deepEqual([...d.querySelectorAll('.turret-footer-legal a,.turret-footer-legal button')].map(n=>n.textContent),['Terms','Risk','Privacy','Cookies','Cookie settings']);
 assert.equal(d.querySelectorAll('a[href="https://x.com/turret_capital"]').length,1);
 assert.ok(d.querySelector('.turret-footer-brand > .turret-technology'));
 d.querySelector('#about').click(); assert.equal(about,1);
 // The footer can remount when switching independently rendered surfaces.
 d.querySelector('footer').remove();d.body.insertAdjacentHTML('beforeend',fixture);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(d.querySelectorAll('.turret-footer-legal').length,1);
 assert.equal(d.querySelectorAll('[data-cookie-settings]').length,1);
 assert.ok(writes<20,`observer churn: ${writes}`);
 observers.forEach(o=>o.disconnect());w.close();
});
test('shared footer HTML preserves Cookiebot order and is injected once',()=>{
 const base='<html><head><script id="Cookiebot"></script></head><body></body></html>';
 const html=withFooter(base);const d=new JSDOM(html).window.document;
 assert.equal(d.querySelector('script').id,'Cookiebot');
 assert.equal(d.querySelectorAll('[data-turret-footer-layout]').length,1);
 assert.equal(withFooter(html),html);
});
