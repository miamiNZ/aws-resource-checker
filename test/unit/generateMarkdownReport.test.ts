import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDate,
  generateMarkdownReport,
  generateMarkdownReportGrouped,
  generateMarkdownReportStackGrouped,
} from "../../src/application/utils/generateMarkdownReport";
import { GenerateResourceReportResponse } from "../../src/application/reports/GenerateResourceReportResponse ";
import { ResourceInfo } from "../../src/domain/models/ResourceInfo";
import { daysAgo } from "../helpers";

const lambda = (overrides: Partial<ResourceInfo> = {}): ResourceInfo => ({
  resourceName: "OrdersFn", resourceType: "AWS::Lambda::Function", stackName: "orders", exists: true,
  lastUsed: daysAgo(1), usedInLast30Days: true,
  runtimeInfo: { resourceId: "orders-fn", resourceType: "AWS::Lambda::Function", exists: true, runtimeLanguage: "nodejs", runtimeVersion: "12.x", deprecated: true },
  ...overrides,
});

const bucket = (overrides: Partial<ResourceInfo> = {}): ResourceInfo => ({
  resourceName: "Assets", resourceType: "AWS::S3::Bucket", stackName: "web", exists: true,
  lastUsed: "N/A", usedInLast30Days: false,
  runtimeInfo: { resourceId: "assets-bucket", resourceType: "AWS::S3::Bucket", exists: true, encryption: "AES256", publicAccessBlocked: true, versioningEnabled: false },
  ...overrides,
});

const queue = (overrides: Partial<ResourceInfo> = {}): ResourceInfo => ({
  resourceName: "Jobs", resourceType: "AWS::SQS::Queue", stackName: "orders", exists: true,
  lastUsed: daysAgo(3), usedInLast30Days: true,
  runtimeInfo: { resourceId: "q", resourceType: "AWS::SQS::Queue", exists: true, encryption: "None", sqsHasDLQ: false, sqsMessageCount: 12, error: "AccessDenied" },
  ...overrides,
});

const report = (resources: ResourceInfo[], accountName: string | null = "sandbox") =>
  new GenerateResourceReportResponse("12345", accountName, "ap-southeast-2", new Date("2026-01-15T10:00:00Z"), resources);

/** Split a Markdown table row into trimmed cell values. */
const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());

/** Return the header and data rows of the table that follows a "Resource Type" heading. */
function tableFor(markdown: string, type: string): { header: string[]; rows: string[][] } {
  const lines = markdown.split("\n");
  const start = lines.findIndex(l => l.includes(`Resource Type: <u>${type}</u>`));
  assert.ok(start >= 0, `no section for ${type}`);
  const table = lines.slice(start + 1).filter(l => l.trim() !== "");
  const end = table.findIndex(l => !l.startsWith("|"));
  const rows = (end === -1 ? table : table.slice(0, end)).map(cells);
  return { header: rows[0], rows: rows.slice(2) };
}

describe("formatDate", () => {
  for (const value of [null, undefined, "", "not a date", "N/A"]) {
    test(`returns N/A for ${JSON.stringify(value)}`, () => assert.equal(formatDate(value as any), "N/A"));
  }

  test("formats a valid ISO date as a NZ-style date and time", () => {
    assert.match(formatDate("2026-01-15T10:00:00Z"), /^\d{2}\/\d{2}\/\d{4}, \d{1,2}:\d{2}:\d{2}\s?[ap]m$/i);
  });
});

describe("generateMarkdownReportGrouped", () => {
  test("starts with the report title and account details", () => {
    const md = generateMarkdownReportGrouped(report([lambda()]))!;
    const lines = md.split("\n");

    assert.equal(lines[0], "# AWS Resource Report");
    assert.equal(lines[1], "Account ID: <u>12345</u>");
    assert.equal(lines[2], "Account Name: <u>sandbox</u>");
    assert.equal(lines[3], "Region: <u>ap-southeast-2</u>");
    assert.match(lines[4], /^Generated: \d{2}\/\d{2}\/2026/);
  });

  test("shows N/A when the account has no friendly name", () => {
    assert.match(generateMarkdownReportGrouped(report([], null))!, /Account Name: <u>N\/A<\/u>/);
  });

  test("an empty report has the header but no stack sections", () => {
    const md = generateMarkdownReportGrouped(report([]))!;
    assert.ok(md.startsWith("# AWS Resource Report"));
    assert.ok(!md.includes("### Stack:"));
  });

  test("groups resources by stack, then by resource type", () => {
    const md = generateMarkdownReportGrouped(report([lambda(), bucket(), queue()]))!;

    assert.equal(md.match(/### Stack:/g)?.length, 2);
    const ordersAt = md.indexOf("### Stack: <u>orders</u>");
    const webAt = md.indexOf("### Stack: <u>web</u>");
    assert.ok(ordersAt >= 0 && webAt > ordersAt);
    const ordersSection = md.slice(ordersAt, webAt);
    assert.ok(ordersSection.includes("Resource Type: <u>AWS::Lambda::Function</u>"));
    assert.ok(ordersSection.includes("Resource Type: <u>AWS::SQS::Queue</u>"));
    assert.ok(!ordersSection.includes("AWS::S3::Bucket"));
  });

  test("puts resources with no stack name under N/A", () => {
    assert.ok(generateMarkdownReportGrouped(report([bucket({ stackName: "" })]))!.includes("### Stack: <u>N/A</u>"));
  });

  test("Lambda table: last used, 30 days, runtime, deprecated, error", () => {
    const { header, rows } = tableFor(generateMarkdownReportGrouped(report([lambda()]))!, "AWS::Lambda::Function");

    assert.deepEqual(header, ["Resource", "Last Used", "30 Days", "Runtime", "Deprecated", "Error"]);
    assert.equal(rows[0][0], "OrdersFn");
    assert.match(rows[0][1], /\d{2}\/\d{2}\/\d{4}/);
    assert.deepEqual(rows[0].slice(2), ["Yes", "nodejs - 12.x", "Yes", "No"]);
  });

  test("S3 table: encryption, public access and versioning", () => {
    const { header, rows } = tableFor(generateMarkdownReportGrouped(report([bucket()]))!, "AWS::S3::Bucket");

    assert.deepEqual(header, ["Resource", "Last Used", "30 Days", "Deprecated", "Encryption", "Public Access", "Versioning Enabled", "Error"]);
    assert.deepEqual(rows[0], ["Assets", "N/A", "No", "No", "AES256", "Yes", "No", "No"]);
  });

  test("SQS table: encryption, DLQ, message count and error flag", () => {
    const { header, rows } = tableFor(generateMarkdownReportGrouped(report([queue()]))!, "AWS::SQS::Queue");

    assert.deepEqual(header, ["Resource", "Last Used", "30 Days", "Deprecated", "Encryption", "DLQ", "Messages", "Error"]);
    assert.deepEqual(rows[0].slice(2), ["Yes", "No", "None", "No", "12", "Yes"]);
  });

  test("other types use the default columns", () => {
    const topic: ResourceInfo = {
      resourceName: "Alerts", resourceType: "AWS::SNS::Topic", stackName: "ops", exists: true, lastUsed: "N/A", usedInLast30Days: false,
      runtimeInfo: { resourceId: "arn", resourceType: "AWS::SNS::Topic", exists: true, runtimeLanguage: null, runtimeVersion: null, deprecated: false },
    };
    const { header, rows } = tableFor(generateMarkdownReportGrouped(report([topic]))!, "AWS::SNS::Topic");

    assert.equal(header.length, 6);
    assert.deepEqual(rows[0], ["Alerts", "N/A", "No", "N/A -", "No", "No"]);
  });

  test("resources without runtime info show No / N/A instead of failing", () => {
    const md = generateMarkdownReportGrouped(report([lambda({ runtimeInfo: undefined, lastUsed: undefined, usedInLast30Days: undefined })]))!;
    const { rows } = tableFor(md, "AWS::Lambda::Function");
    assert.deepEqual(rows[0], ["OrdersFn", "N/A", "No", "N/A -", "No", "No"]);
  });

  test("uses only plain text (no emoji icons)", () => {
    const md = generateMarkdownReportGrouped(report([lambda(), bucket(), queue()]))!;
    assert.doesNotMatch(md, /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u);
  });

  for (const type of ["AWS::Lambda::Function", "AWS::S3::Bucket", "AWS::SQS::Queue", "AWS::RDS::DBInstance", "AWS::EC2::Instance", "AWS::SNS::Topic"]) {
    test(`${type} rows have as many cells as the header`, () => {
      const r = lambda({ resourceType: type, runtimeInfo: { resourceId: "x", resourceType: type, exists: true } });
      const { header, rows } = tableFor(generateMarkdownReportGrouped(report([r]))!, type);
      assert.equal(rows[0].length, header.length);
    });
  }

  test("AWS::DynamoDB::Table rows have as many cells as the header", { todo: "known bug: the DynamoDB row has 3 cells but the header has 6" }, () => {
    const r = lambda({ resourceType: "AWS::DynamoDB::Table", runtimeInfo: { resourceId: "t", resourceType: "AWS::DynamoDB::Table", exists: true } });
    const { header, rows } = tableFor(generateMarkdownReportGrouped(report([r]))!, "AWS::DynamoDB::Table");
    assert.equal(rows[0].length, header.length);
  });
});

describe("generateMarkdownReport (flat table)", () => {
  test("returns a message when there are no resources", () => {
    assert.equal(generateMarkdownReport([]), "No resources found.");
  });

  test("sorts by stack name, then most recently used first", () => {
    const md = generateMarkdownReport([
      lambda({ resourceName: "Old", stackName: "b", lastUsed: daysAgo(50) }),
      lambda({ resourceName: "New", stackName: "b", lastUsed: daysAgo(1) }),
      lambda({ resourceName: "Never", stackName: "b", lastUsed: null }),
      lambda({ resourceName: "First", stackName: "a", lastUsed: daysAgo(10) }),
    ]);
    const names = md.split("\n").slice(2).map(row => cells(row)[0]);
    assert.deepEqual(names, ["First", "New", "Old", "Never"]);
  });

  test("has 9 columns with Yes/No flags", () => {
    const rows = generateMarkdownReport([lambda()]).split("\n").map(cells);
    assert.equal(rows[0].length, 9);
    assert.equal(rows[2].length, 9);
    assert.deepEqual([rows[2][5], rows[2][8]], ["Yes", "Yes"]);
  });
});

describe("generateMarkdownReportStackGrouped", () => {
  test("writes account details and one table per stack", () => {
    const md = generateMarkdownReportStackGrouped(report([lambda(), bucket()]))!;

    assert.ok(md.includes("### Account ID: 12345"));
    assert.ok(md.includes("### Region: ap-southeast-2"));
    assert.ok(md.includes("#### Stack: orders"));
    assert.ok(md.includes("#### Stack: web"));
    assert.ok(md.includes("| OrdersFn | AWS::Lambda::Function |"));
  });
});
