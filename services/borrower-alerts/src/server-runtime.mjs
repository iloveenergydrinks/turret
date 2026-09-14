import { createServer } from "node:http";
import { createPublicClient, custom } from "viem";
import { createReadRpcFallback } from "../../../shared/rpc-fallback.mjs";
import { Engine, InputError } from "./engine.mjs";
import { resolveAlertsDeployment,bindAlertsRuntime,createMonitor,alertsLinks,activateAlerts } from "./runtime.mjs";
import { Store } from "./store.mjs";
import { sendEmail } from "./resend.mjs";
import { monitorReadiness } from "./readiness.mjs";


export function createAlertsService(options = {}) {
const env = options.env ?? process.env;

const deployment = resolveAlertsDeployment(env);
const origin = new URL(env.ALERTS_APP_ORIGIN).origin;
if (!origin.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
  throw new Error("HTTPS origin required");
}
const store = options.store ?? new Store(env.ALERTS_DB_PATH ?? "/data/alerts.sqlite", env.ALERTS_DATA_KEY);
bindAlertsRuntime(store, deployment);
const rpc = createReadRpcFallback({ urls: [env.ALERTS_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  ...(env.ALERTS_FALLBACK_RPC_URLS ?? "").split(",").map(value => value.trim()).filter(Boolean)], timeoutMs: 10000 });
const client = options.client ?? createPublicClient({ transport: custom({ request: rpc.request }, { retryCount: 0 }) });
const channels = {
  email: options.channels?.email ?? Boolean(env.RESEND_API_KEY),
  telegram: options.channels?.telegram ?? Boolean(env.TELEGRAM_BOT_TOKEN && /^[a-zA-Z0-9_]+$/.test(env.TELEGRAM_BOT_USERNAME ?? "")),
};
async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error("Provider request failed");
  const data = await response.json();
  if (data.ok === false) throw new Error("Provider request rejected");
  return data;
}
const telegram = options.telegram ?? ((method, data) =>
  request(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  }));
const engine = new Engine({
  ...(options.now ? { now: options.now } : {}),
  store,
  origin,
  vault: deployment.vault,
  protocol: deployment.kind, chainId: deployment.chainId ?? 4663, scope: deployment.scope,
  ...alertsLinks(origin,deployment),
  verify: (address, message, signature) => client.verifyMessage({ address, message, signature }),
  send: options.send ?? (async (channel, contact, text, id) => {
    if (!channels[channel]) throw new Error("Channel not configured");
    if (channel === "telegram") {
      await telegram("sendMessage", { chat_id: contact, text, link_preview_options: { is_disabled: true } });
    } else {
      await sendEmail({ key: env.RESEND_API_KEY, from: env.ALERTS_EMAIL_FROM || undefined, to: contact, text, id });
    }
  }),
});
const monitor = createMonitor(engine, client, deployment);
let stopping = false, running = false, providerFailure = false;
async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    await monitor.scan();
  } catch {
    console.warn("Borrower monitor unavailable; retrying next cycle");
  }
  if (channels.telegram) {
    try {
      const offset = store.get("cursor", "telegram")?.offset ?? 0;
      const data = await telegram("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] });
      for (const update of data.result) {
        const message = update.message;
        if (message?.chat?.type === "private") {
          const start = /^\/start(?:@\w+)? ([a-f0-9]{64})$/.exec(message.text ?? "");
          if (start) {
            try {
              await activateAlerts(engine, client, deployment, start[1], "telegram", String(message.chat.id));
            } catch (error) {
              // Retry transient chain failures without consuming the Telegram update.
              if (!(error instanceof InputError)) throw error;
            }
          }
          if (/^\/stop(?:@\w+)?$/.test(message.text ?? "")) {
            for (const sub of store.all("subscription")) {
              if (sub.channel === "telegram" && sub.contact === String(message.chat.id)) {
                engine.remove(sub.wallet, "telegram");
              }
            }
          }
        }
        store.put("cursor", "telegram", { offset: update.update_id + 1 });
      }
      providerFailure = false;
    } catch {
      providerFailure = true;
      console.warn("Telegram verification polling unavailable");
    }
  }
  try {
    await engine.deliver();
    engine.prune();
  } finally {
    running = false;
  }
}
function ready() {
  return monitorReadiness(monitor, engine.now()).monitorReady;
}
async function jsonBody(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new InputError("JSON required");
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12000) throw new InputError("Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new InputError("Invalid JSON");
  }
}
const server = createServer(async (req, res) => {
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", "application/json");
  res.setHeader("x-content-type-options", "nosniff");
  if (req.headers.origin === origin) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  } else if (req.headers.origin) {
    res.writeHead(403);
    res.end("{}");
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/healthz") {
      const deliveryFailed = store.all("subscription").some((s) => s.failed) || store.all("outbox").some(job => job.attempts > 0);
      const deliveryReady = (channels.email || channels.telegram) && !providerFailure && !deliveryFailed;
      const healthy = ready() && deliveryReady;
      res.writeHead(healthy ? 200 : 503);
      res.end(JSON.stringify({ alive: true, ...monitorReadiness(monitor, engine.now()), deliveryReady }));
      return;
    }
    engine.rate(`ip:${req.socket.remoteAddress}`, 240, 60000);
    let result;
    if (req.method === "GET" && path === "/capabilities") result = { ...channels, ...monitorReadiness(monitor, engine.now()), protocol:deployment.kind, vault:deployment.vault, collateral:deployment.collateral,
      ...(['p2p','nft'].includes(deployment.kind)?{chainId:deployment.chainId,scope:deployment.scope,markets:deployment.markets}: {}) };
    else if (req.method === "POST" && path === "/challenge") {
      const body = await jsonBody(req);
      result = engine.challenge(body.wallet);
    } else if (req.method === "POST" && path === "/session") {
      const body = await jsonBody(req);
      result = await engine.login(body.id, body.signature);
    } else if (req.method === "POST" && path === "/verify") {
      const body = await jsonBody(req);
      result = await activateAlerts(engine, client, deployment, body.token, "email");
    } else {
      const wallet = engine.authenticate(req.headers.authorization?.replace(/^Bearer /, ""));
      if (req.method === "GET" && path === "/subscriptions") result = engine.list(wallet);
      else if (req.method === "POST" && path === "/subscriptions") {
        const body = await jsonBody(req);
        if (!channels[body.channel] || !monitorReadiness(monitor, engine.now()).monitorOperational) throw new InputError("Alert channel or monitor is unavailable");
        if (store.all("subscription").length + store.all("pending").length >= 100 && !store.get("subscription", `${wallet}:${body.channel}`)) {
          throw new InputError("Alert service is at capacity");
        }
        const verification = engine.subscribe(wallet, body.channel, body.email);
        result = body.channel === "telegram"
          ? { url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${verification}` }
          : { sent: true };
      } else if (req.method === "DELETE" && path === "/subscriptions") {
        const body = await jsonBody(req);
        engine.remove(wallet, body.channel);
        result = { removed: true };
      } else if (req.method === "POST" && path === "/transactions") {
        const body = await jsonBody(req);
        if (!engine.list(wallet).length) throw new InputError("No verified alert subscription");
        await monitor.watch(wallet, body.hash);
        result = { watching: true };
      } else {
        res.writeHead(404);
        res.end("{}");
        return;
      }
    }
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(error instanceof InputError ? 400 : 503);
    // Never expose RPC/provider URLs, contacts or signatures in logs or responses.
    res.end(
      JSON.stringify({ error: error instanceof InputError ? error.message : "Service unavailable. Please retry." }),
    );
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;

const startDelay=Number(env.ALERTS_START_DELAY_MS??0);
if(!Number.isInteger(startDelay)||startDelay<0||startDelay>=15000)throw new Error("Invalid alert start delay");
let interval;
const run=()=>void tick().catch(() => {
  running = false;
  console.warn("Alert cycle failed");
});
let startup;
function start(port=Number(env.PORT ?? 3030),host="0.0.0.0") {
  server.listen(port,host);
  startup=setTimeout(()=>{run();interval=setInterval(run,15000);},startDelay);
  return server;
}
function stop() {
  stopping = true;
  clearTimeout(startup);
  if(interval)clearInterval(interval);
  server.close();
}
return { server, engine, store, monitor, tick, start, stop, deployment };

}
