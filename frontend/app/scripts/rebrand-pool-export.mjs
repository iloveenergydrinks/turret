// Rebrand a frozen pool export without changing contract identities or signed messages.
import assert from 'node:assert/strict';
import {legacyBrandReplacements} from './release-branding.mjs';
import {readFile,writeFile,readdir,mkdir,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [out,oldNamespace,report]=process.argv.slice(2);assert(out&&oldNamespace&&report,'Usage: node rebrand-pool-export.mjs OUT OLD_NAMESPACE REPORT');
const replacements=legacyBrandReplacements;
const digest=createHash('sha256').update(JSON.stringify(replacements)).digest('hex').slice(0,16),namespace='_next-pool-brand-'+digest;
assert(namespace!==oldNamespace);
await cp(join(out,oldNamespace),join(out,namespace),{recursive:true,errorOnExist:true,force:false});
async function files(dir){const entries=await readdir(dir,{withFileTypes:true});return(await Promise.all(entries.map(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]))).flat();}
const changes=[];
for(const path of [...await files(join(out,namespace)),...['borrow.html','earn.html','borrow.txt','earn.txt'].map(n=>join(out,n))]){
 if(!/\.(?:js|css|json|html|txt)$/.test(path))continue;
 const before=await readFile(path,'utf8');let after=before;const counts=[];
 for(const[from,to]of replacements){const count=after.split(from).length-1;if(count){after=after.replaceAll(from,to);counts.push({from,to,count});}}
 after=after.replaceAll(oldNamespace,namespace);
 // These names are part of the existing on-chain/signature protocol, not UI branding.
 for(const protectedText of ['DockyardBorrowIntent','DockyardOperatorPriceFeed','requests Dockyard borrower alert access.'])assert.equal(after.split(protectedText).length,before.split(protectedText).length);
 if(after!==before){await writeFile(path,after);changes.push({file:path.slice(out.length+1),replacements:counts,namespaceChanged:before.includes(oldNamespace)});}
}
await mkdir(report,{recursive:true});await writeFile(join(report,'branding-changes.json'),JSON.stringify({oldNamespace,namespace,changes},null,2));console.log(JSON.stringify({namespace,changedFiles:changes.length}));
