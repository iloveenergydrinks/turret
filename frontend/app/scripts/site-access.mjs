import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
const cookieName = "turret_access";
const lifetime = 8 * 60 * 60;
const publicAssets = new Set(["/brand/turret-mark.svg", "/fonts/turret-editorial/caslon-regular.woff2"]);
const escape = value => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const returnPath = value => typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !/[\\\x00-\x20]/.test(value) && value.length <= 1024 && !value.startsWith("/__access/") ? value : "/";

export async function hashSitePassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = await derive(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

function page(next = "/", error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Coming soon | Turret</title><link rel="icon" href="/brand/turret-mark.svg"><style>
@font-face{font-family:"Libre Caslon Text";src:url('/fonts/turret-editorial/caslon-regular.woff2') format('woff2');font-display:swap;font-weight:400}
*{box-sizing:border-box}html{background:#fafaf9;color:#292524}body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{min-height:calc(100svh - 48px);display:grid;place-items:center;padding:40px 24px}.access{width:100%;max-width:400px;text-align:center}.brand{display:flex;align-items:center;justify-content:center;gap:10px;font-family:"Libre Caslon Text",Georgia,serif;font-size:28px}.brand img{width:36px;height:36px}h1{font-family:"Libre Caslon Text",Georgia,serif;font-weight:400;font-size:clamp(44px,9vw,64px);line-height:1.12;letter-spacing:-.035em;margin:48px 0 16px}.intro{color:#57534e;line-height:1.6;margin:0 0 40px}form{text-align:left}label{display:block;font-size:14px;margin-bottom:8px}input,button{width:100%;font:inherit;min-height:48px}input{border:1px solid #d6d3d1;border-radius:10px;padding:12px 14px;background:#fff;color:#292524}button{margin-top:16px;border:0;border-radius:999px;background:#292524;color:#fff;padding:12px 20px;cursor:pointer}button:hover{background:#44403c}input:focus-visible,button:focus-visible{outline:2px solid #57534e;outline-offset:3px}.error{color:#9f1239;line-height:1.5;font-size:14px;margin:12px 0 0}.hint{font-size:13px;color:#57534e;text-align:center;margin:16px 0 0}
footer{padding:0 24px 24px;text-align:center;font-size:14px;line-height:24px}footer a{color:#57534e;text-underline-offset:4px}footer a:focus-visible{outline:2px solid #57534e;outline-offset:3px}
</style></head><body><main><section class="access" aria-labelledby="coming-soon"><div class="brand"><img src="/brand/turret-mark.svg" alt=""><span>turret.</span></div><h1 id="coming-soon">Coming soon</h1><p class="intro">We’re getting Turret ready.</p><form action="/__access/login" method="post"><input type="hidden" name="next" value="${escape(returnPath(next))}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"${error?' aria-invalid="true" aria-describedby="access-error"':""}>${error?`<p class="error" id="access-error" role="alert">${escape(error)}</p>`:""}<button type="submit">Enter website</button><p class="hint">Have access? Enter your password to continue.</p></form></section></main><footer><a href="https://docs.turret.capital/">Documentation</a></footer></body></html>`;
}

export function createSiteAccess({
  enabled = process.env.TURRET_SITE_GATE === "1",
  passwordHash = process.env.TURRET_SITE_PASSWORD_HASH,
  signingKey = process.env.TURRET_SITE_SESSION_KEY,
  now = () => Date.now(),
  secure = true,
  maxAttempts = 30,
} = {}) {
  if (!enabled) return async () => false;
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash || "") || !/^[a-f0-9]{64}$/.test(signingKey || "")) {
    throw new Error("Site access is enabled but its credentials are missing or invalid");
  }
  const [salt, expected] = passwordHash.split(":");
  // Password rotation also invalidates existing sessions.
  const sign = value => createHmac("sha256", signingKey).update(passwordHash).update(value).digest("hex");
  let attempts = 0, windowStart = now(), activeChecks = 0;
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Vary": "Cookie",
  };
  function send(req, res, status, body, extra = {}) {
    res.writeHead(status, {...headers, "Content-Type":"text/html; charset=utf-8", ...extra});
    res.end(req.method === "HEAD" ? undefined : body);
  }
  function validSession(req) {
    const token = (req.headers.cookie || "").split(";").map(x=>x.trim()).find(x=>x.startsWith(cookieName+"="))?.slice(cookieName.length+1);
    if (!token || !/^\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return false;
    const [expiry, nonce, signature] = token.split(".");
    const remaining = Number(expiry) - Math.floor(now()/1000);
    return remaining > 0 && remaining <= lifetime && timingSafeEqual(Buffer.from(signature,"hex"),Buffer.from(sign(expiry+"."+nonce),"hex"));
  }
  function cookie(req, value, maxAge) {
    const host = (req.headers.host || "").split(":")[0].toLowerCase();
    const domain = host === "turret.capital" || host.endsWith(".turret.capital") ? "; Domain=turret.capital" : "";
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?"; Secure":""}${domain}`;
  }
  return async function siteAccess(req, res) {
    let url;
    try { url = new URL(req.url || "/", "http://localhost"); } catch { send(req,res,400,"Invalid request");return true; }
    if (url.pathname === "/robots.txt") {
      send(req,res,200,"User-agent: *\nDisallow: /\n",{"Content-Type":"text/plain; charset=utf-8"});return true;
    }
    if (publicAssets.has(url.pathname) && ["GET","HEAD"].includes(req.method)) return false;
    if (url.pathname === "/__access/logout" && req.method === "POST") {
      send(req,res,303,"",{"Set-Cookie":cookie(req,"",0),Location:"/"});return true;
    }
    if (url.pathname === "/__access/login" && req.method === "POST") {
      if (req.headers.origin) {
        let originHost;try {originHost=new URL(req.headers.origin).host;}catch{}
        if(originHost!==req.headers.host){send(req,res,403,page("/","Please submit the form from this website."));return true;}
      }
      if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {send(req,res,415,page());return true;}
      if (now()-windowStart >= 60_000) {windowStart=now();attempts=0;}
      if (++attempts>maxAttempts || activeChecks>=4) {send(req,res,429,page("/","Too many attempts. Please wait a minute and try again."),{"Retry-After":"60"});req.resume();return true;}
      let raw="",length=0;
      try {
        for await (const chunk of req) {length+=chunk.length;if(length>2048){send(req,res,413,page());return true;}raw+=chunk.toString();}
      }catch{return true;}
      const form=new URLSearchParams(raw), password=form.get("password")||"", next=returnPath(form.get("next"));
      if (password.length>256) {send(req,res,401,page(next,"That password is incorrect. Please try again."));return true;}
      activeChecks++;
      let valid;
      try {valid=timingSafeEqual(await derive(password,salt,64),Buffer.from(expected,"hex"));}finally{activeChecks--;}
      if (!valid) {send(req,res,401,page(next,"That password is incorrect. Please try again."));return true;}
      const value = `${Math.floor(now()/1000)+lifetime}.${randomBytes(16).toString("hex")}`;
      send(req,res,303,"",{"Set-Cookie":cookie(req,value+"."+sign(value),lifetime),Location:next});return true;
    }
    if (validSession(req)) {
      // Authenticated assets must not be put into a shared cache.
      const original=res.writeHead;
      res.writeHead=function(status, supplied, ...rest){return original.call(this,status,{...supplied,"Cache-Control":"private, no-store","Vary":"Cookie","X-Robots-Tag":"noindex, nofollow"},...rest)};
      return false;
    }
    if (url.pathname.startsWith("/api/") || !["GET","HEAD"].includes(req.method)) {
      send(req,res,401,'{"error":"Password required"}',{"Content-Type":"application/json; charset=utf-8"});return true;
    }
    send(req,res,200,page(returnPath(url.pathname+url.search)));return true;
  };
}
