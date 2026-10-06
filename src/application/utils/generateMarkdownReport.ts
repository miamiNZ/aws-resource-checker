import { ResourceInfo } from "../../domain/models/ResourceInfo";
import { GenerateResourceReportResponse } from "../reports/GenerateResourceReportResponse ";

export function generateMarkdownReport(resources: ResourceInfo[]): string {
    if (!resources.length) return "No resources found.";
    // Sort by stackName, then lastUsed descending
    const sortedResources = [...resources].sort((a, b) => {
        if (a.stackName !== b.stackName) return a.stackName.localeCompare(b.stackName);
        const dateA = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
        const dateB = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
        return dateB - dateA;
    });

    const headers = [
        "Resource Name",
        "Logical ID",
        "Type",
        "Stack Name",
        "Last Used",
        "Used in Last 30 Days",
        "Runtime",
        "Encryption",
        "Deprecated"
    ];

    const separator = headers.map(() => "---").join(" | ");

    const rows = sortedResources.map(r => [
        r.resourceName,
        r.runtimeInfo?.resourceId ?? "N/A",
        r.resourceType,
        r.stackName,
        r.lastUsed ?? "N/A",
        r.usedInLast30Days ? "✅" : "❌",
        ((r.runtimeInfo?.runtimeLanguage ?? "N/A") + ' - ' + (r.runtimeInfo?.runtimeVersion ?? "N/A")),
        r.runtimeInfo?.encryption ?? "N/A",
        r.runtimeInfo?.deprecated ? "⚠️" : "✅"
    ].join(" | "));

    return `| ${headers.join(" | ")} |\n| ${separator} |\n${rows.map(row => `| ${row} |`).join("\n")}`;
}
export function generateMarkdownReportStackGrouped(report: GenerateResourceReportResponse): string | null {
  const lines: string[] = [];
  try
  {
    // Group resources by stack name
    const resourcesByStack = report.resources.reduce<Record<string, ResourceInfo[]>>((acc, r) => {
      const stack = r.stackName || "N/A";
      if (!acc[stack]) acc[stack] = [];
      acc[stack].push(r);
      return acc;
    }, {});
    lines.push("# AWS Resource Report");
    lines.push("### Account ID: " + report.accountId);
    lines.push("### Account Name: " + (report.accountName ?? "N/A"));
    lines.push("### Region: " + report.region);
    lines.push("### Generated at: " + formatDate(report.generatedAt.toISOString()));
    lines.push(""); // blank line
    for (const [stackName, resources] of Object.entries(resourcesByStack)) {
      lines.push(`#### Stack: ${stackName}`);
      lines.push(""); // blank line after header

      // Table header
      lines.push("| Resource Name | Type | Last Used | 30 Days | Runtime | Version | Encryption | Deprecated |");
      lines.push("|---|---|---|---|---|---|---|---|");

      // Table rows
      for (const r of resources) {
        const lastUsed = formatDate(r.lastUsed ?? null) ?? "N/A";
        const usedIcon = r.usedInLast30Days ? "✅" : "❌";
        const runtime = r.runtimeInfo?.runtimeLanguage ?? "N/A";
        const version = r.runtimeInfo?.runtimeVersion ?? "N/A";
        const encryption = r.runtimeInfo?.encryption ?? "N/A";
        const deprecatedIcon = r.runtimeInfo?.deprecated ? "⚠️" : "✅";
        lines.push(
          `| ${r.resourceName} | ${r.resourceType} | ${lastUsed} | ${usedIcon} | ${runtime} | ${version} | ${encryption} | ${deprecatedIcon} |`
        );
      }
      lines.push(""); // blank line after table
    }
    return lines.join("\n");
  } catch (error) {
    console.error("Error generating table:", error);
    return null;
  }
}
export function generateMarkdownReportGrouped(report: GenerateResourceReportResponse): string | null {
  const lines: string[] = [];
  try {
    // Group resources by stack name
    const resourcesByStack = report.resources.reduce<Record<string, ResourceInfo[]>>((acc, r) => {
      const stack = r.stackName || "N/A";
      if (!acc[stack]) acc[stack] = [];
      acc[stack].push(r);
      return acc;
    }, {});

    lines.push("# AWS Resource Report");
    lines.push(`Account ID: <u>${report.accountId}</u>`);
    lines.push(`Account Name: <u>${report.accountName ?? "N/A"}</u>`);
    lines.push(`Region: <u>${report.region}</u>`);
    lines.push(`Generated: ${formatDate(report.generatedAt.toISOString())}`);
    lines.push(""); // blank line
    lines.push(""); // blank line

    for (const [stackName, resources] of Object.entries(resourcesByStack)) {
      lines.push(`### Stack: <u>${stackName}</u>`);
      lines.push("");
      const resourcesByType = resources.reduce<Record<string, ResourceInfo[]>>((acc, r) => {
        const type = r.resourceType;
        if (!acc[type]) acc[type] = [];
        acc[type].push(r);
        return acc;
      }, {});
      for (const [type, typeResources] of Object.entries(resourcesByType)) {
        lines.push(`##### Resource Type: <u>${type}</u>`);
        lines.push(""); // blank line
        let headers = [];
        switch (type) {
          case "AWS::Lambda::Function":
            headers.push("Resource", "Last Used", "30 Days", "Runtime", "Deprecated","Error");
            break;
          case "AWS::RDS::DBInstance": 
            headers.push("Resource", "Last Used", "30 Days", "Runtime", "Deprecated","Error");
            break;
          case "AWS::EC2::Instance":
            headers.push("Resource", "Last Used", "30 Days", "Runtime", "Deprecated","Error");
            break;
          case "AWS::S3::Bucket": 
            headers.push("Resource", "Last Used", "30 Days", "Deprecated", "Encryption","Public Access", "Versioning Enabled","Error");
            break;
          case "AWS::SQS::Queue" : 
            headers.push("Resource", "Last Used", "30 Days", "Deprecated","Encryption", "DLQ", "Messages","Error",);
            break;
          case "AWS::DynamoDB::Table": 
            headers.push("Resource", "Last Used", "30 Days", "Runtime", "Deprecated","Error");
            //headers.push("Table Status", "Read Capacity", "Write Capacity");
            break;
          default:
            headers.push("Resource", "Last Used", "30 Days", "Runtime", "Deprecated","Error");
            break;
        }
        lines.push("| " + headers.join(" | ") + " |");
        lines.push("|" + headers.map(() => "---").join("|") + "|");
        for (const r of typeResources) {
          const lastUsed = formatDate(r.lastUsed ?? null) ?? "N/A";
          const usedInLast30DaysIcon = r.usedInLast30Days ? "✅" : "❌";
          const deprecatedIcon = r.runtimeInfo?.deprecated ? "⚠️" : "✅";
          const publicAccessBlockedIcon = r.runtimeInfo?.publicAccessBlocked ? "✅" : "⚠️";
          const runtime = `${r.runtimeInfo?.runtimeLanguage ?? "N/A"} - ${r.runtimeInfo?.runtimeVersion ?? ""}`;
          const enc = r.runtimeInfo?.encryption ?? "N/A"
          const versioningEnabledIcon = r.runtimeInfo?.versioningEnabled ? "✅":"❌";
          const sqsDLQIcon = r.runtimeInfo?.sqsHasDLQ ? "✅" : "⚠️";
          const errorIcon = r.runtimeInfo?.error ? "❌" : "✅";
          const sqsMessages = r.runtimeInfo?.sqsMessageCount ?? 0;

          const row: (string | number | boolean)[] = [r.resourceName];
          switch (type) {
            case "AWS::Lambda::Function":
              row.push(lastUsed, usedInLast30DaysIcon,runtime,deprecatedIcon,errorIcon);
              break;
            case "AWS::Lambda::Function":
              row.push(lastUsed, usedInLast30DaysIcon,runtime,deprecatedIcon,errorIcon);
              break;
            case "AWS::S3::Bucket":
              row.push(lastUsed, usedInLast30DaysIcon,deprecatedIcon,enc,publicAccessBlockedIcon,versioningEnabledIcon,errorIcon);
              break;
          case "AWS::SQS::Queue":
            row.push(lastUsed, usedInLast30DaysIcon,deprecatedIcon,enc,sqsDLQIcon,sqsMessages,errorIcon);
              break;
          case "AWS::DynamoDB::Table":
            row.push(r.runtimeInfo?.runtimeLanguage ?? "N/A", r.runtimeInfo?.runtimeVersion ?? "N/A");
              break;
          default:
            row.push(lastUsed, usedInLast30DaysIcon,runtime,deprecatedIcon,errorIcon);
            break;
        }// end switch
        lines.push("| " + row.join(" | ") + " |");
        } // end for resources
        lines.push(""); // blank line after table
      } // end for types 
      lines.push("***"); // blank line after stack
      lines.push(""); // blank line after stack
    } // end for stacks
    return lines.join("\n");
  } catch (error) {
    console.error("Error generating table:", error);
    return null;
  }
}
export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "N/A"; // handle null/undefined
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "N/A"; // invalid date
  return date.toLocaleString("en-NZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}