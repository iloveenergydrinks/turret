import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { publicJson } from './store.mjs';

export function authorized(request, token) {
  if (!token) return false;
  const supplied=Buffer.from(request.headers.authorization ?? '');
  const expected=Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied,expected);
}
export function createStatusServer(config,getStatus) {
  return createServer((request,response) => {
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Type','application/json');
    response.setHeader('X-Content-Type-Options','nosniff');
    if (request.method !== 'GET') {response.writeHead(405);response.end();return;}
    const status=getStatus();
    const alive=Date.now()-status.lastProgress < config.heartbeatMaxAgeMs;
    if (request.url === '/healthz') {
      response.writeHead(alive ? 200:503); response.end(JSON.stringify({alive})); return;
    }
    if (!authorized(request,config.statusToken)) { response.writeHead(401);response.end('{"error":"unauthorized"}');return; }
    if (request.url === '/status' || request.url === '/readyz') {
      const operational=alive && status.snapshot?.reconciled && status.snapshot?.mode === 'execute'
        && !status.lastError && !status.snapshot.incidents.some(x=>x.severity === 'critical')
        && status.alertDelivery?.configured && status.alertDelivery?.delivered;
      response.writeHead(request.url === '/readyz' && !operational ? 503:200);
      response.end(publicJson({alive,operational:Boolean(operational),...status})); return;
    }
    if (request.url === '/metrics') {
      response.setHeader('Content-Type','text/plain; version=0.0.4');
      const s=status.snapshot;
      response.end([
        `dockyard_keeper_alive ${alive ? 1:0}`,
        `dockyard_keeper_reconciled ${s?.reconciled ? 1:0}`,
        `dockyard_keeper_last_success_seconds ${(s?.checkedAt ?? 0)/1000}`,
        `dockyard_keeper_open_positions ${s?.openPositions ?? 0}`,
        `dockyard_keeper_unhealthy_positions ${s?.unhealthyPositions ?? 0}`,
        `dockyard_keeper_critical_incidents ${s?.incidents.filter(x=>x.severity === 'critical').length ?? 0}`,
        `dockyard_keeper_rpc_failover ${s?.activeRpc && s.activeRpc !== 'rpc_1' ? 1:0}`,
        '',
      ].join('\n'));return;
    }
    response.writeHead(404);response.end('{}');
  });
}
