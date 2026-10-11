import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const repoRoot = path.resolve(__dirname, "..", "..");
const appEntry = path.join(repoRoot, "src", "application", "app.ts");

/**
 * Runs the real CLI in a temp folder with empty AWS config files and no credentials,
 * so it can never reach AWS. Covers argument parsing, startup and the failure path.
 */
describe("CLI (end to end, no AWS access)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-cli-"));
    fs.writeFileSync(path.join(dir, "config"), "");
    fs.writeFileSync(path.join(dir, "credentials"), "");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function runCli(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("AWS_")) delete env[key];
    }
    Object.assign(env, {
      AWS_CONFIG_FILE: path.join(dir, "config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(dir, "credentials"),
      AWS_EC2_METADATA_DISABLED: "true",
      TS_NODE_PROJECT: path.join(repoRoot, "tsconfig.json"),
    });
    return spawnSync(process.execPath, ["--require", require.resolve("ts-node/register"), appEntry, ...args], {
      cwd: dir, env, encoding: "utf8", timeout: 90_000,
    });
  }

  test("an unknown profile fails with a clear message and exit code 1", { timeout: 120_000 }, () => {
    const result = runCli(["--profile", "no-such-profile"]);

    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stdout, /Application starting\.\.\./);
    assert.match(result.stderr, /Processing failed: .*no-such-profile.*See logs\/ for details\./);
    assert.doesNotMatch(result.stdout + result.stderr, /Processing complete/);
  });

  test("no credentials at all fails cleanly and writes a log file", { timeout: 120_000 }, () => {
    const result = runCli(["--region", "us-east-1"]);

    assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /Processing failed: /);
    const logs = fs.readdirSync(path.join(dir, "logs"));
    assert.equal(logs.length, 1);
    const log = fs.readFileSync(path.join(dir, "logs", logs[0]), "utf8");
    assert.match(log, /\[ERROR\] Failed to generate report:/);
    assert.equal(fs.existsSync(path.join(dir, "reports")), false, "no reports are written on failure");
  });

  test("console output contains no emoji icons", { timeout: 120_000 }, () => {
    const result = runCli(["--profile", "no-such-profile"]);
    assert.doesNotMatch(result.stdout + result.stderr, /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u);
  });
});
