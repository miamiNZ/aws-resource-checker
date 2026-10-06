export class ResourceReport {
  constructor(
    public stackName: string,
    public resourceLogicalId: string,
    public resourceType: string,
    public physicalResourceId?: string,
    public lastUsed?: string | null,
    public usedInLast30Days: boolean = false
  ) {}
}