/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM utility, not TypeScript. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/** Import only the AIHub credential into an explicitly selected local profile. */
export function configureAIHubKey(profileHome, keyFile) {
  const keyLine = fs
    .readFileSync(keyFile, "utf8")
    .match(/^AIHUB_API_KEY\s*=\s*["']?(sk-[a-zA-Z0-9_-]+)["']?\s*$/m);
  if (!keyLine)
    throw new Error(
      "Key file must contain AIHUB_API_KEY=sk-... (value is not logged)",
    );
  const destination = path.join(path.resolve(profileHome), ".env");
  if (!fs.existsSync(destination))
    throw new Error(
      "Profile .env does not exist; provision the employee first",
    );
  const before = fs.readFileSync(destination, "utf8");
  const line = `AIHUB_API_KEY=${keyLine[1]}`;
  const pattern = /^\s*(?:export\s+)?AIHUB_API_KEY[^\S\r\n]*=.*$/m;
  const after = pattern.test(before)
    ? before.replace(pattern, line)
    : before + (before.endsWith("\n") ? "" : "\n") + line + "\n";
  if (before === after) return false;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, after, { encoding: "utf8", mode: 0o600 });
  try {
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return true;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [profileHome, keyFile] = process.argv.slice(2);
  if (!profileHome || !keyFile)
    throw new Error(
      "Usage: node scripts/configure-aihub-key.mjs <profile-home> <key-env-file>",
    );
  configureAIHubKey(profileHome, keyFile);
  console.log(
    "AIHub key configured in the selected profile; no credential was logged.",
  );
}
