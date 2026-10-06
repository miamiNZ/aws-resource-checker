import yargs from "yargs";
// -----------------
// Parse CLI args
// -----------------
const argv = yargs(process.argv.slice(2))
  .option("profile", { type: "string" })
  .option("region", { type: "string" })
  .parseSync();

if (argv.profile) process.env.AWS_PROFILE = argv.profile;
if (argv.region) process.env.AWS_REGION = argv.region;

import "reflect-metadata";
import { container } from "../infrastructure/di/container";
import { ILogger } from "../domain/interfaces/ILogger";
import { TYPES } from "../infrastructure/di/types";
import { Mediator } from "../infrastructure/Mediator";
import { GenerateResourceReportRequest } from "./reports/GenerateResourceReportRequest";
import { GenerateResourceReportResponse } from "./reports/GenerateResourceReportResponse ";
import { FileHelper } from "../infrastructure/utils/FileHelper";
import { FileConversionHelper } from "./utils/FileConversionHelper";

// Provide default region if not passed
if (!process.env.AWS_REGION) process.env.AWS_REGION = "ap-southeast-2";

type RunOutcome = { status: "success" | "warning" | "failed"; message: string };

// Print the final result and set the exit code so failures are visible on the console and to scripts.
function reportOutcome(outcome: RunOutcome) {
  const message = outcome.message.replace(/\.+$/, "");
  if (outcome.status === "success") {
    console.log(`Processing complete: ${message}`);
  } else if (outcome.status === "warning") {
    console.warn(`Processing finished with warnings: ${message}. See logs/ for details.`);
  } else {
    console.error(`Processing failed: ${message}. See logs/ for details.`);
    process.exitCode = 1;
  }
}

(async () => {
  const logger = container.get<ILogger>(TYPES.ILogger);
  const mediator = container.get<Mediator>(TYPES.Mediator);
  const fileConversionHelper = container.get<FileConversionHelper>(TYPES.FileConversionHelper);
  const fileHelper = new FileHelper();
  console.log("Application starting...");
  try
  {
    const request = new GenerateResourceReportRequest()
    let response : GenerateResourceReportResponse | null = null;
    logger.info("Starting AWS Resource Report Process...");
    // Outcome shown on the console when the run ends; every exit path below sets it.
    let outcome: RunOutcome = { status: "failed", message: "Processing stopped unexpectedly" };
    try
    {
      console.log("Processing...");
      response =  await mediator.send(request);
      if (!response) {
        logger.warn("No data returned for AWS Resource Report.");
        outcome = { status: "warning", message: "No data returned, so no reports were created" };
        return;
      }
      logger.success?.("AWS Resource Report Generated Successfully:");
      if(response.resources.length === 0) {
        logger.warn("No Resources data returned for the AWS Resource Report.");
        outcome = { status: "warning", message: `No supported resources found in ${request.region}, so no reports were created` };
        return;
      }
      logger.info(`Account ID: ${response?.accountId??""}`);
      logger.info(`Account Name: ${response.accountName}`);
      const jsonFileResult  = await fileHelper.saveJsonFile(`AwsResourceReport-${response.accountName}.json`,response);
      if (jsonFileResult.success) {
        logger.success?.(`JSON report saved successfully at ${jsonFileResult.filepath}.`);
      } else {
        logger.error(`Failed to save JSON report to ${jsonFileResult.filepath}.`);
        outcome = { status: "failed", message: "Could not save the JSON report" };
        return;
      }

      const markdownFileResult= await fileConversionHelper.makeMdFileFromFile(jsonFileResult.filepath!, `AwsResourceReport-${response.accountName}.md`);
      if (markdownFileResult.success) {
        logger.success?.(`Markdown report saved successfully at ${markdownFileResult.filepath}.`);
      } else {
        logger.error(`Failed to save Markdown report to ${markdownFileResult.filepath}.`);
        outcome = { status: "failed", message: "JSON report saved, but the Markdown report could not be created" };
        return;
      }

      const pdfFileResult = await fileConversionHelper.convertMdFileToPdf(markdownFileResult.filepath ?? "", `AwsResourceReport-${response.accountName}.pdf`);
      if (pdfFileResult.success) {
        logger.success?.(`PDF report saved successfully at ${pdfFileResult.filepath}.`);
      } else {
        logger.error(`Failed to save PDF report to ${pdfFileResult.filepath}.`);
        outcome = { status: "failed", message: "JSON and Markdown reports saved, but the PDF could not be created" };
        return;
      }
      logger.info("AWS Resource Report Process completed.");
      outcome = { status: "success", message: `${response.resources.length} resources reported. Files saved to reports/` };
    }
    catch (err) {
      logger.error("Failed to generate report:", err);
      outcome = { status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    finally {
      reportOutcome(outcome);
    }
  }
  catch (error) {
    console.error("Fatal error during application startup:", error);
    process.exit(1);
  }
})();