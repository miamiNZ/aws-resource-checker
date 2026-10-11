import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FakeClient, awsError, makeAwsService, daysAgo } from "../helpers";

describe("AwsService.isSupportedResourceType", () => {
  const { service } = makeAwsService();

  for (const type of [
    "AWS::Lambda::Function", "AWS::EC2::Instance", "AWS::RDS::DBInstance", "AWS::S3::Bucket",
    "AWS::SQS::Queue", "AWS::SNS::Topic", "AWS::ApiGateway::RestApi", "AWS::ApiGatewayV2::Api",
    "AWS::DynamoDB::Table", "AWS::CloudFormation::Stack", "AWS::ECS::Service", "AWS::EKS::Cluster",
  ]) {
    test(`supports ${type}`, () => assert.equal(service.isSupportedResourceType(type), true));
  }

  for (const type of ["AWS::IAM::Role", "AWS::Logs::LogGroup", "", "aws::lambda::function"]) {
    test(`does not support "${type}"`, () => assert.equal(service.isSupportedResourceType(type), false));
  }
});

describe("AwsService.listAllStacks", () => {
  test("follows NextToken across pages and returns every stack name", async () => {
    const cf = new FakeClient({
      ListStacksCommand: (input) => input.NextToken === undefined
        ? { StackSummaries: [{ StackName: "a", StackStatus: "CREATE_COMPLETE" }], NextToken: "p2" }
        : { StackSummaries: [{ StackName: "b", StackStatus: "UPDATE_COMPLETE" }] },
    });
    const { service } = makeAwsService({ cf });

    assert.deepEqual(await service.listAllStacks(), ["a", "b"]);
    assert.deepEqual(cf.callsTo("ListStacksCommand").map(c => c.input.NextToken), [undefined, "p2"]);
  });

  test("skips deleted stacks and stacks without a name", async () => {
    const cf = new FakeClient({
      ListStacksCommand: () => ({
        StackSummaries: [
          { StackName: "live", StackStatus: "CREATE_COMPLETE" },
          { StackName: "gone", StackStatus: "DELETE_COMPLETE" },
          { StackName: "going", StackStatus: "DELETE_IN_PROGRESS" },
          { StackName: "failed-delete", StackStatus: "DELETE_FAILED" },
          { StackStatus: "CREATE_COMPLETE" },
          { StackName: "no-status" },
        ],
      }),
    });
    const { service } = makeAwsService({ cf });

    assert.deepEqual(await service.listAllStacks(), ["live"]);
  });

  test("returns an empty list when the account has no stacks", async () => {
    const { service } = makeAwsService({ cf: new FakeClient({ ListStacksCommand: () => ({}) }) });
    assert.deepEqual(await service.listAllStacks(), []);
  });

  test("logs and rethrows AWS errors", async () => {
    const cf = new FakeClient({ ListStacksCommand: () => { throw awsError("AccessDenied"); } });
    const { service, logger } = makeAwsService({ cf });

    await assert.rejects(service.listAllStacks(), { name: "AccessDenied" });
    assert.ok(logger.messages("error").some(m => m.includes("Error fetching stacks")));
  });
});

describe("AwsService.listStackResources", () => {
  test("concatenates resources across pages", async () => {
    const cf = new FakeClient({
      ListStackResourcesCommand: (input) => input.NextToken
        ? { StackResourceSummaries: [{ LogicalResourceId: "B" }] }
        : { StackResourceSummaries: [{ LogicalResourceId: "A" }], NextToken: "next" },
    });
    const { service } = makeAwsService({ cf });

    const resources = await service.listStackResources("my-stack");

    assert.deepEqual(resources.map(r => r.LogicalResourceId), ["A", "B"]);
    assert.ok(cf.calls.every(c => c.input.StackName === "my-stack"));
  });

  test("returns an empty list for a stack with no resources", async () => {
    const { service } = makeAwsService({ cf: new FakeClient({ ListStackResourcesCommand: () => ({}) }) });
    assert.deepEqual(await service.listStackResources("empty"), []);
  });

  test("rethrows non-retryable errors", async () => {
    const cf = new FakeClient({ ListStackResourcesCommand: () => { throw awsError("ValidationError"); } });
    const { service } = makeAwsService({ cf });
    await assert.rejects(service.listStackResources("missing"), { name: "ValidationError" });
  });
});

describe("AwsService.getAwsAccountId", () => {
  test("maps a known account ID to its friendly name", async () => {
    const { service } = makeAwsService({ sts: new FakeClient({ GetCallerIdentityCommand: () => ({ Account: "12345" }) }) });
    assert.deepEqual(await service.getAwsAccountId(), { accountId: "12345", accountName: "sandbox" });
  });

  test("uses 'Unknown Account' for an unmapped account ID", async () => {
    const { service } = makeAwsService({ sts: new FakeClient({ GetCallerIdentityCommand: () => ({ Account: "000000000000" }) }) });
    assert.deepEqual(await service.getAwsAccountId(), { accountId: "000000000000", accountName: "Unknown Account" });
  });

  test("throws when STS returns no account", async () => {
    const { service } = makeAwsService({ sts: new FakeClient({ GetCallerIdentityCommand: () => ({}) }) });
    await assert.rejects(service.getAwsAccountId(), /Unable to fetch AWS account ID/);
  });

  test("logs and rethrows credential errors", async () => {
    const sts = new FakeClient({ GetCallerIdentityCommand: () => { throw awsError("CredentialsProviderError", "Token is expired"); } });
    const { service, logger } = makeAwsService({ sts });

    await assert.rejects(service.getAwsAccountId(), /Token is expired/);
    assert.ok(logger.messages("error").some(m => m.includes("Error fetching AWS account ID")));
  });
});

describe("AwsService.getResourceInfo", () => {
  test("returns exists=false without calling AWS when there is no physical ID", async () => {
    const { service, clients } = makeAwsService();
    const info = await service.getResourceInfo({ ResourceType: "AWS::Lambda::Function" });

    assert.equal(info.exists, false);
    assert.equal(info.resourceId, "NA");
    assert.equal(clients.lambda.calls.length, 0);
  });

  describe("Lambda", () => {
    const cases: [string, string, string, boolean][] = [
      ["nodejs20.x", "nodejs", "20.x", false],
      ["nodejs12.x", "nodejs", "12.x", true],
      ["nodejs10.x", "nodejs", "10.x", true],
      ["python3.12", "python", "3.12", false],
      ["python3.6", "python", "3.6", true],
      ["python2.7", "python", "2.7", true],
      ["java8", "java", "8", true],
      ["java21", "java", "21", false],
      ["dotnetcore2.1", "dotnetcore", "2.1", true],
    ];
    for (const [runtime, language, version, deprecated] of cases) {
      test(`parses runtime ${runtime} (deprecated=${deprecated})`, async () => {
        const lambda = new FakeClient({ GetFunctionCommand: () => ({ Configuration: { Runtime: runtime } }) });
        const { service } = makeAwsService({ lambda });

        const info = await service.getResourceInfo({ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn" });

        assert.equal(info.exists, true);
        assert.equal(info.runtimeLanguage, language);
        assert.equal(info.runtimeVersion, version);
        assert.equal(info.deprecated, deprecated);
      });
    }

    test("container-image functions (no runtime) exist with no runtime info", async () => {
      const lambda = new FakeClient({ GetFunctionCommand: () => ({ Configuration: { PackageType: "Image" } }) });
      const { service } = makeAwsService({ lambda });
      const info = await service.getResourceInfo({ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn" });

      assert.equal(info.exists, true);
      assert.equal(info.runtimeLanguage, undefined);
    });

    test("reports an error when the function has no configuration", async () => {
      const { service } = makeAwsService({ lambda: new FakeClient({ GetFunctionCommand: () => ({}) }) });
      const info = await service.getResourceInfo({ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /has no configuration/);
    });

    test("records the AWS error instead of throwing", async () => {
      const lambda = new FakeClient({ GetFunctionCommand: () => { throw awsError("ResourceNotFoundException"); } });
      const { service, logger } = makeAwsService({ lambda });
      const info = await service.getResourceInfo({ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /Failed to fetch Lambda.*ResourceNotFoundException/);
      assert.ok(logger.messages("warn").some(m => m.includes("Failed to fetch Lambda fn")));
    });
  });

  describe("RDS", () => {
    for (const [version, deprecated] of [["11", true], ["12.3", true], ["9.6", true], ["10", true], ["15.4", false], ["12.4", false]] as const) {
      test(`engine ${version} deprecated=${deprecated}`, async () => {
        const rds = new FakeClient({ DescribeDBInstancesCommand: () => ({ DBInstances: [{ EngineVersion: version }] }) });
        const { service } = makeAwsService({ rds });
        const info = await service.getResourceInfo({ ResourceType: "AWS::RDS::DBInstance", PhysicalResourceId: "db" });

        assert.equal(info.exists, true);
        assert.equal(info.runtimeLanguage, "RDS");
        assert.equal(info.runtimeVersion, version);
        assert.equal(info.deprecated, deprecated);
      });
    }

    test("reports not found when no instances are returned", async () => {
      const { service } = makeAwsService({ rds: new FakeClient({ DescribeDBInstancesCommand: () => ({ DBInstances: [] }) }) });
      const info = await service.getResourceInfo({ ResourceType: "AWS::RDS::DBInstance", PhysicalResourceId: "db" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /RDS Instance db not found/);
    });

    test("records the AWS error instead of throwing", async () => {
      const rds = new FakeClient({ DescribeDBInstancesCommand: () => { throw awsError("DBInstanceNotFound"); } });
      const { service } = makeAwsService({ rds });
      const info = await service.getResourceInfo({ ResourceType: "AWS::RDS::DBInstance", PhysicalResourceId: "db" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /Failed to fetch RDS Instance/);
    });
  });

  describe("EC2", () => {
    test("uses the instance platform", async () => {
      const ec2 = new FakeClient({ DescribeInstancesCommand: () => ({ Reservations: [{ Instances: [{ Platform: "windows" }] }] }) });
      const { service } = makeAwsService({ ec2 });
      const info = await service.getResourceInfo({ ResourceType: "AWS::EC2::Instance", PhysicalResourceId: "i-1" });

      assert.equal(info.exists, true);
      assert.equal(info.runtimeLanguage, "windows");
      assert.equal(info.deprecated, false);
      assert.deepEqual(ec2.calls[0].input.InstanceIds, ["i-1"]);
    });

    test("falls back to Linux/Unknown when no platform is set", async () => {
      const ec2 = new FakeClient({ DescribeInstancesCommand: () => ({ Reservations: [{ Instances: [{}] }] }) });
      const { service } = makeAwsService({ ec2 });
      const info = await service.getResourceInfo({ ResourceType: "AWS::EC2::Instance", PhysicalResourceId: "i-1" });
      assert.equal(info.runtimeLanguage, "Linux/Unknown");
    });

    test("reports not found for an empty reservation list", async () => {
      const { service } = makeAwsService({ ec2: new FakeClient({ DescribeInstancesCommand: () => ({ Reservations: [] }) }) });
      const info = await service.getResourceInfo({ ResourceType: "AWS::EC2::Instance", PhysicalResourceId: "i-1" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /EC2 Instance i-1 not found/);
    });

    test("records the AWS error instead of throwing", async () => {
      const ec2 = new FakeClient({ DescribeInstancesCommand: () => { throw awsError("InvalidInstanceID.NotFound"); } });
      const { service } = makeAwsService({ ec2 });
      const info = await service.getResourceInfo({ ResourceType: "AWS::EC2::Instance", PhysicalResourceId: "i-1" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /Failed to fetch EC2 Instance/);
    });
  });

  describe("S3", () => {
    const fullBucket = () => new FakeClient({
      HeadBucketCommand: () => ({}),
      GetBucketEncryptionCommand: () => ({
        ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" } }] },
      }),
      GetPublicAccessBlockCommand: () => ({ PublicAccessBlockConfiguration: { BlockPublicAcls: true } }),
      GetBucketVersioningCommand: () => ({ Status: "Enabled" }),
    });

    test("collects encryption, public access block and versioning", async () => {
      const { service } = makeAwsService({ s3: fullBucket() });
      const info = await service.getResourceInfo({ ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "bucket" });

      assert.equal(info.exists, true);
      assert.equal(info.encryption, "aws:kms");
      assert.equal(info.publicAccessBlocked, true);
      assert.equal(info.versioningEnabled, true);
      assert.equal(info.deprecated, false);
    });

    test("treats missing encryption and public access block as None / not blocked", async () => {
      const s3 = new FakeClient({
        HeadBucketCommand: () => ({}),
        GetBucketEncryptionCommand: () => { throw awsError("ServerSideEncryptionConfigurationNotFoundError"); },
        GetPublicAccessBlockCommand: () => { throw awsError("NoSuchPublicAccessBlockConfiguration"); },
        GetBucketVersioningCommand: () => ({}),
      });
      const { service } = makeAwsService({ s3 });
      const info = await service.getResourceInfo({ ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "bucket" });

      assert.equal(info.exists, true);
      assert.equal(info.encryption, "None");
      assert.equal(info.publicAccessBlocked, false);
      assert.equal(info.versioningEnabled, false);
    });

    test("suspended versioning counts as not enabled", async () => {
      const s3 = fullBucket();
      (s3 as any).handlers.GetBucketVersioningCommand = () => ({ Status: "Suspended" });
      const { service } = makeAwsService({ s3 });
      const info = await service.getResourceInfo({ ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "bucket" });
      assert.equal(info.versioningEnabled, false);
    });

    test("reports an error when the bucket cannot be reached", async () => {
      const s3 = new FakeClient({ HeadBucketCommand: () => { throw awsError("NotFound"); } });
      const { service } = makeAwsService({ s3 });
      const info = await service.getResourceInfo({ ResourceType: "AWS::S3::Bucket", PhysicalResourceId: "bucket" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /Failed to fetch S3 bucket/);
      assert.equal(s3.callsTo("GetBucketEncryptionCommand").length, 0);
    });
  });

  describe("SQS", () => {
    test("parses queue attributes", async () => {
      const sqs = new FakeClient({
        GetQueueAttributesCommand: () => ({
          Attributes: {
            VisibilityTimeout: "30", MessageRetentionPeriod: "345600", KmsMasterKeyId: "alias/aws/sqs",
            RedrivePolicy: "{\"deadLetterTargetArn\":\"arn\"}", ApproximateNumberOfMessages: "7",
          },
        }),
      });
      const { service } = makeAwsService({ sqs });
      const info = await service.getResourceInfo({ ResourceType: "AWS::SQS::Queue", PhysicalResourceId: "https://sqs/q" });

      assert.equal(info.exists, true);
      assert.equal(info.sqsVisibilityTimeout, 30);
      assert.equal(info.sqsRetentionPeriod, 345600);
      assert.equal(info.encryption, "alias/aws/sqs");
      assert.equal(info.sqsHasDLQ, true);
      assert.equal(info.sqsMessageCount, 7);
      assert.equal(sqs.calls[0].input.QueueUrl, "https://sqs/q");
      assert.deepEqual(sqs.calls[0].input.AttributeNames, ["All"]);
    });

    test("uses defaults when attributes are missing", async () => {
      const { service } = makeAwsService({ sqs: new FakeClient({ GetQueueAttributesCommand: () => ({}) }) });
      const info = await service.getResourceInfo({ ResourceType: "AWS::SQS::Queue", PhysicalResourceId: "q" });

      assert.equal(info.exists, true);
      assert.equal(info.sqsVisibilityTimeout, 0);
      assert.equal(info.sqsRetentionPeriod, 0);
      assert.equal(info.encryption, "None");
      assert.equal(info.sqsHasDLQ, false);
      assert.equal(info.sqsMessageCount, 0);
    });

    test("records the AWS error instead of throwing", async () => {
      const sqs = new FakeClient({ GetQueueAttributesCommand: () => { throw awsError("QueueDoesNotExist"); } });
      const { service } = makeAwsService({ sqs });
      const info = await service.getResourceInfo({ ResourceType: "AWS::SQS::Queue", PhysicalResourceId: "q" });

      assert.equal(info.exists, false);
      assert.match(info.error!, /QueueDoesNotExist/);
    });
  });

  for (const type of ["AWS::SNS::Topic", "AWS::DynamoDB::Table", "AWS::ECS::Service"]) {
    test(`${type} has no extra details and is marked as existing`, async () => {
      const { service, clients } = makeAwsService();
      const info = await service.getResourceInfo({ ResourceType: type, PhysicalResourceId: "id" });

      assert.equal(info.exists, true);
      assert.equal(info.runtimeLanguage, null);
      assert.equal(info.deprecated, false);
      assert.equal(Object.values(clients).reduce((n, c) => n + c.calls.length, 0), 0);
    });
  }
});

describe("AwsService.getLastEventFromCloudTrail", () => {
  test("returns the newest event time from the first chunk that has events", async () => {
    const newest = new Date(daysAgo(2));
    const ct = new FakeClient({
      LookupEventsCommand: () => ({ Events: [{ EventTime: new Date(daysAgo(5)) }, { EventTime: newest }, { EventTime: new Date(daysAgo(9)) }] }),
    });
    const { service } = makeAwsService({ ct });

    assert.equal(await service.getLastEventFromCloudTrail("my-bucket"), newest.toISOString());
    assert.equal(ct.calls.length, 1);
    assert.deepEqual(ct.calls[0].input.LookupAttributes, [{ AttributeKey: "ResourceName", AttributeValue: "my-bucket" }]);
  });

  test("walks back through 30-day chunks until it finds events", async () => {
    const found = new Date(daysAgo(70));
    const ct = new FakeClient({ LookupEventsCommand: (_input, n) => (n === 3 ? { Events: [{ EventTime: found }] } : { Events: [] }) });
    const { service } = makeAwsService({ ct });

    assert.equal(await service.getLastEventFromCloudTrail("q"), found.toISOString());
    assert.equal(ct.calls.length, 3);
    const [first, second] = ct.calls.map(c => c.input);
    assert.ok(second.EndTime < first.StartTime, "each chunk ends before the previous one starts");
  });

  test("returns null after searching about 360 days with no events", async () => {
    const ct = new FakeClient({ LookupEventsCommand: () => ({ Events: [] }) });
    const { service } = makeAwsService({ ct });

    assert.equal(await service.getLastEventFromCloudTrail("unused"), null);
    assert.ok(ct.calls.length >= 12 && ct.calls.length <= 13, `expected 12-13 chunks, got ${ct.calls.length}`);
    const oldest = Math.min(...ct.calls.map(c => c.input.StartTime.getTime()));
    const days = (Date.now() - oldest) / 86_400_000;
    assert.ok(days > 355 && days < 365, `look-back was ${days.toFixed(1)} days`);
  });

  test("logs a failed chunk and keeps searching", async () => {
    const found = new Date(daysAgo(40));
    const ct = new FakeClient({
      LookupEventsCommand: (_input, n) => {
        if (n === 1) throw awsError("AccessDenied");
        return { Events: [{ EventTime: found }] };
      },
    });
    const { service, logger } = makeAwsService({ ct });

    assert.equal(await service.getLastEventFromCloudTrail("q"), found.toISOString());
    assert.ok(logger.messages("error").some(m => m.includes("Chunk failed for q")));
  });

  test("runs only one CloudTrail lookup at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const ct = new FakeClient({
      LookupEventsCommand: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
        return { Events: [{ EventTime: new Date() }] };
      },
    });
    const { service } = makeAwsService({ ct });

    await Promise.all(["a", "b", "c", "d"].map(id => service.getLastEventFromCloudTrail(id)));
    assert.equal(maxActive, 1);
  });
});

describe("AwsService.getLambdaLastInvocation", () => {
  test("returns the most recent day with invocations", async () => {
    const recent = new Date(daysAgo(3));
    const cw = new FakeClient({
      GetMetricDataCommand: () => ({
        MetricDataResults: [{ Timestamps: [new Date(daysAgo(10)), recent, new Date(daysAgo(1))], Values: [4, 2, 0] }],
      }),
    });
    const { service } = makeAwsService({ cw });

    assert.equal(await service.getLambdaLastInvocation("fn"), recent.toISOString());
  });

  test("queries the Invocations metric using the name from a function ARN", async () => {
    const cw = new FakeClient({ GetMetricDataCommand: () => ({ MetricDataResults: [{ Timestamps: [new Date()], Values: [1] }] }) });
    const { service } = makeAwsService({ cw });

    await service.getLambdaLastInvocation("arn:aws:lambda:ap-southeast-2:111111111111:function:my-fn");

    const metric = cw.calls[0].input.MetricDataQueries[0].MetricStat.Metric;
    assert.equal(metric.Namespace, "AWS/Lambda");
    assert.equal(metric.MetricName, "Invocations");
    assert.deepEqual(metric.Dimensions, [{ Name: "FunctionName", Value: "my-fn" }]);
  });

  test("returns null when the function was never invoked", async () => {
    const cw = new FakeClient({ GetMetricDataCommand: () => ({ MetricDataResults: [{ Timestamps: [new Date()], Values: [0] }] }) });
    const { service } = makeAwsService({ cw });

    assert.equal(await service.getLambdaLastInvocation("idle"), null);
    assert.ok(cw.calls.length >= 12, "searches the whole look-back period");
  });

  test("retries a throttled chunk, then continues", async () => {
    const found = new Date(daysAgo(1));
    const cw = new FakeClient({
      GetMetricDataCommand: (_input, n) => {
        if (n === 1) throw awsError("ThrottlingException");
        return { MetricDataResults: [{ Timestamps: [found], Values: [3] }] };
      },
    });
    const { service, logger } = makeAwsService({ cw });

    assert.equal(await service.getLambdaLastInvocation("fn"), found.toISOString());
    assert.equal(cw.calls.length, 2);
    assert.equal(cw.calls[0].input.StartTime.getTime(), cw.calls[1].input.StartTime.getTime(), "same chunk retried");
    assert.ok(logger.messages("warn").some(m => m.includes("Throttled by CloudWatch")));
  });
});

describe("AwsService.determineLastUsed", () => {
  test("returns null without any AWS calls when there is no physical ID", async () => {
    const { service, clients } = makeAwsService();
    assert.equal(await service.determineLastUsed({ ResourceType: "AWS::S3::Bucket" }), null);
    assert.equal(clients.ct.calls.length + clients.cw.calls.length, 0);
  });

  test("Lambda: uses CloudWatch when it has data and skips CloudTrail", async () => {
    const at = new Date(daysAgo(1));
    const cw = new FakeClient({ GetMetricDataCommand: () => ({ MetricDataResults: [{ Timestamps: [at], Values: [5] }] }) });
    const ct = new FakeClient({ LookupEventsCommand: () => ({ Events: [] }) });
    const { service } = makeAwsService({ cw, ct });

    assert.equal(await service.determineLastUsed({ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn" }), at.toISOString());
    assert.equal(ct.calls.length, 0);
  });

  test("Lambda: falls back to CloudTrail when CloudWatch has no invocations", async () => {
    const at = new Date(daysAgo(20));
    const cw = new FakeClient({ GetMetricDataCommand: () => ({ MetricDataResults: [] }) });
    const ct = new FakeClient({ LookupEventsCommand: () => ({ Events: [{ EventTime: at }] }) });
    const { service } = makeAwsService({ cw, ct });

    assert.equal(await service.determineLastUsed({ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn" }), at.toISOString());
    assert.equal(ct.calls.length, 1);
  });

  for (const type of ["AWS::S3::Bucket", "AWS::SQS::Queue", "AWS::EC2::Instance", "AWS::RDS::DBInstance", "AWS::SNS::Topic", "AWS::DynamoDB::Table"]) {
    test(`${type}: uses CloudTrail only`, async () => {
      const at = new Date(daysAgo(4));
      const cw = new FakeClient();
      const ct = new FakeClient({ LookupEventsCommand: () => ({ Events: [{ EventTime: at }] }) });
      const { service } = makeAwsService({ cw, ct });

      assert.equal(await service.determineLastUsed({ ResourceType: type, PhysicalResourceId: "id" }), at.toISOString());
      assert.equal(cw.calls.length, 0);
    });
  }
});

describe("AwsService retryWithBackoff", () => {
  // Called directly with a 1 ms base delay so the tests don't wait for real back-off times.
  const retry = (service: unknown, fn: () => Promise<unknown>, maxRetries = 5) =>
    (service as any).retryWithBackoff(fn, "test call", maxRetries, 1);

  for (const [label, error] of [
    ["ThrottlingException", awsError("ThrottlingException")],
    ["TooManyRequestsException", awsError("TooManyRequestsException")],
    ["'Rate exceeded' message", awsError("Throttling", "Rate exceeded")],
    ["HTTP 500", awsError("InternalError", "boom", 500)],
    ["HTTP 503", awsError("ServiceUnavailable", "down", 503)],
  ] as const) {
    test(`retries on ${label} and then succeeds`, async () => {
      const { service, logger } = makeAwsService();
      let calls = 0;
      const result = await retry(service, async () => { if (++calls < 3) throw error; return "ok"; });

      assert.equal(result, "ok");
      assert.equal(calls, 3);
      assert.equal(logger.messages("warn").filter(m => m.startsWith("Retryable error")).length, 2);
    });
  }

  test("retries networking errors", async () => {
    const { service } = makeAwsService();
    let calls = 0;
    const result = await retry(service, async () => {
      if (++calls === 1) { const e: any = new Error("socket hang up"); e.code = "NetworkingError"; throw e; }
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  for (const name of ["AccessDeniedException", "ValidationError", "ResourceNotFoundException"]) {
    test(`does not retry ${name}`, async () => {
      const { service, logger } = makeAwsService();
      let calls = 0;
      await assert.rejects(retry(service, async () => { calls++; throw awsError(name); }), { name });

      assert.equal(calls, 1);
      assert.ok(logger.messages("error").some(m => m.includes("test call failed after 0 retries")));
    });
  }

  test("gives up after the maximum number of attempts", async () => {
    const { service } = makeAwsService();
    let calls = 0;
    await assert.rejects(retry(service, async () => { calls++; throw awsError("ThrottlingException"); }, 3), { name: "ThrottlingException" });
    assert.equal(calls, 3);
  });
});
