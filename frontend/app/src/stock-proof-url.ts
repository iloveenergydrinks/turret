export function stockProofUrl(base: string, engine: string): URL {
  const url = new URL(base);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || !/^\/(?:[A-Z]{1,8})?\/?$/.test(url.pathname)) {
    throw new Error("Invalid stock risk monitor URL");
  }
  const prefix=url.pathname.replace(/\/$/,"");
  return new URL(`${prefix}/stock/approvals/${engine}`,url.origin);
}
