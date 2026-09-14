import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),publicDir:fileURLToPath(new URL('../../public',import.meta.url)),plugins:[react()],resolve:{alias:{'@':fileURLToPath(new URL('../..',import.meta.url))}},server:{host:'127.0.0.1',port:18671,strictPort:true,fs:{allow:[fileURLToPath(new URL('../../../..',import.meta.url))]}}});
