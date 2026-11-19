import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export function outerTypelessManifest(dir) {
  let current = realpathSync(dir);
  while (true) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) {
      const type = JSON.parse(readFileSync(manifest, "utf8"))?.type;
      return type === "module" || type === "commonjs" ? null : manifest;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// Keep syntax detection in use and silence only the warning caused by the host's manifest.
export function quietOuterManifestEnv(dir) {
  return outerTypelessManifest(dir) ? { NODE_OPTIONS: "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON" } : {};
}

export function assertNoFixtureManifest(...dirs) {
  for (const dir of dirs) {
    const manifest = join(dir, "package.json");
    assert.equal(lstatSync(manifest, { throwIfNoEntry: false }), undefined, `unexpected fixture manifest: ${manifest}`);
  }
}
