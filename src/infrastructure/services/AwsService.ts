import { injectable,inject } from "inversify";
import { IAwsService } from "../../domain/interfaces/IAwsService";
import { TYPES } from "../di/types";
import { CloudFormationClient, ListStackResourcesCommand, ListStackResourcesCommandOutput, ListStacksCommand, ListStacksCommandOutput, StackResource, StackResourceSummary  } from "@aws-sdk/client-cloudformation";
import { ILogger } from "../../domain/interfaces/ILogger";
import { ResourceReport } from "../../domain/entities/ResourceReport";
import { GetMetricDataCommandOutput, GetMetricDataCommand, CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudTrailClient, LookupEventsCommand, LookupEventsCommandOutput } from "@aws-sdk/client-cloudtrail";
import { GetFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DescribeDBInstancesCommand, RDSClient } from "@aws-sdk/client-rds";
import { DescribeInstancesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { GetBucketEncryptionCommand, GetBucketVersioningCommand, GetPublicAccessBlockCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { AWS_RESOURCE_TYPES } from "../../domain/constants/awsResourceTypes";
import { GetCallerIdentityCommand, GetCallerIdentityCommandOutput, STSClient } from "@aws-sdk/client-sts";
import { RuntimeInfo } from "../../domain/models/RuntimeInfo";
import { ACCOUNT_NAMES } from "../../domain/constants/accountNames";
import pLimit from "p-limit";
import Bottleneck from "bottleneck";
@injectable()
export class AwsService implements IAwsService {
private static readonly globalLimiter = pLimit(3);
constructor(
  @inject(TYPES.CloudFormationClient) private cf: CloudFormationClient,
  @inject(TYPES.ILogger) private logger: ILogger,
  @inject(TYPES.CloudWatchClient) private cw: CloudWatchClient,
  @inject(TYPES.CloudTrailClient) private ct: CloudTrailClient,
  @inject(TYPES.LambdaClient) private lambda: LambdaClient,
  @inject(TYPES.RDSClient) private rds: RDSClient,
  @inject(TYPES.EC2Client) private ec2: EC2Client,
  @inject(TYPES.S3Client) private s3: S3Client,
  @inject(TYPES.STSClient) private stsClient: STSClient,
  @inject(TYPES.SQSClient) private sqsClient: SQSClient
) {}
  private readonly limiter = new Bottleneck({
    maxConcurrent: 3, // tune for your environment
    minTime: 200, // 200ms between requests
  });

  private ctLimit = pLimit(1); // Only 1 concurrent CloudTrail call

  async getLastEventFromCloudTrail(resourceId: string): Promise<string | null> {
    // Serialize CloudTrail calls
    return this.ctLimit(() => this._getLastEventFromCloudTrail(resourceId));
  }

  async listAllStacks(): Promise<string[]> {
    const stacks: string[] = []; // Replace with actual AWS SDK calls
      let nextToken: string | undefined = undefined;
      try{
        do {
          const command = new ListStacksCommand({NextToken: nextToken});
          const response: ListStacksCommandOutput = await this.retryWithBackoff(() => this.cf.send(command),`ListStacks`);
          (response.StackSummaries || []).forEach(s => {
            if(s.StackStatus && !s.StackStatus.startsWith("DELETE_") && s.StackName){
              stacks.push(s.StackName);
            }
          });// end forEach
          nextToken = response.NextToken;
        } while (nextToken);
        this.logger.info(`Found ${stacks.length} stacks.`)
        return stacks;
      } catch (err) {
        this.logger?.error?.(`Error fetching stacks: ${err}`);
        throw err;
      }
  }
  
  // list resources in a stack
  async listStackResources(stackName: string): Promise<StackResourceSummary[]> {
    let nextToken: string | undefined = undefined;
    const allResources: StackResourceSummary[] = [];
    do
    {
      const command: ListStackResourcesCommand  = new ListStackResourcesCommand({ 
        StackName: stackName, 
        NextToken: nextToken });

      const response = await this.retryWithBackoff(() => this.cf.send(command),`ListStackResources(${stackName})`);
      if (response.StackResourceSummaries) {
        allResources.push(...response.StackResourceSummaries);
      }

      nextToken = response.NextToken;
    } while (nextToken);

    this.logger.info(`Stack ${stackName} has ${allResources.length} resources`);
    return allResources;
  }

  async getLambdaLastInvocation(functionName: string): Promise<string | null> {
    const now = new Date();
    const start = new Date();
    start.setDate(now.getDate() - 360); // Look back 360 days
    const chunkSizeDays = 30; // fetch in 30-day chunks

    let currentStart = new Date(start);
    let lastUsed: string | null = null;
    let chunkEnd = new Date(now); // start from today
    let chunkStart = new Date(chunkEnd);
    chunkStart.setDate(chunkEnd.getDate() - chunkSizeDays);
    try {
      while (chunkEnd > start) {
        if (chunkStart < start) chunkStart.setTime(start.getTime());
        const command = new GetMetricDataCommand({
          StartTime: chunkStart,
          EndTime: chunkEnd,
          MetricDataQueries: [
            {
              Id: "m1",
              MetricStat: {
                Metric: {
                  Namespace: "AWS/Lambda",
                  MetricName: "Invocations",
                  Dimensions: [
                    { Name: "FunctionName", Value: functionName.split(":").pop()! }
                  ]
                },
                Period: 86400, // 1 day
                Stat: "Sum"
              },
              ReturnData: true
            }
          ]
        });
        try {
          const res: GetMetricDataCommandOutput = await this.cw.send(command);
          if (res.MetricDataResults?.length) {
            const data = res.MetricDataResults[0];
            const activePoints = data.Timestamps
              ?.map((t, i) => ({ time: new Date(t), value: data.Values?.[i] ?? 0 }))
              .filter(p => p.value > 0)
              .sort((a, b) => b.time.getTime() - a.time.getTime());
              
            if (activePoints?.length) {
              //set lastUsed to the most recent invocation time and exit loop
              lastUsed = activePoints[0].time.toISOString();
              this.logger.success?.(`Found last used date ${lastUsed} in Cloudwatch for ${functionName}`);
              return lastUsed;
            } //end if activePoints
          } //end if res.MetricDataResults
        }
        catch (err: any) {
          if (err.name === "ThrottlingException") {
            this.logger.warn(`Throttled by CloudWatch, waiting 500ms and retrying chunk ${chunkStart.toISOString()} - ${chunkEnd.toISOString()}`);
            await new Promise(r => setTimeout(r, 500));
            continue; // retry the same chunk
          }
          this.logger.warn(`CloudWatch query failed for ${functionName}: ${err}`);
        }// end catch
        // move backwards one chunk
        chunkEnd.setTime(chunkStart.getTime() - 1000); // minus 1 second to avoid overlap
        chunkStart.setDate(chunkEnd.getDate() - chunkSizeDays);
        await new Promise(r => setTimeout(r, 100)); // small delay to avoid throttling
      } // end while

      return null;
      
    } catch (err) {
      this.logger.error(`Failed CloudWatch query for ${functionName}: ${err}`);
      return null;
    }
  }
  private async _getLastEventFromCloudTrail(resourceId: string): Promise<string | null> {
    try {
      const now = new Date();
      const start = new Date();

      //const maxRetries = 5;
      const baseDelayMs = 500; // initial backoff delay
      let attempt = 0;
      start.setDate(now.getDate() - 360); // Look back 360 days
      const chunkSizeDays = 30;

      let chunkEnd = new Date(now);
      let chunkStart = new Date(chunkEnd);
      chunkStart.setDate(chunkEnd.getDate() - chunkSizeDays);

      while (chunkEnd > start) {
        const currentChunkStart = new Date(chunkStart.getTime());
        const currentChunkEnd = new Date(chunkEnd.getTime());

        if (chunkStart < start) chunkStart.setTime(start.getTime());
        //let attempt = 0;
        try {
          const res = await this.retryWithBackoff(() => this.ct.send(new LookupEventsCommand({
              LookupAttributes: [{ AttributeKey: "ResourceName", AttributeValue: resourceId }],
              MaxResults: 50,
              StartTime: chunkStart,
              EndTime: chunkEnd
            })),
            `CloudTrail chunk ${chunkStart.toISOString()} - ${chunkEnd.toISOString()} for ${resourceId}`
          );
          const events = res.Events || [];
          if (events.length) {
            const newest = events
              .map(e => e.EventTime!)
              .sort((a, b) => b.getTime() - a.getTime())[0];
              this.logger.success?.(`Retrieved CloudTrail events for chunk ${chunkStart.toISOString()} - ${chunkEnd.toISOString()} for resource ${resourceId})`
          );
            return newest.toISOString(); // exit immediately
          }
          else {
            this.logger.debug?.(`No CloudTrail events for resource ${resourceId} in chunk ${chunkStart.toISOString()} - ${chunkEnd.toISOString()}`);
          }
        }
        catch (err) {
          this.logger.error(`Chunk failed for ${resourceId}: ${err}`);
        }

        // move backwards one chunk
        chunkEnd.setTime(chunkStart.getTime() - 1000); // minus 1 second to avoid overlap
        chunkStart.setDate(chunkEnd.getDate() - chunkSizeDays);
        //await new Promise(r => setTimeout(r, 100)); // small delay to avoid throttling
      } // end while
      return null;
    } catch (err) {
      this.logger.warn(`Failed CloudTrail query for ${resourceId}: ${err}`);
      return null;
    }
  }

  async getResourceInfo(resource: { ResourceType: string; PhysicalResourceId?: string }): Promise<RuntimeInfo> {
    const type = resource.ResourceType;
    const id = resource.PhysicalResourceId;
    let info: RuntimeInfo = { 
      resourceId:resource.PhysicalResourceId ?? "NA",
      resourceType:resource.ResourceType,
      exists: false };

    if (!id) return info;
    switch (resource.ResourceType) {
        case "AWS::Lambda::Function": {
          const command = new GetFunctionCommand({ FunctionName: id });
          try {
            const res = await this.retryWithBackoff(() => this.lambda.send(command), `GetFunction(${id})`);
            if (res?.Configuration) {
              info.exists = true;
              const runtime = res.Configuration?.Runtime;
              if (runtime) {
                const parsed = this.parseLambdaRuntime(runtime);
                info.runtimeLanguage = parsed.language;
                info.runtimeVersion = parsed.version;
                info.deprecated = parsed.deprecated;
              }
            }else {
              info.exists = false;
              info.error = `Lambda function ${id} has no configuration.`;
            }
          } catch (err) {
            this.logger?.warn?.(`Failed to fetch Lambda ${id}: ${err}`);
            info.exists = false;
            info.error = `Failed to fetch Lambda: ${err}`;
          }
          break;
        }
        case "AWS::RDS::DBInstance": {
          const command = new DescribeDBInstancesCommand({ DBInstanceIdentifier: id });
          try {
              const res = await this.retryWithBackoff(() => this.rds.send(command), `DescribeDBInstances(${id})`);
              if (res.DBInstances && res.DBInstances.length > 0) {
                info.exists = true;
                const engineVersion = res.DBInstances[0].EngineVersion!;
                const parsed = this.parseRDSEngine(engineVersion);
                info.runtimeLanguage = parsed.language;
                info.runtimeVersion = parsed.version;
                info.deprecated = parsed.deprecated;
              }
              else {
                info.exists = false;
                info.error = `RDS Instance ${id} not found.`;
              }
          } catch (err) {
            this.logger?.warn?.(`Failed to fetch RDS Instance ${id}: ${err}`);
            info.exists = false;
            info.error = `Failed to fetch RDS Instance: ${err}`;
          }
          break;
        }

        case "AWS::EC2::Instance": {
          const command = new DescribeInstancesCommand({ InstanceIds: [id!] });
          try {
              const res = await this.retryWithBackoff(() => this.ec2.send(command), `DescribeInstances(${id})`);
              if (res.Reservations?.length && res.Reservations[0].Instances?.length) {
                info.exists = true;
                info.runtimeLanguage = res.Reservations[0].Instances[0].Platform || "Linux/Unknown";
                info.runtimeVersion = null;
                info.deprecated = false;
              } else {
                info.exists = false;
                info.error = `EC2 Instance ${id} not found.`;
              }
          } catch (err) {
            this.logger?.warn?.(`Failed to fetch EC2 Instance ${id}: ${err}`);
            info.exists = false;
            info.error = `Failed to fetch EC2 Instance: ${err}`;
          }
          break;
        }

        case "AWS::S3::Bucket": {
          const command = new HeadBucketCommand({ Bucket: id });
          const encCommand = new GetBucketEncryptionCommand({ Bucket: id });
          const pubCommand = new GetPublicAccessBlockCommand({ Bucket: id });
          const verCommand = new GetBucketVersioningCommand({ Bucket: id })
          try {
            await this.retryWithBackoff(() => this.s3.send(command), `HeadBucket(${id})`);
            info.exists = true;
            const encryption = await this.retryWithBackoff(() => this.s3.send(encCommand),`GetBucketEncryption(${id})`).catch(() => null); // fallback if bucket has no encryption
            info.encryption = encryption?.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? "None";
            const publicAccess = await this.retryWithBackoff(() => this.s3.send(pubCommand),`GetPublicAccessBlock(${id})`).catch(() => null);
            info.publicAccessBlocked = publicAccess?.PublicAccessBlockConfiguration?.BlockPublicAcls ?? false;
            const versioning = await this.retryWithBackoff(() => this.s3.send(verCommand),`GetBucketVersioning(${id})`);
            info.versioningEnabled = versioning.Status === "Enabled"
            info.runtimeLanguage = null;
            info.runtimeVersion = null;
            info.deprecated = false;
          } catch (err) {
            this.logger?.warn?.(`Failed to fetch S3 bucket ${id}: ${err}`);
            info.exists = false;
            info.error = `Failed to fetch S3 bucket: ${err}`;
          }
          break;
        }
        case "AWS::SQS::Queue":{
          try {
            //const queueUrl = await this.retryWithBackoff(() => this.getQueueUrlByName(id),`GetQueueUrl(${id})`);
            const sqsCommand = new GetQueueAttributesCommand({QueueUrl: id,AttributeNames: ["All"]});
            const sqsResponse = await this.retryWithBackoff(() => this.sqsClient.send(sqsCommand),`GetQueueAttributes(${id})`);

            info.exists = true;
            const attrs = sqsResponse.Attributes || {};
            info.sqsVisibilityTimeout = parseInt(attrs.VisibilityTimeout || "0", 10);
            info.sqsRetentionPeriod = parseInt(attrs.MessageRetentionPeriod || "0", 10);
            info.encryption = attrs.KmsMasterKeyId || "None";
            info.sqsHasDLQ = !!attrs.RedrivePolicy;
            info.sqsMessageCount = parseInt(attrs.ApproximateNumberOfMessages || "0", 10);
          } catch (err) {
            this.logger?.warn?.(`Failed to fetch SQS queue ${id}: ${err}`);
            info.exists = false;
            info.error = `Failed to fetch SQS qeueue: ${err}`;
          }
          break;
        }


        default:
            info.exists = true;
            info.runtimeLanguage = null;
            info.runtimeVersion = null;
            info.deprecated = false;
        }
    return info;
  }

  async determineLastUsed(resource: { ResourceType: string; PhysicalResourceId?: string }): Promise<string | null> {
    if (!resource.PhysicalResourceId) return null;

        if (resource.ResourceType === "AWS::Lambda::Function") {
            const lastInvocation = await this.getLambdaLastInvocation(resource.PhysicalResourceId);
            if (lastInvocation) return lastInvocation;
            return this.getLastEventFromCloudTrail(resource.PhysicalResourceId);
        }

        if (["AWS::EC2::Instance", "AWS::RDS::DBInstance", "AWS::S3::Bucket", "AWS::SQS::Queue", "AWS::SNS::Topic"].includes(resource.ResourceType)) {
            return this.getLastEventFromCloudTrail(resource.PhysicalResourceId);
        }

        // fallback
        return this.getLastEventFromCloudTrail(resource.PhysicalResourceId);
    }

  private DEPRECATED_LAMBDAS: string[] = [
      "nodejs10.x", "nodejs12.x", "python2.7", "python3.6", "java8", "dotnetcore2.1"
  ];

  private DEPRECATED_RDS: string[] = [
      "9.6", "10", "11", "12.3"
  ];

  private parseLambdaRuntime(runtime: string) {
    const parts = runtime.split(/(\d.*)/);
    const language = parts[0].replace(/[^a-zA-Z+#.]/g, "");
    const version = parts[1] || "";
    const deprecated = this.DEPRECATED_LAMBDAS.includes(runtime);
    return { language, version, deprecated };
  }

    // parse RDS engine version
    private parseRDSEngine(engineVersion: string) {
        const version = engineVersion;
        const language = "RDS";
        const deprecated = this.DEPRECATED_RDS.includes(engineVersion);
        return { language, version, deprecated };
    }

  public isSupportedResourceType(resourceType: string): boolean {
    return AWS_RESOURCE_TYPES.includes(resourceType);
  }// end isSupportedResourceType

  public async getAwsAccountId(): Promise<{accountId: string, accountName: string | null}> {
    try
    {
      const command = new GetCallerIdentityCommand({});
      const response: GetCallerIdentityCommandOutput = await this.retryWithBackoff(() => this.stsClient.send(command),`get AWS Account ID`);
      if (!response.Account) {
        throw new Error("Unable to fetch AWS account ID from STS GetCallerIdentity");
      }
      this.logger?.info?.(`Fetched AWS Account ID: ${response.Account}`);
      const accountId = response.Account!;
      const accountName = ACCOUNT_NAMES[accountId] ?? "Unknown Account";
      return { accountId, accountName }
    } catch (err) {
      this.logger?.error?.(`Error fetching AWS account ID: ${err}`);
      throw err;
    }
  }
  private async getQueueUrlByName(queueName: string): Promise<string> {
  try {
    const res = await this.sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!res.QueueUrl) {
      throw new Error(`Queue URL not found for ${queueName}`);
    }
    return res.QueueUrl;
  } catch (err) {
    this.logger?.warn?.(`Failed to get Queue URL for ${queueName}: ${err}`);
    throw err;
  }
}
  private async retryWithBackoff<T>(fn: () => Promise<T>, description: string, maxRetries = 5, baseDelayMs = 500): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try{
        const result = await this.limiter.schedule(fn);
        if (attempt > 0) {
          this.logger.debug?.(`${description} succeeded after ${attempt} retries.`);
        }
        return result;
      }
      catch (err: any) 
      {
        const isThrottled = err?.name === "ThrottlingException" || err?.name === "TooManyRequestsException" || (typeof err?.message === "string" && err.message.includes("Rate exceeded"));
        const isTransient = err?.$metadata?.httpStatusCode >= 500 || err?.code === "NetworkingError"
        const shouldRetry = isThrottled || isTransient;

        if (shouldRetry && attempt < maxRetries - 1) {
          attempt++;
          const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 300;
          this.logger.warn(`Retryable error (${err.name}) on ${description}. Waiting ${delay.toFixed(0)}ms before retry ${attempt}/${maxRetries}.`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // Non-retryable error or max retries reached
        this.logger.error(`${description} failed after ${attempt} retries: ${err}`);
        throw err;
      }// end catch
    } // end while
    throw new Error(`${description} failed after ${maxRetries} retries.`);
  }
} // end class AwsService