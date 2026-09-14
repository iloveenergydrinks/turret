import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const app=fileURLToPath(new URL('../..',import.meta.url));
export default {
  root:fileURLToPath(new URL('.',import.meta.url)),publicDir:`${app}/public`,plugins:[react()],
  resolve:{alias:{'@':app}},
  server:{host:'127.0.0.1',port:4301,strictPort:true,proxy:{'/api':{target:'https://turret.capital',changeOrigin:true,headers:{origin:'https://turret.capital'}}}},
  build:{outDir:fileURLToPath(new URL('../../../../output/memecoin-switch-20260912/browser-build',import.meta.url)),emptyOutDir:true},
};
