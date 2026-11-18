// A fake GitHub release host for the pin tests: the public download route can answer a status (or
// serve the files), the API lists the named assets and serves them at /asset/<name>. Every test
// reaches 127.0.0.1 only, never GitHub.
import { createServer } from "node:http";

const origin = (server) => `http://127.0.0.1:${server.address().port}`;

/**
 * `files` maps an asset name to its bytes. `<origin>/download/<tag>/<name>` serves them when
 * `publicStatus` is 200, otherwise answers that status. `<origin>/api/releases/tags/<tag>` lists
 * every name at `<origin>/asset/<name>`, which serves the bytes or `assetStatus`. Records every
 * request's path and headers; `close()` stops the server.
 */
export async function fakeRelease({ tag, files, publicStatus = 504, apiStatus = 200, assetStatus = 200 }) {
  const requests = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    requests.push({ path, headers: req.headers });
    if (path.startsWith(`/download/${tag}/`)) {
      const name = path.slice(`/download/${tag}/`.length);
      if (publicStatus === 200 && files[name]) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(files[name]);
      } else {
        res.writeHead(publicStatus);
        res.end("public download failed");
      }
      return;
    }
    if (path === `/api/releases/tags/${tag}`) {
      res.writeHead(apiStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ assets: Object.keys(files).map((name) => ({ name, url: `${origin(server)}/asset/${name}` })) }));
      return;
    }
    if (path.startsWith("/asset/")) {
      const name = path.slice("/asset/".length);
      if (assetStatus === 200 && files[name]) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(files[name]);
      } else {
        res.writeHead(assetStatus === 200 ? 404 : assetStatus);
        res.end("asset failed");
      }
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    requests,
    origin: origin(server),
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  };
}
