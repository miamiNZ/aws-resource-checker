# AWS Resource Checker

A command-line tool that scans the CloudFormation stacks in an AWS account and reports, for each resource:

- when it was **last used** (from CloudWatch metrics and CloudTrail events, up to 360 days back)
- its **runtime or engine version**, and whether that version is **deprecated**
- key **configuration** details (S3 encryption, public access and versioning; SQS timeouts, retention, DLQ and message counts)

Results are written as **JSON**, **Markdown** and **PDF** reports, grouped by stack and then by resource type.

The tool only reads from AWS. It never creates, changes or deletes anything.

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Signing in to AWS](#signing-in-to-aws)
- [Running the tool](#running-the-tool)
- [Output](#output)
- [What gets checked](#what-gets-checked)
- [Required AWS permissions](#required-aws-permissions)
- [Configuration](#configuration)
- [Debugging in VS Code](#debugging-in-vs-code)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | **20.19 or later** | Older versions fail to start. Check with `node --version`. |
| npm | comes with Node | |
| [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) | any v2 | Only needed if you sign in with AWS SSO / IAM Identity Center. |
| `make` | optional | Shortcut commands. Every `make` command below has an `npm` equivalent. |

Google Chrome is downloaded automatically during install (used to create the PDF report). You don't need it installed yourself.

---

## Quick start

```bash
# 1. Clone and enter the repo
git clone https://github.com/miamiNZ/aws-resource-checker.git
cd aws-resource-checker

# 2. Install dependencies and the Chrome build used for PDFs
make install
#   or, without make:
npm ci
npx puppeteer browsers install chrome

# 3. Sign in to AWS (SSO example — see "Signing in to AWS" for other options)
aws sso login --profile my-profile

# 4. Run the report
make run PROFILE=my-profile
#   or, without make:
npm start -- --profile my-profile
```

When it finishes, look in the `reports/` folder for the three report files and in `logs/` for the run log.

> **Tip:** run `make` on its own to list all available commands.

---

## Signing in to AWS

The tool uses the standard AWS credential chain, so any method the AWS CLI supports will work. Pick one.

### Option A — AWS SSO / IAM Identity Center (recommended)

1. If you haven't set up a profile yet, run this once and follow the prompts:

   ```bash
   aws configure sso
   ```

2. Before each session, sign in (tokens expire, usually after 8–12 hours):

   ```bash
   aws sso login --profile my-profile
   ```

3. Run the tool with `--profile my-profile` (or `make run PROFILE=my-profile`).

`make sso PROFILE=my-profile` does steps 2 and 3 in one go.

### Option B — Named profile with access keys

If `~/.aws/credentials` already contains a profile, pass its name with `--profile`, exactly as above.

### Option C — Environment variables

```bash
# macOS / Linux
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...   # only for temporary credentials

# Windows PowerShell
$env:AWS_ACCESS_KEY_ID="..."
$env:AWS_SECRET_ACCESS_KEY="..."
$env:AWS_SESSION_TOKEN="..."
```

Then run the tool **without** `--profile`.

> Never commit credentials to this repository.

---

## Running the tool

| Option | Required | Default | Description |
|---|---|---|---|
| `--profile <name>` | No | AWS default chain | AWS CLI profile to use. |
| `--region <name>` | No | `ap-southeast-2` | Region to scan. Only one region is scanned per run. |

### Using make

```bash
make run                                       # default credentials, ap-southeast-2
make run PROFILE=my-profile                    # named profile
make run PROFILE=my-profile REGION=us-east-1   # named profile, other region
make sso PROFILE=my-profile                    # aws sso login, then run
```

### Using npm

Arguments after `--` are passed to the tool:

```bash
npm start
npm start -- --profile my-profile
npm start -- --profile my-profile --region us-east-1
```

### Compiled build (faster startup)

```bash
make start PROFILE=my-profile
#   or
npm run build
npm run start:dist -- --profile my-profile
```

### How long does it take?

Expect several minutes for a large account. The tool deliberately limits how fast it calls AWS so it doesn't hit API rate limits, and CloudTrail lookups run one at a time. Progress is written to the log file in `logs/`, not to the console.

---

## Output

All files are created in the folder you run the tool from. The folders are created automatically.

| File | Contents |
|---|---|
| `reports/AwsResourceReport-<account>-<timestamp>.json` | Raw data for every resource. |
| `reports/AwsResourceReport-<account>-<timestamp>.md` | Readable report, grouped by stack then resource type. Pastes cleanly into Confluence or other wikis. |
| `reports/AwsResourceReport-<account>-<timestamp>.pdf` | PDF version of the Markdown report. |
| `logs/app-<timestamp>.log` | Everything the run did, including errors. **Check this first if something goes wrong.** |

`<account>` is the friendly account name from [`accountNames.ts`](src/domain/constants/accountNames.ts), or `Unknown Account` if the account ID isn't listed there (see [Configuration](#configuration)).

If the account has no supported resources, no report files are written. The log will say so.

`reports/` and `logs/` are git-ignored, so reports are never committed by accident.

---

## What gets checked

The tool lists every CloudFormation stack in the region (except deleted ones), then every resource in each stack. Resources of the types below are included in the report; all others are skipped.

| Resource type | Extra details collected | "Last used" source |
|---|---|---|
| `AWS::Lambda::Function` | Runtime, version, deprecated? | CloudWatch `Invocations` metric, then CloudTrail |
| `AWS::RDS::DBInstance` | Engine version, deprecated? | CloudTrail |
| `AWS::EC2::Instance` | Platform (Windows, or Linux/Unknown) | CloudTrail |
| `AWS::S3::Bucket` | Encryption, public access block, versioning | CloudTrail |
| `AWS::SQS::Queue` | Visibility timeout, retention period, DLQ, message count | CloudTrail |
| `AWS::SNS::Topic` | — | CloudTrail |
| `AWS::ApiGateway::RestApi` | — | CloudTrail |
| `AWS::ApiGatewayV2::Api` | — | CloudTrail |
| `AWS::DynamoDB::Table` | — | CloudTrail |
| `AWS::CloudFormation::Stack` (nested stacks) | — | CloudTrail |
| `AWS::ECS::Service` | — | CloudTrail |
| `AWS::EKS::Cluster` | — | CloudTrail |

**Deprecated versions** are flagged when they match these lists (edit them in [`AwsService.ts`](src/infrastructure/services/AwsService.ts)):

- Lambda: `nodejs10.x`, `nodejs12.x`, `python2.7`, `python3.6`, `java8`, `dotnetcore2.1`
- RDS: `9.6`, `10`, `11`, `12.3`

> **Note:** CloudTrail's event history only covers the last 90 days of management events. A resource showing no "last used" date may still be in use through data-plane activity (for example S3 object reads), which CloudTrail event history doesn't record.

---

## Required AWS permissions

The simplest option is the AWS managed policy **`ReadOnlyAccess`**.

For a least-privilege policy, the tool calls these actions:

| Service | Actions |
|---|---|
| STS | `sts:GetCallerIdentity` |
| CloudFormation | `cloudformation:ListStacks`, `cloudformation:ListStackResources` |
| CloudWatch | `cloudwatch:GetMetricData` |
| CloudTrail | `cloudtrail:LookupEvents` |
| Lambda | `lambda:GetFunction` |
| RDS | `rds:DescribeDBInstances` |
| EC2 | `ec2:DescribeInstances` |
| S3 | `s3:ListBucket`, `s3:GetEncryptionConfiguration`, `s3:GetBucketPublicAccessBlock`, `s3:GetBucketVersioning` |
| SQS | `sqs:GetQueueUrl`, `sqs:GetQueueAttributes` |

The STS and CloudFormation permissions are required: without them the run stops. Any other missing permission doesn't stop the run. The affected resource is reported with less detail, and the error is written to the log.

---

## Configuration

There's no config file. The settings below live in the source code.

| What | Where | Default |
|---|---|---|
| Account ID → friendly name | [`src/domain/constants/accountNames.ts`](src/domain/constants/accountNames.ts) | Placeholder entries |
| Resource types to include | [`src/domain/constants/awsResourceTypes.ts`](src/domain/constants/awsResourceTypes.ts) | See table above |
| Deprecated runtime / engine lists | [`src/infrastructure/services/AwsService.ts`](src/infrastructure/services/AwsService.ts) (`DEPRECATED_LAMBDAS`, `DEPRECATED_RDS`) | See above |
| Look-back period | `AwsService.ts` | 360 days, queried in 30-day chunks |
| AWS call rate limits | `AwsService.ts` | 3 concurrent calls, 200 ms apart; 1 CloudTrail call at a time |
| Resources processed in parallel per stack | [`GenerateResourceReportHandler .ts`](<src/application/reports/GenerateResourceReportHandler .ts>) | 5 |
| Logger | [`src/infrastructure/di/container.ts`](src/infrastructure/di/container.ts) | `FileLogger` (swap for `ConsoleLogger` to log to the console) |

### Naming your accounts

Edit `accountNames.ts` so reports show a readable name instead of `Unknown Account`:

```ts
export const ACCOUNT_NAMES: Record<string, string> = {
  "111111111111": "production",
  "222222222222": "staging",
};
```

Find your account ID with `aws sts get-caller-identity --profile my-profile`.

> If you fork this repository publicly, consider keeping real account IDs out of it.

---

## Debugging in VS Code

The repo includes [`.vscode/launch.json`](.vscode/launch.json) with two configurations:

- **Debug** — uses your default AWS credentials.
- **Debug SSO** — passes `--profile` and `--region`. Replace `your-sso-profile` with your own profile name first, and run `aws sso login` before starting it.

Set breakpoints in any `.ts` file under `src/`, open the **Run and Debug** panel, and pick a configuration.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `CredentialsProviderError: Could not load credentials from any providers` | No credentials were found. Pass `--profile`, or set environment variables. See [Signing in to AWS](#signing-in-to-aws). |
| `Token is expired. To refresh this SSO session run 'aws sso login'...` | Run `aws sso login --profile <name>` and try again. |
| `Could not resolve credentials using profile: [name] in configuration/credentials file(s)` | The profile name is misspelt, or isn't in `~/.aws/config`. List profiles with `aws configure list-profiles`. |
| `Could not find Chrome` when creating the PDF | Run `npx puppeteer browsers install chrome`. (Newer npm versions can block Puppeteer's automatic download during install.) |
| `npm warn EBADENGINE` during install, or `ERR_REQUIRE_ESM` on start | Node is too old. Upgrade to 20.19 or later. |
| `npm ci` fails saying a lock file is needed | Make sure `package-lock.json` exists (it's committed to the repo). Fall back to `npm install` if needed. |
| `ThrottlingException: Rate exceeded` in the log | Lower the limits in `AwsService.ts` (`maxConcurrent`, or increase `minTime`). |
| The console shows almost nothing | Expected — progress goes to `logs/app-<timestamp>.log`. |
| No report files were created | Check the log. Usually there were no supported resources in that region, or credentials failed. Try `--region`. |
| `make: command not found` (Windows) | Use the `npm` commands instead, or install make (for example `winget install GnuWin32.Make` or `choco install make`). |

---

## Project structure

The code follows a layered (domain-driven) layout and uses the **Mediator** pattern with [InversifyJS](https://inversify.io/) for dependency injection: `app.ts` sends a `GenerateResourceReportRequest` to the `Mediator`, which routes it to `GenerateResourceReportHandler`. New report types can be added as new request/handler pairs without changing existing code.

```
src/
├── application/                  # Use cases and entry point
│   ├── app.ts                    # Entry point: parses CLI args, runs the report, writes files
│   ├── reports/                  # Request, response and handler for the resource report
│   └── utils/                    # Markdown generation and PDF conversion (Puppeteer)
├── domain/                       # Plain types, no AWS dependencies
│   ├── constants/                # Account names, supported resource types
│   ├── entities/, models/        # Report and resource data shapes
│   └── interfaces/               # IAwsService, ILogger, IMediator, IHandler, IRequest
└── infrastructure/               # AWS and system access
    ├── Mediator.ts               # Routes requests to handlers
    ├── di/                       # Inversify container and bindings
    ├── services/                 # AwsService (all AWS calls), ConsoleLogger, FileLogger
    └── utils/                    # FileHelper (writes reports)
```

A full file listing is in [`structure.txt`](structure.txt).

### Other commands

| make | npm | Does |
|---|---|---|
| `make build` | `npm run build` | Compiles TypeScript to `dist/` |
| `make typecheck` | `npm run typecheck` | Checks types without building |
| `make clean` | — | Deletes `dist/` |

---

## Ideas for extending

- Accept a stack-name filter on the command line (the request object already supports `stackName`).
- Scan several regions in one run.
- Collect extra details for DynamoDB, SNS, API Gateway, ECS and EKS.
- Add unit tests for `AwsService` by mocking the AWS SDK clients.
- Export CSV, or upload reports to S3.
