import "reflect-metadata";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Container } from "inversify";
import { Mediator } from "../../src/infrastructure/Mediator";
import { TYPES } from "../../src/infrastructure/di/types";
import { getHandlerSymbol } from "../../src/infrastructure/di/handlerMapper";
import { GenerateResourceReportRequest } from "../../src/application/reports/GenerateResourceReportRequest";

describe("getHandlerSymbol", () => {
  test("maps GenerateResourceReportRequest to its handler", () => {
    assert.equal(getHandlerSymbol("GenerateResourceReportRequest"), TYPES.GenerateResourceReportHandler);
  });

  test("throws for an unknown request", () => {
    assert.throws(() => getHandlerSymbol("DeleteEverythingRequest"), /No handler registered for request: DeleteEverythingRequest/);
  });
});

describe("Mediator", () => {
  test("sends a request to the registered handler and returns its response", async () => {
    const received: unknown[] = [];
    const container = new Container();
    container.bind(TYPES.GenerateResourceReportHandler).toConstantValue({
      handle: async (request: unknown) => { received.push(request); return "report"; },
    });
    const mediator = new Mediator(container);
    const request = new GenerateResourceReportRequest("eu-west-1", "my-stack");

    assert.equal(await mediator.send(request), "report");
    assert.deepEqual(received, [request]);
  });

  test("rejects a request type that has no handler", async () => {
    class UnknownRequest {}
    const mediator = new Mediator(new Container());
    await assert.rejects(mediator.send(new UnknownRequest() as any), /No handler registered for request: UnknownRequest/);
  });

  test("passes handler errors back to the caller", async () => {
    const container = new Container();
    container.bind(TYPES.GenerateResourceReportHandler).toConstantValue({
      handle: async () => { throw new Error("handler failed"); },
    });
    await assert.rejects(new Mediator(container).send(new GenerateResourceReportRequest("x")), /handler failed/);
  });
});

describe("GenerateResourceReportRequest", () => {
  test("uses the given region and stack name", () => {
    const request = new GenerateResourceReportRequest("us-west-2", "stack");
    assert.equal(request.region, "us-west-2");
    assert.equal(request.stackName, "stack");
  });

  test("defaults the region from AWS_REGION, then ap-southeast-2", () => {
    const saved = process.env.AWS_REGION;
    try {
      process.env.AWS_REGION = "eu-central-1";
      assert.equal(new GenerateResourceReportRequest().region, "eu-central-1");
      delete process.env.AWS_REGION;
      assert.equal(new GenerateResourceReportRequest().region, "ap-southeast-2");
    } finally {
      if (saved === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = saved;
    }
  });
});
