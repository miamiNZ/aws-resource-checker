import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { FileHelper } from "../../src/infrastructure/utils/FileHelper";
import { useTempCwd } from "../helpers";

describe("FileHelper", () => {
  let temp: ReturnType<typeof useTempCwd>;
  beforeEach(() => { temp = useTempCwd(); });
  afterEach(() => temp.restore());

  test("saveJsonFile writes pretty JSON to reports/ with a timestamp in the name", async () => {
    const result = await new FileHelper().saveJsonFile("AwsResourceReport-sandbox.json", { a: 1, nested: { b: [1, 2] } });

    assert.equal(result.success, true);
    assert.equal(path.dirname(result.filepath!), path.join(process.cwd(), "reports"));
    assert.match(path.basename(result.filepath!), /^AwsResourceReport-sandbox-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
    const content = fs.readFileSync(result.filepath!, "utf8");
    assert.deepEqual(JSON.parse(content), { a: 1, nested: { b: [1, 2] } });
    assert.ok(content.includes("\n  "), "indented with 2 spaces");
  });

  test("saveJsonFile creates the reports folder if it is missing", async () => {
    assert.equal(fs.existsSync("reports"), false);
    await new FileHelper().saveJsonFile("x.json", {});
    assert.equal(fs.existsSync("reports"), true);
  });

  test("saveJsonFile returns success=false for data that can't be serialised", async () => {
    const circular: any = { name: "loop" };
    circular.self = circular;
    const result = await new FileHelper().saveJsonFile("bad.json", circular);

    assert.equal(result.success, false);
    assert.equal(fs.existsSync("reports"), false);
  });

  test("saveFile uses .txt when the name has no extension", async () => {
    const result = await new FileHelper().saveFile("notes", "hello");
    assert.match(result.filepath!, /notes-.*\.txt$/);
    assert.equal(fs.readFileSync(result.filepath!, "utf8"), "hello");
  });

  test("saveFile writes an absolute path exactly as given", async () => {
    const target = path.join(temp.dir, "custom", "out.md");
    fs.mkdirSync(path.dirname(target));
    const result = await new FileHelper().saveFile(target, "# Title");

    assert.deepEqual(result, { success: true, filepath: target });
    assert.equal(fs.readFileSync(target, "utf8"), "# Title");
  });

  test("saveFile writes binary data", async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    const result = await new FileHelper().saveFile("file.pdf", bytes);
    assert.deepEqual(fs.readFileSync(result.filepath!), bytes);
  });

  test("saveFile creates missing parent folders for an absolute path", async () => {
    const target = path.join(temp.dir, "new", "deeper", "out.txt");
    const result = await new FileHelper().saveFile(target, "x");

    assert.deepEqual(result, { success: true, filepath: target });
    assert.equal(fs.readFileSync(target, "utf8"), "x");
  });

  test("saveFile returns success=false when the folder can't be created", async () => {
    fs.writeFileSync(path.join(temp.dir, "blocker"), "a file, not a folder");
    const result = await new FileHelper().saveFile(path.join(temp.dir, "blocker", "out.txt"), "x");
    assert.equal(result.success, false);
  });

  test("two saves of the same name create two files", async () => {
    const helper = new FileHelper();
    const a = await helper.saveFile("same.txt", "1");
    await new Promise(r => setTimeout(r, 5));
    const b = await helper.saveFile("same.txt", "2");
    assert.notEqual(a.filepath, b.filepath);
  });

  test("readFile reads a relative name from reports/", async () => {
    fs.mkdirSync("reports");
    fs.writeFileSync(path.join("reports", "in.json"), "{\"ok\":true}");
    assert.equal(await new FileHelper().readFile("in.json"), "{\"ok\":true}");
  });

  test("readFile reads an absolute path", async () => {
    const file = path.join(temp.dir, "abs.txt");
    fs.writeFileSync(file, "absolute");
    assert.equal(await new FileHelper().readFile(file), "absolute");
  });

  test("readFile rejects when the file doesn't exist", async () => {
    await assert.rejects(new FileHelper().readFile("missing.json"), { code: "ENOENT" });
  });
});
