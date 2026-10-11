import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { StackResourceSummary } from "@aws-sdk/client-cloudformation";
import { GenerateResourceReportHandler } from "../../src/application/reports/GenerateResourceReportHandler ";
import { GenerateResourceReportRequest } from "../../src/application/reports/GenerateResourceReportRequest";
import { IAwsService } from "../../src/domain/interfaces/IAwsService";
import { RuntimeInfo } from "../../src/domain/models/RuntimeInfo";
import { RecordingLogger, daysAgo } from "../helpers";

type FakeAwsOptions = {
  stacks?: string[];
  resources?: Record<string, StackResourceSummary[] | Error>;
  lastUsed?: Record<string, string | null>;
  account?: { accountId: string; accountName: string | null };
  accountError?: Error;
};

/** In-memory IAwsService. Resources are keyed by stack name, last-used dates by physical ID. */
function fakeAwsService(options: FakeAwsOptions = {}) {
  const calls = { listStackResources: [] as string[], determineLastUsed: [] as string[], getResourceInfo: [] as string[] };
  const service: IAwsService = {
    async getAwsAccountId() {
      if (options.accountError) throw options.accountError;
      return options.account ?? { accountId: "111111111111", accountName: "test" };
    },
    async listAllStacks() { return options.stacks ?? []; },
    async listStackResources(stack) {
      calls.listStackResources.push(stack);
      const r = options.resources?.[stack] ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    isSupportedResourceType: (type) => ["AWS::Lambda::Function", "AWS::S3::Bucket", "AWS::SQS::Queue"].includes(type),
    async determineLastUsed(r) {
      calls.determineLastUsed.push(r.PhysicalResourceId!);
      return options.lastUsed?.[r.PhysicalResourceId!] ?? null;
    },
    async getResourceInfo(r): Promise<RuntimeInfo> {
      calls.getResourceInfo.push(r.PhysicalResourceId!);
      return { resourceId: r.PhysicalResourceId!, resourceType: r.ResourceType, exists: true };
    },
    async getLambdaLastInvocation() { return null; },
    async getLastEventFromCloudTrail() { return null; },
  };
  return { service, calls };
}

const resource = (logicalId: string, type: string, physicalId?: string): StackResourceSummary =>
  ({ LogicalResourceId: logicalId, ResourceType: type, PhysicalResourceId: physicalId } as StackResourceSummary);

const makeHandler = (options: FakeAwsOptions = {}) => {
  const { service, calls } = fakeAwsService(options);
  const logger = new RecordingLogger();
  return { handler: new GenerateResourceReportHandler(service, logger), calls, logger };
};

describe("GenerateResourceReportHandler", () => {
  test("returns account details, region and generation time", async () => {
    const { handler } = makeHandler({ account: { accountId: "12345", accountName: "sandbox" } });
    const before = Date.now();
    const response = await handler.handle(new GenerateResourceReportRequest("us-east-1"));

    assert.equal(response.accountId, "12345");
    assert.equal(response.accountName, "sandbox");
    assert.equal(response.region, "us-east-1");
    assert.ok(response.generatedAt.getTime() >= before);
    assert.deepEqual(response.resources, []);
  });

  test("propagates account lookup failures (for example expired credentials)", async () => {
    const { handler } = makeHandler({ accountError: new Error("Token is expired") });
    await assert.rejects(handler.handle(new GenerateResourceReportRequest("ap-southeast-2")), /Token is expired/);
  });

  test("builds a ResourceInfo for each supported resource", async () => {
    const { handler } = makeHandler({
      stacks: ["app"],
      resources: { app: [resource("Fn", "AWS::Lambda::Function", "fn-1"), resource("Bucket", "AWS::S3::Bucket", "bucket-1")] },
      lastUsed: { "fn-1": daysAgo(2) },
    });
    const { resources } = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2"));

    assert.equal(resources.length, 2);
    const fn = resources.find(r => r.resourceName === "Fn")!;
    assert.equal(fn.resourceType, "AWS::Lambda::Function");
    assert.equal(fn.stackName, "app");
    assert.equal(fn.exists, true);
    assert.equal(fn.usedInLast30Days, true);
    assert.equal(fn.runtimeInfo?.resourceId, "fn-1");
    const bucket = resources.find(r => r.resourceName === "Bucket")!;
    assert.equal(bucket.lastUsed, "N/A");
    assert.equal(bucket.usedInLast30Days, false);
  });

  test("skips unsupported resource types and resources without a physical ID", async () => {
    const { handler, calls } = makeHandler({
      stacks: ["app"],
      resources: { app: [
        resource("Role", "AWS::IAM::Role", "role-1"),
        resource("Pending", "AWS::S3::Bucket"),
        resource("Queue", "AWS::SQS::Queue", "q-1"),
      ] },
    });
    const { resources } = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2"));

    assert.deepEqual(resources.map(r => r.resourceName), ["Queue"]);
    assert.deepEqual(calls.getResourceInfo, ["q-1"]);
  });

  for (const [label, lastUsed, expected] of [
    ["1 day ago", daysAgo(1), true],
    ["29 days ago", daysAgo(29), true],
    ["31 days ago", daysAgo(31), false],
    ["200 days ago", daysAgo(200), false],
    ["never", null, false],
  ] as const) {
    test(`usedInLast30Days is ${expected} when last used ${label}`, async () => {
      const { handler } = makeHandler({
        stacks: ["s"], resources: { s: [resource("Fn", "AWS::Lambda::Function", "fn")] }, lastUsed: { fn: lastUsed },
      });
      const { resources } = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2"));

      assert.equal(resources[0].usedInLast30Days, expected);
      assert.equal(resources[0].lastUsed, lastUsed ?? "N/A");
    });
  }

  test("uses N/A when a resource has no logical ID", async () => {
    const { handler } = makeHandler({ stacks: ["s"], resources: { s: [resource(undefined as any, "AWS::S3::Bucket", "b")] } });
    const { resources } = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2"));
    assert.equal(resources[0].resourceName, "N/A");
  });

  test("processes every stack, including more stacks than one batch holds", async () => {
    const stacks = Array.from({ length: 11 }, (_, i) => `stack-${i}`);
    const resources = Object.fromEntries(stacks.map(s => [s, [resource(`${s}-q`, "AWS::SQS::Queue", `${s}-q`)]]));
    const { handler, calls } = makeHandler({ stacks, resources });

    const response = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2"));

    assert.equal(response.resources.length, 11);
    assert.deepEqual([...calls.listStackResources].sort(), [...stacks].sort());
  });

  test("a failing stack is logged and does not stop the other stacks", async () => {
    const { handler, logger } = makeHandler({
      stacks: ["good", "bad"],
      resources: { good: [resource("Q", "AWS::SQS::Queue", "q")], bad: new Error("Stack bad does not exist") },
    });
    const { resources } = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2"));

    assert.deepEqual(resources.map(r => r.stackName), ["good"]);
    assert.ok(logger.messages("error").some(m => m.includes("Stack bad does not exist")));
  });

  describe("stack name filter", () => {
    const options = {
      stacks: ["Orders-Api", "orders-worker", "billing"],
      resources: {
        "Orders-Api": [resource("A", "AWS::SQS::Queue", "a")],
        "orders-worker": [resource("W", "AWS::SQS::Queue", "w")],
        billing: [resource("B", "AWS::SQS::Queue", "b")],
      },
    };

    test("matches stack names case-insensitively by substring", async () => {
      const { handler, calls } = makeHandler(options);
      const { resources } = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2", "ORDERS"));

      assert.deepEqual(resources.map(r => r.stackName).sort(), ["Orders-Api", "orders-worker"]);
      assert.ok(!calls.listStackResources.includes("billing"));
    });

    test("returns an empty report and a warning when no stack matches", async () => {
      const { handler, calls, logger } = makeHandler(options);
      const response = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2", "payments"));

      assert.deepEqual(response.resources, []);
      assert.equal(calls.listStackResources.length, 0);
      assert.ok(logger.messages("warn").some(m => m.includes("Stack 'payments' not found")));
    });

    test("an empty filter processes all stacks", async () => {
      const { handler } = makeHandler(options);
      const { resources } = await handler.handle(new GenerateResourceReportRequest("ap-southeast-2", ""));
      assert.equal(resources.length, 3);
    });
  });
});
