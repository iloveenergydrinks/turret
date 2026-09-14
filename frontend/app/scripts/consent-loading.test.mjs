import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM,ResourceLoader,VirtualConsole} from 'jsdom';
import {readFileSync} from 'node:fs';
import {withConsent} from './consent-html.mjs';
const js=readFileSync(new URL('../public/turret-consent-v2.js',import.meta.url));
const css=readFileSync(new URL('../public/turret-consent-v2.css',import.meta.url));
class ConsentResources extends ResourceLoader {
 fetch(url) {
  if(url.endsWith('/uc.js')) return Promise.resolve(Buffer.from(`
   const native=document.createElement('div'); native.id='CybotCookiebotDialog'; native.textContent='Large native banner'; document.documentElement.append(native);
   window.nativeWasVisible=getComputedStyle(native).display!=='none'&&getComputedStyle(native).visibility!=='hidden';
   window.Cookiebot={hasResponse:false,consent:{},hide(){native.hidden=true;},submitCustomConsent(){}};
  `));
  // Force the exact race: Cookiebot paints before the separately fetched custom UI arrives.
  if(url.endsWith('turret-consent-v2.js')) return new Promise(resolve=>setTimeout(()=>resolve(js),40));
  if(url.endsWith('turret-consent-v2.css')) return new Promise(resolve=>setTimeout(()=>resolve(css),40));
  return null;
 }
}
test('native dialog never becomes visible while compact UI initializes',async()=>{
 const dom=new JSDOM(withConsent('<!doctype html><html><head></head><body><footer class="rusd-footer-links"></footer></body></html>'),{url:'https://turret.capital',runScripts:'dangerously',resources:new ConsentResources(),virtualConsole:new VirtualConsole()});
 await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
 try {
  assert.equal(dom.window.nativeWasVisible,false,'Large Cookiebot dialog was visible before compact UI initialized');
  assert.equal(dom.window.document.querySelector('#turret-consent')?.hidden,false,'Compact panel must appear');
 } finally {dom.window.close();}
});

 test('a failed custom UI falls back to usable native consent controls',async()=>{
  const html=withConsent('<!doctype html><html><head></head><body></body></html>').replace(/<script data-cookieconsent="ignore" data-turret-consent-ui>[\s\S]*?<\/script>/,'<script data-cookieconsent="ignore" data-turret-consent-ui>throw new Error("custom initialization failure");\n//# sourceURL=turret-consent-inline.js\n</script>');
  const dom=new JSDOM(html,{url:'https://turret.capital',runScripts:'dangerously',resources:new ConsentResources(),virtualConsole:new VirtualConsole()});
  await new Promise(resolve=>dom.window.addEventListener('load',resolve,{once:true}));
  try {
   assert.equal(dom.window.document.getElementById('turret-consent-boot'),null);
   assert.notEqual(dom.window.getComputedStyle(dom.window.document.getElementById('CybotCookiebotDialog')).visibility,'hidden');
  } finally {dom.window.close();}
 });
test('late Cookiebot initialization remains hidden after the page load event',async()=>{
 class LateSDK extends ConsentResources {
  fetch(url) {
   if(!url.endsWith('/uc.js'))return super.fetch(url);
   return Promise.resolve(Buffer.from(`window.addEventListener('load',()=>setTimeout(()=>{
    const native=document.createElement('div');native.id='CybotCookiebotDialog';document.body.append(native);
    window.nativeWasVisible=getComputedStyle(native).visibility!=='hidden';
    window.Cookiebot={hasResponse:false,consent:{},hide(){native.hidden=true;},submitCustomConsent(){}};
    window.dispatchEvent(new Event('CookiebotOnDialogDisplay'));
    window.dispatchEvent(new Event('test-sdk-ready'));
   },10));`));
  }
 }
 const dom=new JSDOM(withConsent('<!doctype html><html><head></head><body></body></html>'),{url:'https://turret.capital',runScripts:'dangerously',resources:new LateSDK(),virtualConsole:new VirtualConsole()});
 await new Promise(resolve=>dom.window.addEventListener('test-sdk-ready',resolve,{once:true}));
 try{assert.equal(dom.window.nativeWasVisible,false,'Late SDK must not reveal the native dialog');assert.equal(dom.window.document.querySelector('#turret-consent').hidden,false);}finally{dom.window.close();}
});
