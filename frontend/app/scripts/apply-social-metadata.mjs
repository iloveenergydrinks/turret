import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
export const SOCIAL_IMAGE='https://turret.capital/brand/turret-social-engraving-20260909.png';
const alt='Turret: Keep your tokens. Borrow USDG. Architectural turret engraving on warm paper.';
const description='Borrow USDG against supported stock tokens, silver tokens and memecoins on Robinhood Chain. Keep your market exposure.';
const esc=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const routes={
 '/':['Turret | Borrow against your assets',description],
 '/borrow':['Borrow | Turret',description],
 '/borrow/pools':['Lending pools | Turret',description],
 '/borrow/p2p':['P2P stock and token loans | Turret','Borrow or lend USDG with terms agreed directly between people on Robinhood Chain.'],
 '/borrow/nfts':['NFT P2P lending | Turret','NFT-backed USDG loans on Robinhood Chain. Coming soon.'],
 '/earn':['Earn | Turret','Supply USDG to lending pools and stake lender shares for TURRET rewards on Robinhood Chain.'],
 '/portfolio':['Portfolio | Turret','Manage your loans, lending positions and rewards on Turret.'],
};
export function rewriteSocialMetadata(html,route){
 html=html.replaceAll('https://dockyard.finance/brand/dockyard-social-v1.png',SOCIAL_IMAGE)
 .replaceAll('https://turret.capital/brand/dockyard-social-v1.png',SOCIAL_IMAGE)
 .replaceAll('Dockyard: Borrow USDG. Keep your Stock Tokens. AAPL, NVDA, TSLA and more, on a sea-glass background.',alt);
 // Fix fallback cards on every exported page while retaining article-specific images.
 html=html.replace(/<meta\b[^>]*(?:property|name)=["'](?:og:|twitter:)[^>]*>/gi,tag=>tag.replace(/Dockyard/g,'Turret').replace(/content="1774"/g,'content="1200"').replace(/content="887"/g,'content="600"'));
 if(!routes[route])return html;
 const[title,copy]=routes[route];
 html=html.replace(/<meta\b[^>]*(?:property|name)=["'](?:og:|twitter:)[^>]*>/gi,'')
 .replace(/<meta\b[^>]*name=["']description["'][^>]*>/gi,'')
 .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi,'').replace(/<title>[^<]*<\/title>/i,`<title>${esc(title)}</title>`);
 const tags=[['name','description',copy],['property','og:type','website'],['property','og:site_name','Turret'],['property','og:title',title],['property','og:description',copy],['property','og:url','https://turret.capital'+route],['property','og:image',SOCIAL_IMAGE],['property','og:image:width','1200'],['property','og:image:height','600'],['property','og:image:type','image/png'],['property','og:image:alt',alt],['name','twitter:card','summary_large_image'],['name','twitter:site','@turret_capital'],['name','twitter:title',title],['name','twitter:description',copy],['name','twitter:image',SOCIAL_IMAGE],['name','twitter:image:alt',alt]].map(([attribute,key,value])=>`<meta ${attribute}="${key}" content="${esc(value)}"/>`).join('');
 return html.replace('</head>',`${tags}<link rel="canonical" href="https://turret.capital${route}"/></head>`);
}
export async function applySocialMetadata(root){let changed=0;
 async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=join(dir,entry.name);if(entry.isDirectory()){if(!entry.name.startsWith('_next'))await walk(file);continue;}if(!/\.(html|txt)$/.test(entry.name))continue;const source=await readFile(file,'utf8'),name=relative(root,file).replaceAll('\\','/');let route='/'+name.replace(/\.html$/,'');if(['index.html','borrow-unified.html','borrow-unified-assets/index.html'].includes(name))route='/';const next=rewriteSocialMetadata(source,route);if(next!==source){await writeFile(file,next);changed++;}}}
 await walk(root);return changed;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)console.log(JSON.stringify({changed:await applySocialMetadata(resolve(process.argv[2]||new URL('../out',import.meta.url).pathname))}));
