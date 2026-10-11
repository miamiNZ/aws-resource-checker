import { describe, test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { FileLogger } from "../../src/infrastructure/services/FileLogger";
import { ConsoleLogger } from "../../src/infrastructure/services/ConsoleLogger";
import { useTempCwd, waitFor } from "../helpers";

const TIMESTAMP = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/;

describe("FileLogger", () => {
  let temp: ReturnType<typeof useTempCwd>;
  beforeEach(() => { temp = useTempCwd(); });
  afterEach(() => temp.restore());

  const logFiles = () => (fs.existsSync("logs") ? fs.readdirSync("logs") : []);
  const readLog = () => fs.readFileSync(path.join("logs", logFiles()[0]), "utf8");

  /** Create a logger and wait until its logs/ folder exists (the constructor doesn't await it). */
  async function makeLogger(dir?: string) {
    const logger = dir ? new FileLogger(dir) : new FileLogger();
    await waitFor(() => fs.existsSync(dir ?? "logs"));
    return logger;
  }

  test("creates logs/ and one timestamped log file per logger", async () => {
    const logger = await makeLogger();
    logger.info("hello");
    await waitFor(() => logFiles().length === 1);

    assert.match(logFiles()[0], /^app-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.log$/);
  });

  test("writes each level with a timestamp and level tag", async () => {
    const logger = await makeLogger();
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.debug("d");
    logger.success("s");
    await waitFor(() => logFiles().length === 1 && readLog().split("\n").filter(Boolean).length === 5);

    const lines = readLog().split("\n").filter(Boolean);
    assert.ok(lines.every(l => TIMESTAMP.test(l)));
    const tags = lines.map(l => l.match(/\] \[(\w+)\]/)![1]).sort();
    assert.deepEqual(tags, ["DEBUG", "ERROR", "INFO", "SUCCESS", "WARN"]);
  });

  test("formats extra arguments, including objects and circular references", async () => {
    const logger = await makeLogger();
    const circular: any = { id: 7 };
    circular.self = circular;
    logger.error("Failed to generate report:", new Error("boom"), circular);
    await waitFor(() => logFiles().length === 1 && readLog().includes("id: 7"));

    const log = readLog();
    assert.ok(log.includes("[ERROR] Failed to generate report:"));
    assert.ok(log.includes("boom"));
    assert.ok(log.includes("[Circular *1]"));
  });

  test("supports a custom logs folder name", async () => {
    const logger = await makeLogger("custom-logs");
    logger.info("x");
    await waitFor(() => fs.existsSync("custom-logs") && fs.readdirSync("custom-logs").length === 1);
  });

  test("logging straight after construction is not lost", { todo: "known race: the constructor starts mkdir without awaiting it" }, async () => {
    const logger = new FileLogger("race-logs");
    logger.info("first line");
    await new Promise(r => setTimeout(r, 200));
    const files = fs.existsSync("race-logs") ? fs.readdirSync("race-logs") : [];
    assert.equal(files.length, 1);
    assert.ok(fs.readFileSync(path.join("race-logs", files[0]), "utf8").includes("first line"));
  });
});

describe("ConsoleLogger", () => {
  let spies: Record<string, ReturnType<typeof mock.method>>;
  beforeEach(() => {
    spies = {
      log: mock.method(console, "log", () => {}),
      warn: mock.method(console, "warn", () => {}),
      error: mock.method(console, "error", () => {}),
      debug: mock.method(console, "debug", () => {}),
    };
  });
  afterEach(() => mock.restoreAll());

  for (const [method, consoleMethod, tag] of [
    ["info", "log", "INFO"],
    ["warn", "warn", "WARN"],
    ["error", "error", "ERROR"],
    ["debug", "debug", "DEBUG"],
    ["success", "error", "SUCCESS"],
  ] as const) {
    test(`${method}() writes "[timestamp] [${tag}] message" to console.${consoleMethod}`, () => {
      (new ConsoleLogger() as any)[method]("the message", { extra: 1 });

      const call = spies[consoleMethod].mock.calls[0];
      assert.ok(call, `console.${consoleMethod} was not called`);
      assert.match(call.arguments[0] as string, new RegExp(`^\\[.+\\] \\[${tag}\\] the message$`));
      assert.deepEqual(call.arguments[1], { extra: 1 });
    });
  }

  test("output contains no emoji icons", () => {
    const logger = new ConsoleLogger();
    logger.info("a"); logger.warn("b"); logger.error("c"); logger.debug("d"); logger.success("e");
    const all = Object.values(spies).flatMap(s => s.mock.calls.map(c => String(c.arguments[0])));
    assert.equal(all.length, 5);
    assert.ok(all.every(line => !/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2139}]/u.test(line)));
  });
});
