export interface RuntimeInfo {
  resourceId: string;
  resourceType: string;
  exists: boolean | null;
  lastUsed?: string | null;
  usedInLast30Days?: boolean;
  runtimeLanguage?: string | null;
  runtimeVersion?: string | null;
  deprecated?: boolean;
  encryption?: string | null;
  publicAccessBlocked?: boolean;
  versioningEnabled?: boolean;
  sqsVisibilityTimeout?: number;
  sqsRetentionPeriod?: number;
  sqsHasDLQ?: boolean;
  sqsMessageCount?: number;
  error?: string | null;
}