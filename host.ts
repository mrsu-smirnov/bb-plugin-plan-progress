import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { hostContract } from "./host-contract";
import { launcherSource } from "./isolation";

async function findClaude(configured: string): Promise<string> {
  const candidates = configured ? [configured] : [
    ...((process.env.PATH ?? "").split(delimiter).filter(Boolean).map(dir =>
      join(dir, process.platform === "win32" ? "claude.exe" : "claude"))),
    join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"),
  ];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); return path; } catch { /* next candidate */ }
  }
  throw new Error("BB plan-progress: Claude executable not found; set claudeExecutable to its absolute path");
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async prepareClaude({ executable: configured }, context) {
      const executable = await findClaude(configured);
      const source = launcherSource(executable);
      const dir = context.experimental_paths.dataDir;
      await mkdir(dir, { recursive: true });
      // Immutable names: a reload cannot overwrite a launcher an active session uses.
      const hash = createHash("sha256").update(source).digest("hex").slice(0, 16);
      const launcher = join(dir, `claude-bb-${hash}.mjs`);
      const existing = await readFile(launcher, "utf8").catch(() => null);
      if (existing !== source) {
        const temporary = `${launcher}.${randomUUID()}.tmp`;
        await writeFile(temporary, source, { mode: 0o700 });
        await rename(temporary, launcher);
      }
      await chmod(launcher, 0o700);
      return { launcher, executable };
    },
  },
});
