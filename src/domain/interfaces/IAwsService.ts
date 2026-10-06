import { StackResourceSummary } from "@aws-sdk/client-cloudformation";
import { RuntimeInfo } from "../models/RuntimeInfo";

export interface IAwsService {
  listAllStacks(): Promise<string[]>;
  listStackResources(stackName: string): Promise<StackResourceSummary[]>;
  getLambdaLastInvocation(functionName: string): Promise<string | null>;
  getLastEventFromCloudTrail(resourceId: string): Promise<string | null>;
  isSupportedResourceType(resourceType: string): boolean;
  determineLastUsed(resource: { ResourceType: string; PhysicalResourceId?: string }): Promise<string | null>
  getAwsAccountId(): Promise<{accountId: string, accountName: string | null}>
  getResourceInfo(resource: { ResourceType: string; PhysicalResourceId?: string }): Promise<RuntimeInfo>;
}