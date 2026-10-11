import "reflect-metadata";
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer";
import { FileConversionHelper } from "../../src/application/utils/FileConversionHelper";
import { FileHelper } from "../../src/infrastructure/utils/FileHelper";
import { GenerateResourceReportResponse } from "../../src/application/reports/GenerateResourceReportResponse ";
import { RecordingLogger, useTempCwd, daysAgo } from "../helpers";

const sampleReport = () => new GenerateResourceReportResponse("12345", "sandbox", "ap-southeast-2", new Date(), [
  {
    resourceName: "OrdersFn", resourceType: "AWS::Lambda::Function", stackName: "orders", exists: true,
    lastUsed: daysAgo(2), usedInLast30Days: true,
    runtimeInfo: { resourceId: "orders-fn", resourceType: "AWS::Lambda::Function", exists: true, runtimeLanguage: "nodejs", runtimeVersion: "20.x", deprecated: false },
  },
  {
    resourceName: "Assets", resourceType: "AWS::S3::Bucket", stackName: "web", exists: true, lastUsed: "N/A", usedInLast30Days: false,
    runtimeInfo: { resourceId: "assets", resourceType: "AWS::S3::Bucket", exists: true, encryption: "AES256", publicAccessBlocked: true, versioningEnabled: true },
  },
]);

async function chromeInstalled(): Promise<boolean> {
  try { return fs.existsSync(await puppeteer.executablePath()); } catch { return false; }
}

describe("Report file pipeline (JSON -> Markdown -> PDF)", () => {
  let temp: ReturnType<typeof useTempCwd>;
  let logger: RecordingLogger;
  let helper: FileConversionHelper;
  beforeEach(() => {
    temp = useTempCwd();
    logger = new RecordingLogger();
    helper = new FileConversionHelper(logger);
  });
  afterEach(() => temp.restore());

  test("makeMdFileFromData writes a Markdown report to reports/", async () => {
    const result = await helper.makeMdFileFromData(sampleReport(), "AwsResourceReport-sandbox.md");

    assert.equal(result.success, true);
    assert.match(path.basename(result.filepath!), /^AwsResourceReport-sandbox-.*\.md$/);
    const md = fs.readFileSync(result.filepath!, "utf8");
    assert.ok(md.startsWith("# AWS Resource Report"));
    assert.ok(md.includes("### Stack: <u>orders</u>"));
    assert.ok(md.includes("| OrdersFn |"));
  });

  test("makeMdFileFromFile reads a saved JSON report (the app's real flow)", async () => {
    const json = await new FileHelper().saveJsonFile("AwsResourceReport-sandbox.json", sampleReport());
    const result = await helper.makeMdFileFromFile(json.filepath!, "AwsResourceReport-sandbox.md");

    assert.equal(result.success, true);
    const md = fs.readFileSync(result.filepath!, "utf8");
    assert.ok(md.includes("Account ID: <u>12345</u>"));
    assert.ok(md.includes("| Assets |"));
  });

  test("makeMdFileFromFile returns success=false for a missing JSON file", async () => {
    const result = await helper.makeMdFileFromFile("does-not-exist.json", "out.md");
    assert.equal(result.success, false);
    assert.ok(logger.messages("error").some(m => m.includes("Failed to create Markdown file from JSON file")));
  });

  test("makeMdFileFromFile returns success=false for invalid JSON", async () => {
    fs.mkdirSync("reports");
    fs.writeFileSync(path.join("reports", "broken.json"), "{ not json");
    const result = await helper.makeMdFileFromFile("broken.json", "out.md");
    assert.equal(result.success, false);
  });

  test("makeMdContentFromData returns the Markdown without writing a file", async () => {
    const { mdContent } = await helper.makeMdContentFromData(sampleReport());
    assert.ok(mdContent!.startsWith("# AWS Resource Report"));
    assert.equal(fs.existsSync("reports"), false);
  });

  test("convertMdFileToPdf returns success=false when the Markdown file is missing", async () => {
    const result = await helper.convertMdFileToPdf(path.join(temp.dir, "missing.md"), "out.pdf");
    assert.equal(result.success, false);
  });

  test("convertMdFileToPdf creates a valid PDF", { timeout: 60_000 }, async (t) => {
    if (!(await chromeInstalled())) return t.skip("Chrome not installed: run `npx puppeteer browsers install chrome`");
    const md = await helper.makeMdFileFromData(sampleReport(), "AwsResourceReport-sandbox.md");
    const pdf = await helper.convertMdFileToPdf(md.filepath!, "AwsResourceReport-sandbox.pdf");

    assert.equal(pdf.success, true);
    assert.match(path.basename(pdf.filepath!), /^AwsResourceReport-sandbox-.*\.pdf$/);
    const bytes = fs.readFileSync(pdf.filepath!);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    assert.ok(bytes.length > 5_000, `PDF is suspiciously small (${bytes.length} bytes)`);
  });
});
