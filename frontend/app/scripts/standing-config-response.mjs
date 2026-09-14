/** Serve the public factory configuration explicitly: an inactive feature is 404,
 * never a redirect to the website's HTML fallback. */
export function serveStandingConfig(request, response, config, headers = {}) {
 if(new URL(request.url||'/', 'http://localhost').pathname!=='/standing-offers.json')return false;
 const method=request.method||'GET';
 const allowed=method==='GET'||method==='HEAD';
 const status=!allowed?405:config?200:404;
 const body=JSON.stringify(!allowed?{error:'Use GET or HEAD.'}:config??{error:'Standing offers are not active.'});
 response.writeHead(status,{...headers,'content-type':'application/json; charset=utf-8','cache-control':'no-store','content-length':Buffer.byteLength(body),...(!allowed?{allow:'GET, HEAD'}:{})});
 response.end(method==='HEAD'?undefined:body);request.resume();return true;
}
