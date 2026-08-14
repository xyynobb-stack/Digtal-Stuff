import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ASSET_REFERENCE_RE = /(?:src|href)=["']([^"']+)["']/g;

/** Verify that a Dashboard dist contains every JS/CSS asset referenced by its HTML. */
export function verifyDashboardWebDist(webDistRoot) {
  const root = path.resolve(webDistRoot);
  const indexPath = path.join(root, "index.html");
  const assetsPath = path.join(root, "assets");

  if (!fs.statSync(indexPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Dashboard web dist is missing index.html: ${indexPath}`);
  }
  if (!fs.statSync(assetsPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `Dashboard web dist is missing assets directory: ${assetsPath}`,
    );
  }

  const html = fs.readFileSync(indexPath, "utf8");
  const references = [...html.matchAll(ASSET_REFERENCE_RE)]
    .map((match) => match[1])
    .filter((reference) => /^\/?assets\//.test(reference))
    .map((reference) => reference.replace(/^\//, "").split(/[?#]/, 1)[0]);

  if (references.length === 0) {
    throw new Error(
      `Dashboard index.html does not reference any built assets: ${indexPath}`,
    );
  }

  for (const reference of references) {
    const assetPath = path.resolve(root, reference);
    if (!assetPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(
        `Dashboard asset reference escapes web_dist: ${reference}`,
      );
    }
    if (!fs.statSync(assetPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(
        `Dashboard index.html references a missing asset: ${assetPath}`,
      );
    }
  }

  return { indexPath, assetsPath, references };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const webDistRoot = process.argv[2];
  if (!webDistRoot) {
    console.error(
      "Usage: node scripts/verify-dashboard-web-dist.mjs <web-dist-directory>",
    );
    process.exitCode = 2;
  } else {
    const result = verifyDashboardWebDist(webDistRoot);
    console.log(
      `Verified Dashboard web dist: ${result.references.length} referenced assets`,
    );
  }
}
