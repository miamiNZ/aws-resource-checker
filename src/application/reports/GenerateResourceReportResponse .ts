import { ResourceInfo } from "../../domain/models/ResourceInfo";

export class GenerateResourceReportResponse {
  constructor(
    public readonly accountId: string,
    public readonly accountName: string | null,
    public readonly region: string,
    public readonly generatedAt: Date,
    public readonly resources: ResourceInfo[]
  ) {}
}