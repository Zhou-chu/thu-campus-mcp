import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./windows-zip.ps1", import.meta.url));
/** Use Windows' native ZIP writer, not tar's ZIP dialect. Arguments never become shell source. */
export function createWindowsZip({ sourcePath, destinationPath } = {}, execute = execFileSync) {
  if (typeof sourcePath !== "string" || typeof destinationPath !== "string" || !path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath))
    throw new TypeError("ZIP source and destination must be absolute paths.");
  execute("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-File", script, "-SourcePath", sourcePath, "-DestinationPath", destinationPath], { stdio: "inherit", windowsHide: true });
}
