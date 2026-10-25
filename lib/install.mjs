import path from "node:path";
import { services, loadModule } from "./services.mjs";
export async function installBundle(options = {}) {
  const installers = [];
  for (const s of services) {
    const { installClients } = await loadModule(s, "install.js");
    const opts = {
      ...options,
      ...(options.stateRoot
        ? { stateDir: path.join(options.stateRoot, s.directory) }
        : {}),
    };
    if (s.name === "hetang" && options.stateRoot)
      opts.cloudStateDir = path.join(options.stateRoot, "thu-cloud");
    const preview = await installClients({ ...opts, apply: false });
    installers.push({ s, installClients, opts, preview });
  }
  const reports = [];
  for (const item of installers) {
    reports.push({
      service: item.s.directory,
      ...(options.apply ? await item.installClients(item.opts) : item.preview),
    });
  }
  return { apply: Boolean(options.apply), services: reports };
}
