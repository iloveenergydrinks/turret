import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
export default {root:here,publicDir:'../../public',envDir:false,css:{postcss:{plugins:[]}},plugins:[{name:'illustrative-preview-only',enforce:'pre',resolveId(id){
 if(id.endsWith('/p2p/client'))return here+'client.ts';
 if(id.endsWith('/wallet/useWalletSession'))return here+'wallet.tsx';
 if(id.endsWith('/comps/AppLayout/AccountButton'))return here+'wallet.tsx';
}},react()],server:{host:'127.0.0.1',port:18649,strictPort:true},build:{outDir:'../../../../output/p2p-ux-negotiations-20260909/preview-build',emptyOutDir:true}};
