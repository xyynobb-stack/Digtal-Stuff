import { app } from "electron";
import { applyGpuPreferences, installGpuCrashGuard } from "./gpu-fallback";
import { focusMainWindow, startMainProcess } from "./app/start";
import { loadDotEnvForDev } from "./load-env";

// Dev only: make process.env reflect the project `.env` so runtime env reads
// (e.g. the Hermes One API endpoint) pick up edits on relaunch without a
// rebuild. Packaged builds carry their config baked in and ship no `.env`.
if (!app.isPackaged) loadDotEnvForDev();

applyGpuPreferences();
installGpuCrashGuard();

if (process.env.ENABLE_CDP === "1") {
  app.commandLine.appendSwitch(
    "remote-debugging-port",
    process.env.CDP_PORT || "9222",
  );
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => focusMainWindow());
  startMainProcess();
}
