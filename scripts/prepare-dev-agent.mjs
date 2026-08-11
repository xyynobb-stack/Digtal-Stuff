import os from "node:os";
import path from "node:path";
import { patchCronOutputDirectories } from "./patch-cron-output-directories.mjs";

const hermesHome =
  process.env.HERMES_HOME?.trim() ||
  (process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA ||
          path.join(os.homedir(), "AppData", "Local"),
        "hermes",
      )
    : path.join(os.homedir(), ".hermes"));

patchCronOutputDirectories(path.join(hermesHome, "hermes-agent"));