// A fake GitHub release host for the pin tests: the public download route can answer a status (or
// serve the files), and the API lists the named assets and serves them at /asset/<name> or
// redirects to a second loopback origin. Every test reaches 127.0.0.1 only, never GitHub.
import { createServer } from "node:http";

const origin = (server) => `http://127.0.0.1:${server.address().port}`;

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function close(server) {
  return new Promise((done) => {
    server.closeAllConnections();
    server.close(done);
  });
}

/**
 * `files` maps an asset name to its bytes. `<origin>/download/<tag>/<name>` serves them when
 * `publicStatus` is 200, otherwise answers that status. `<origin>/api/releases/tags/<tag>` lists
 * every name at `<origin>/asset/<name>`, which serves the bytes or `assetStatus`. With
 * `assetRedirect`, successful asset requests redirect to `/blob/<name>` on a second origin.
 * `requests` records paths and headers on the first origin. `redirects` records paths and
 * whether Authorization was present on the second origin. `close()` stops both listeners.
 */
export async function fakeRelease({
  tag, files, publicStatus = 504, apiStatus = 200, assetStatus = 200, assetRedirect = false,
}) {
  const requests = [];
  const redirects = [];
  let redirectServer;
  const server = await listen((req, res) => {
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
      if (assetRedirect && assetStatus === 200 && files[name]) {
        res.writeHead(302, { location: `${origin(redirectServer)}/blob/${name}` });
        res.end();
      } else if (assetStatus === 200 && files[name]) {
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
  if (assetRedirect) {
    try {
      redirectServer = await listen((req, res) => {
        const path = new URL(req.url, "http://127.0.0.1").pathname;
        redirects.push({ path, authorization: "authorization" in req.headers });
        if (path.startsWith("/blob/")) {
          const name = path.slice("/blob/".length);
          if (files[name]) {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.end(files[name]);
            return;
          }
        }
        res.writeHead(404);
        res.end("not found");
      });
    } catch (error) {
      await close(server);
      throw error;
    }
  }
  return {
    requests,
    redirects,
    origin: origin(server),
    close: () => redirectServer ? Promise.all([close(server), close(redirectServer)]) : close(server),
  };
}
