import { cpSync,mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const staging=mkdtempSync(join(tmpdir(),'dockyard-watchdog-deploy-'));
try {
  for(const name of ['package.json','pnpm-lock.yaml','Dockerfile','src']) cpSync(join(root,name),join(staging,name),{recursive:true});
  // Separate entry point also works when Railway ignores legacy config files.
  const dockerfile=readFileSync(join(staging,'Dockerfile'),'utf8');
  writeFileSync(join(staging,'Dockerfile'),dockerfile.replace('src/main.mjs','src/watchdog.mjs'));
  const result=spawnSync('railway',['up',staging,'--path-as-root','--service','dockyard-keeper-watchdog','--project',process.env.RAILWAY_PROJECT_ID ?? 'edf06c48-4331-4fd1-bf0c-04619089a315','--environment','production','--detach','--message','Deploy independent keeper watchdog with persistent incident deduplication'],{stdio:'inherit',cwd:root});
  process.exitCode=result.status ?? 1;
} finally {rmSync(staging,{recursive:true,force:true});}
