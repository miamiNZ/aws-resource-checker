import "reflect-metadata";
import fs from "fs";
import os from "os";
import path from "path";
import Bottleneck from "bottleneck";
import { AwsService } from "../src/infrastructure/services/AwsService";
import { ILogger } from "../src/domain/interfaces/ILogger";

export type LogEntry = { level: string; message: string; args: unknown[] };

/** Logger that records every call so tests can assert on what was logged. */
export class RecordingLogger implements ILogger {
  entries: LogEntry[] = [];
  info(message: string, ...args: unknown[]) { this.entries.push({ level: "info", message, args }); }
  warn(message: string, ...args: unknown[]) { this.entries.push({ level: "warn", message, args }); }
  error(message: string, ...args: unknown[]) { this.entries.push({ level: "error", message, args }); }
  debug(message: string, ...args: unknown[]) { this.entries.push({ level: "debug", message, args }); }
  success(message: string, ...args: unknown[]) { this.entries.push({ level: "success", message, args }); }

  messages(level?: string): string[] {
    return this.entries.filter(e => !level || e.level === level).map(e => e.message);
  }
}

type CommandHandler = (input: any, callNumber: number) => unknown | Promise<unknown>;

/**
 * Fake AWS SDK v3 client. Handlers are keyed by command class name
 * (e.g. "ListStacksCommand"). Every call is recorded with its input.
 * A handler that throws (or returns a rejected promise) simulates an AWS error.
 */
export class FakeClient {
  calls: { command: string; input: any }[] = [];
  constructor(private handlers: Record<string, CommandHandler> = {}) {}

  async send(command: { constructor: { name: string }; input: any }): Promise<any> {
    const name = command.constructor.name;
    // Copy the input: the code under test reuses and mutates Date objects between calls,
    // while the real SDK serialises the request at send time.
    this.calls.push({ command: name, input: structuredClone(command.input) });
    const handler = this.handlers[name];
    if (!handler) throw new Error(`FakeClient: no handler for ${name}`);
    const callNumber = this.calls.filter(c => c.command === name).length;
    return handler(command.input, callNumber);
  }

  callsTo(command: string) {
    return this.calls.filter(c => c.command === command);
  }
}

/** Build an AWS SDK style error (name + optional HTTP status). */
export function awsError(name: string, message = name, httpStatusCode?: number): Error {
  const err: any = new Error(message);
  err.name = name;
  if (httpStatusCode) err.$metadata = { httpStatusCode };
  return err;
}

export type AwsClients = {
  cf: FakeClient; cw: FakeClient; ct: FakeClient; lambda: FakeClient; rds: FakeClient;
  ec2: FakeClient; s3: FakeClient; sts: FakeClient; sqs: FakeClient;
};

/**
 * Create an AwsService wired to fake clients. The 200 ms Bottleneck rate limiter
 * is replaced with an unthrottled one, and retry back-off starts at 1 ms, so tests run fast.
 */
export function makeAwsService(overrides: Partial<AwsClients> = {}) {
  const clients: AwsClients = {
    cf: new FakeClient(), cw: new FakeClient(), ct: new FakeClient(), lambda: new FakeClient(),
    rds: new FakeClient(), ec2: new FakeClient(), s3: new FakeClient(), sts: new FakeClient(),
    sqs: new FakeClient(), ...overrides,
  };
  const logger = new RecordingLogger();
  const service = new AwsService(
    clients.cf as any, logger, clients.cw as any, clients.ct as any, clients.lambda as any,
    clients.rds as any, clients.ec2 as any, clients.s3 as any, clients.sts as any, clients.sqs as any,
  );
  (service as any).limiter = new Bottleneck();
  (service as any).retryBaseDelayMs = 1;
  return { service, clients, logger };
}

/** Make a fresh temp directory and chdir into it. Returns a cleanup function. */
export function useTempCwd(prefix = "arc-test-"): { dir: string; restore: () => void } {
  const original = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.chdir(dir);
  return {
    dir,
    restore: () => {
      process.chdir(original);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Poll until the predicate is true (for code that writes files without awaiting). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise(r => setTimeout(r, 10));
  }
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
