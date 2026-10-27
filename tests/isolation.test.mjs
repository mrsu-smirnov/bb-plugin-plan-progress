import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedArgs, launcherSource, ORIGINAL_PLUGIN } from "../isolation.ts";

test("the session override preserves other SDK and plugin settings", () => {
  const args = isolatedArgs(["--model", "opus", "--settings", JSON.stringify({
    fastMode: true, sandbox: { enabled: true }, enabledPlugins: { other: true, [ORIGINAL_PLUGIN]: true },
  })], () => assert.fail());
  assert.deepEqual(args.slice(2), ["--model", "opus"]);
  assert.deepEqual(JSON.parse(args[1]), {
    fastMode: true, sandbox: { enabled: true }, enabledPlugins: { other: true, [ORIGINAL_PLUGIN]: false },
  });
});

test("settings files are read, never modified; malformed settings fail closed", () => {
  const original = JSON.stringify({ env: { EXAMPLE: "unchanged" }, enabledPlugins: { [ORIGINAL_PLUGIN]: true } });
  const args = isolatedArgs(["--settings=config.json", "--print"], path => {
    assert.equal(path, "config.json"); return original;
  });
  assert.equal(JSON.parse(args[1]).enabledPlugins[ORIGINAL_PLUGIN], false);
  assert.equal(JSON.parse(original).enabledPlugins[ORIGINAL_PLUGIN], true);
  for (const bad of ["[]", "null", "{broken", '{"enabledPlugins":null}']) {
    assert.throws(() => isolatedArgs(["--settings", "config.json"], () => bad));
  }
  assert.throws(() => isolatedArgs(["--settings"], () => ""));
});

test("generated launcher forwards stdio, arguments, and exit status without editing Desktop settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bb-isolation-"));
  try {
    const settings = join(dir, "Desktop settings.json");
    const text = JSON.stringify({ enabledPlugins: { [ORIGINAL_PLUGIN]: true }, autoMemoryEnabled: false });
    await writeFile(settings, text);
    const fake = join(dir, "fake claude.mjs");
    await writeFile(fake, 'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 7;');
    const launcher = join(dir, "launcher.mjs");
    await writeFile(launcher, launcherSource(fake));
    const result = spawnSync(process.execPath, [launcher, "--settings", settings, "--model", "opus"], { encoding: "utf8" });
    assert.equal(result.status, 7, result.stderr);
    const forwarded = JSON.parse(result.stdout);
    assert.deepEqual(forwarded.slice(2), ["--model", "opus"]);
    assert.deepEqual(JSON.parse(forwarded[1]), {
      enabledPlugins: { [ORIGINAL_PLUGIN]: false }, autoMemoryEnabled: false,
    });
    assert.equal(await readFile(settings, "utf8"), text);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
