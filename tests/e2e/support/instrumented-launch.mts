import { launchElectron as rawLaunchElectron } from "../electron-launch.mjs";
import type { LaunchOptions, LaunchedElectronApplication } from "../electron-launch.mjs";
import { activeInvariantContext } from "./invariants.mjs";

export type { LaunchedElectronApplication, LaunchOptions } from "../electron-launch.mjs";

/**
 * Launch Electron while an invariant test is active and attach its process and
 * renderer diagnostics to that test. Outside the harness it is a transparent
 * launchElectron pass-through.
 */
export async function launchElectron(options: LaunchOptions): Promise<LaunchedElectronApplication> {
  const context = activeInvariantContext();
  if (!context) return rawLaunchElectron(options);

  return rawLaunchElectron({
    ...options,
    onProcessStarted(process) {
      // This hook runs immediately after spawn, before CDP startup output.
      context.registerStderr(process.stderr);
      options.onProcessStarted?.(process);
    },
    async onPage(page) {
      await context.registerPage(page);
      await options.onPage?.(page);
    },
  });
}
