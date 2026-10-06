import { RuntimeInfo } from "./RuntimeInfo";

export interface ResourceInfo {
  stackName: string;
  resourceName: string;
  resourceType: string;
  exists: boolean;
  lastUsed?: string | null;
  usedInLast30Days?: boolean;
  runtimeInfo?: RuntimeInfo
}