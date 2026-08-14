const TRACKING_KEYS = new Set(["gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "ref_src"]);

export function normalizeUrl(value, hosts = {}) {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  const hostRule = hosts[url.hostname.toLowerCase()];
  url.hostname = hostRule?.canonical_host || url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

