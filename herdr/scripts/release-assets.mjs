// Where a GitHub release's assets come from, for the pin check in CI
// (scheduler-pin.mjs). The public release-download URL is tried first. When it fails with a 5xx, a
// timeout or a network error, the same asset is fetched through the REST API asset route (`gh
// release download`'s): GET /repos/<repo>/releases/tags/<tag>, then the named asset's `url` as
// octet-stream. A 4xx means the release or asset really is not there, and is reported at once.
// For small files, callers can shorten the public attempt while the API keeps its full timeout.
//
// The token is ever only an `Authorization: Bearer` header on the API requests: never on the
// public download, never in a URL and never in a log line. Each `get(name)` logs exactly one line
// naming the route that served it, then returns the bytes; the caller's sha256 checks are its own.
// Apache-2.0.
const PUBLIC_ROUTE = "public release download";
const API_ROUTE = "REST API asset route";

/** An HTTP or transport failure; a 5xx, a timeout and a network error are retryable. */
class AssetError extends Error {
  constructor(url, { status, cause } = {}) {
    super(status === undefined ? `${url}: ${cause?.message ?? cause}` : `${url}: HTTP ${status}`);
    this.retryable = status === undefined || status >= 500;
  }
}

/** One GET as bytes, following redirects; a timeout or network error is an AssetError. */
async function download(fetchImpl, url, headers, timeout) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow", headers, signal: AbortSignal.timeout(timeout) });
  } catch (cause) {
    throw new AssetError(url, { cause });
  }
  if (!response.ok) throw new AssetError(url, { status: response.status });
  try {
    return Buffer.from(await response.arrayBuffer());
  } catch (cause) {
    throw new AssetError(url, { cause });
  }
}

/** The API headers: the release's metadata as JSON, an asset as its raw bytes, the token when set. */
const apiHeaders = (token, accept) => ({ Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) });

/**
 * A fetcher for one release's assets: `<base>/<name>` first, then the REST API asset route on a
 * retryable failure. `base` is the public download folder (`.../releases/download/<tag>`), `api`
 * the repository's API root (`https://api.github.com/repos/<owner>/<repo>`) and `tag` the release
 * tag. The API's asset list is read once per fetcher; `log` gets the one route line per asset.
 * For small files, `get(name, { publicTimeout })` can shorten the public attempt in milliseconds.
 * Each API request always gets the full `timeout`.
 */
export function releaseAssets({
  base,
  api,
  tag,
  token = "",
  fetch: fetchImpl = globalThis.fetch,
  log = console.log,
  timeout = 120_000,
} = {}) {
  const release = { value: null };

  async function apiAsset(name) {
    if (!release.value) {
      const body = await download(fetchImpl, `${api}/releases/tags/${encodeURIComponent(tag)}`, apiHeaders(token, "application/vnd.github+json"), timeout);
      try { release.value = JSON.parse(body.toString("utf8")); } catch { throw new Error(`the API's ${tag} release is not JSON`); }
    }
    const assets = Array.isArray(release.value?.assets) ? release.value.assets : [];
    const asset = assets.find((candidate) => candidate?.name === name);
    if (!asset?.url) throw new Error(`the API's ${tag} release has no asset named ${name}`);
    return download(fetchImpl, asset.url, apiHeaders(token, "application/octet-stream"), timeout);
  }

  return {
    async get(name, { publicTimeout = timeout } = {}) {
      try {
        const bytes = await download(fetchImpl, `${base}/${name}`, {}, publicTimeout);
        log(`${name}: served by the ${PUBLIC_ROUTE}`);
        return bytes;
      } catch (publicError) {
        if (!publicError.retryable) throw publicError;
        try {
          const bytes = await apiAsset(name);
          log(`${name}: served by the ${API_ROUTE}`);
          return bytes;
        } catch (apiError) {
          throw new Error(`${publicError.message}; the API asset route failed too: ${apiError.message}`);
        }
      }
    },
  };
}
