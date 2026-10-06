import { inject, injectable } from "inversify";
import { IHandler } from "../../domain/interfaces/IHandler";
import { GenerateResourceReportRequest } from "./GenerateResourceReportRequest";
import { GenerateResourceReportResponse } from "./GenerateResourceReportResponse ";
import { TYPES } from "../../infrastructure/di/types";
import { IAwsService } from "../../domain/interfaces/IAwsService";
import { ILogger } from "../../domain/interfaces/ILogger";
import { ResourceInfo } from "../../domain/models/ResourceInfo";
import { StackResourceSummary } from "@aws-sdk/client-cloudformation";
import pLimit from "p-limit";

@injectable()
export class GenerateResourceReportHandler 
  implements IHandler<GenerateResourceReportRequest, GenerateResourceReportResponse> {
    constructor(
      @inject(TYPES.IAwsService) private awsService: IAwsService,
      @inject(TYPES.ILogger) private logger: ILogger
  ) {}

  async handle(request: GenerateResourceReportRequest): Promise<GenerateResourceReportResponse> {
    const {accountId, accountName} = await this.awsService.getAwsAccountId();
    const region = request.region || process.env.AWS_REGION || "ap-southeast-2";
    const stackNameFilter = request.stackName||"";
    const generatedAt = new Date();
    this.logger.info("Fetching stacks...");
    const allResults: ResourceInfo[] = [];

    const stacks =  await this.awsService.listAllStacks();
    const stacksToProcess = stackNameFilter ? stacks.filter(s => s?.toLowerCase().includes(stackNameFilter.toLowerCase())): stacks;
    if (stackNameFilter && stacksToProcess.length === 0) {
        this.logger.warn(`Stack '${stackNameFilter}' not found. No stacks to process.`);
        return new GenerateResourceReportResponse(accountId, accountName, region, generatedAt, []);
    }
    const concurrency = 4;
    const stackBatches = this.chunkArray(stacksToProcess, concurrency)
    for (const batch of stackBatches) {
      this.logger.info(`Processing batch of stacks: ${batch.join(", ")}`);
      const batchResults = await Promise.allSettled(
        batch.map(async (stack) => this.processStack(stack!))
      );

      batchResults.forEach(result => {
            if (result.status === "fulfilled") {
                allResults.push(...result.value);
            } else {
                this.logger.error(`Failed to process stack: ${result.reason}`);
            }
        });
    }//end batch for
    
    return new GenerateResourceReportResponse(accountId, accountName, region, generatedAt, allResults);
    
  }
  private async processStack(stackName: string): Promise<ResourceInfo[]> {
    const allResources: ResourceInfo[] = [];
    const resources: StackResourceSummary[] = await this.awsService.listStackResources(stackName);
    const limit = pLimit(5); // only 5 concurrent AWS calls
    // const stackResults: ResourceInfo[] = [];

    const tasks = resources.map(resource => limit(async () => {
      const resourceType = resource.ResourceType!;
      const resourceId = resource.PhysicalResourceId; 
      if (!resourceId || !this.awsService.isSupportedResourceType(resourceType)){
        this.logger?.debug?.(`Skipping resource ${resourceId} ${resourceType} on stack: ${stackName} - unsupported type or missing ID.`);
        return null;
      }
      const [lastUsed ,runtimeInfo] = await Promise.all([
           this.awsService.determineLastUsed({ResourceType: resourceType, PhysicalResourceId: resourceId!}),
           this.awsService.getResourceInfo({ResourceType: resourceType, PhysicalResourceId: resourceId!})
       ]);
      const lastUsedDate = lastUsed ? new Date(lastUsed) : null;
      const usedInLast30Days = !!(lastUsedDate && (Date.now() - lastUsedDate.getTime()) <= 30 * 24 * 3600 * 1000)

      return {
        resourceName: resource.LogicalResourceId ?? "N/A",
        resourceType,
        stackName,
        lastUsed: lastUsed ?? "N/A",
        exists: !!resourceId,
        usedInLast30Days,
        runtimeInfo
      }
    }));

    const results = await Promise.all(tasks);
      for (const res of results) {
        if (res) allResources.push(res);
      }

    this.logger?.info?.(`Completed processing stack: ${stackName} (${allResources.length} valid resources)`)
    return allResources;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }
}