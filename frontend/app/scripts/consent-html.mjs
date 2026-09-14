// Shared by the exported app and independently released lending bundles.
import { existsSync, readFileSync } from "node:fs";
function consentAsset(name) {
  const source = new URL(`../public/${name}`, import.meta.url);
  return readFileSync(existsSync(source) ? source : new URL(`../out/${name}`, import.meta.url), "utf8");
}
const consentCSS = consentAsset("turret-consent-v2.css");
const consentJS = consentAsset("turret-consent-v2.js");
export const COOKIEBOT_ID = "e5a67346-536b-4072-96c7-2737cfa18f6a";
export function withConsent(html, hostname = "turret.capital") {
  if (html.includes('id="Cookiebot"')) return html;
  const supported = ["turret.capital", "www.turret.capital", "localhost", "127.0.0.1"].includes(hostname);
  const consent = supported ? `<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="${COOKIEBOT_ID}" data-blockingmode="auto" data-culture="EN" data-consentmode="disabled"></script>` : "";
  const origin = supported ? "" : "https://turret.capital";
  // The native banner can render while a following external stylesheet/script is
  // still downloading. Guard its first paint and inline the small custom UI so
  // takeover has no extra network dependency. Cookiebot remains the first script.
  const guard = supported ? '<style id="turret-consent-boot">html #CybotCookiebotDialog,html #CybotCookiebotDialogBodyUnderlay,html #CookiebotWidget{visibility:hidden!important;pointer-events:none!important}</style>' : '';
  const fallback = supported ? '<script data-cookieconsent="ignore">window.addEventListener("error",function(event){if(event.filename?.endsWith("turret-consent-inline.js"))document.getElementById("turret-consent-boot")?.remove();});</script>' : '';
  const assets = supported
    ? `<style data-turret-consent-theme>${consentCSS}</style>${consent}${fallback}<script data-cookieconsent="ignore" data-turret-consent-ui>${consentJS}\n//# sourceURL=turret-consent-inline.js\n</script>`
    : `<link rel="stylesheet" href="${origin}/turret-consent-v2.css"><script data-cookieconsent="ignore" src="${origin}/turret-consent-v2.js"></script>`;
  return html.replace(/<head(?:\s[^>]*)?>/i, `$&${guard}${assets}`);
}
