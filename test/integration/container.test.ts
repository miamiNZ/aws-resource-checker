import "reflect-metadata";
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { useTempCwd, waitFor } from "../helpers";
import fs from "fs";

describe("Dependency injection container", () => {
  // The container's FileLogger creates logs/ in the working directory, so run in a temp folder.
  let temp: ReturnType<typeof useTempCwd>;
  let container: typeof import("../../src/infrastructure/di/container").container;
  let TYPES: typeof import("../../src/infrastructure/di/types").TYPES;

  before(async () => {
    temp = useTempCwd();
    ({ container } = await import("../../src/infrastructure/di/container"));
    ({ TYPES } = await import("../../src/infrastructure/di/types"));
  });
  after(async () => {
    await waitFor(() => fs.existsSync("logs")).catch(() => {});
    temp.restore();
  });

  test("resolves every service the app uses", async () => {
    const { AwsService } = await import("../../src/infrastructure/services/AwsService");
    const { FileLogger } = await import("../../src/infrastructure/services/FileLogger");
    const { Mediator } = await import("../../src/infrastructure/Mediator");
    const { GenerateResourceReportHandler } = await import("../../src/application/reports/GenerateResourceReportHandler ");
    const { FileConversionHelper } = await import("../../src/application/utils/FileConversionHelper");

    assert.ok(container.get(TYPES.IAwsService) instanceof AwsService);
    assert.ok(container.get(TYPES.ILogger) instanceof FileLogger);
    assert.ok(container.get(TYPES.Mediator) instanceof Mediator);
    assert.ok(container.get(TYPES.GenerateResourceReportHandler) instanceof GenerateResourceReportHandler);
    assert.ok(container.get(TYPES.FileConversionHelper) instanceof FileConversionHelper);
  });

  test("singletons are shared; handlers are created per request", () => {
    assert.equal(container.get(TYPES.IAwsService), container.get(TYPES.IAwsService));
    assert.equal(container.get(TYPES.ILogger), container.get(TYPES.ILogger));
    assert.notEqual(container.get(TYPES.GenerateResourceReportHandler), container.get(TYPES.GenerateResourceReportHandler));
  });

  test("AWS clients share the configured region", async () => {
    const clients = [TYPES.CloudFormationClient, TYPES.CloudWatchClient, TYPES.CloudTrailClient, TYPES.LambdaClient,
      TYPES.RDSClient, TYPES.EC2Client, TYPES.S3Client, TYPES.STSClient, TYPES.SQSClient].map(t => container.get<any>(t));
    const regions = await Promise.all(clients.map(c => c.config.region()));
    assert.equal(new Set(regions).size, 1);
  });
});
