// Only a bb child process receives this flag override. Never edit Claude's settings files.
export const ORIGINAL_PLUGIN = "plan-progress@zycck-mods";

export function isolatedArgs(args: string[], readFile: (path: string) => string): string[] {
  const rest: string[] = [];
  let settings: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== "--settings" && !arg.startsWith("--settings=")) {
      rest.push(arg);
      continue;
    }
    const value = arg === "--settings" ? args[++index] : arg.slice("--settings=".length);
    if (!value) throw new Error("--settings requires a JSON object or file");
    const parsed: unknown = JSON.parse(value.trim().startsWith("{") ? value : readFile(value));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Claude settings must be an object");
    }
    // CLI flag precedence is last wins. Keep every setting in that winning object.
    settings = parsed as Record<string, unknown>;
  }
  const enabled = settings.enabledPlugins;
  if (enabled !== undefined && (enabled === null || typeof enabled !== "object" || Array.isArray(enabled))) {
    throw new Error("enabledPlugins must be an object");
  }
  settings = { ...settings, enabledPlugins: { ...(enabled as object ?? {}), "plan-progress@zycck-mods": false } };
  // Root options must precede subcommands such as `plugin list`.
  return ["--settings", JSON.stringify(settings), ...rest];
}

export function launcherSource(executable: string): string {
  // A .mjs executable is launched through Node by the Claude SDK on Windows too.
  return `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const ORIGINAL_PLUGIN = ${JSON.stringify(ORIGINAL_PLUGIN)};
const isolatedArgs = ${isolatedArgs.toString()};
try {
  const executable = ${JSON.stringify(executable)};
  const args = isolatedArgs(process.argv.slice(2), path => readFileSync(path, 'utf8'));
  const script = /\\.(?:m?js|tsx?|jsx)$/.test(executable);
  const child = spawn(script ? process.execPath : executable, script ? [executable, ...args] : args,
    { stdio: 'inherit', windowsHide: true });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('BB plan-progress: could not launch Claude'); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
    else process.exitCode = code ?? 1;
  });
} catch {
  console.error('BB plan-progress: cannot isolate Claude plugin; check --settings and the configured executable');
  process.exitCode = 1;
}
`;
}
