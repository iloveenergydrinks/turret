import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default {root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react()],server:{host:'127.0.0.1',port:3047,strictPort:true}};
