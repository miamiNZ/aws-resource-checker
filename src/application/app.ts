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

(async () => {
  const logger = container.get<ILogger>(TYPES.ILogger);
  const mediator = container.get<Mediator>(TYPES.Mediator);
  const fileConversionHelper = container.get<FileConversionHelper>(TYPES.FileConversionHelper);
  const fileHelper = new FileHelper();
  console.log("🚀 Application starting...");
  try
  {
    const request = new GenerateResourceReportRequest()
    let response : GenerateResourceReportResponse | null = null;
    logger.info("Starting AWS Resource Report Process...");
    let jsonFileFilepath: string;
    try
    {
      console.log("⚙️  Processing...");
      response =  await mediator.send(request);
      if (!response) {
        logger.warn("No data returned for AWS Resource Report.");
        return;
      }
      logger.success?.("AWS Resource Report Generated Successfully:");
      if(response.resources.length === 0) {
        logger.warn("No Resources data returned for the AWS Resource Report.");
        return;
      }
      logger.info(`Account ID: ${response?.accountId??""}`);
      logger.info(`Account Name: ${response.accountName}`);
      const jsonFileResult  = await fileHelper.saveJsonFile(`AwsResourceReport-${response.accountName}.json`,response);
      if (jsonFileResult.success) {
        logger.success?.(`JSON report saved successfully at ${jsonFileResult.filepath}.`);
      } else {
        logger.error(`Failed to save JSON report to ${jsonFileResult.filepath}.`);
        return;
      }
      
      const markdownFileResult= await fileConversionHelper.makeMdFileFromFile(jsonFileResult.filepath!, `AwsResourceReport-${response.accountName}.md`);
      if (markdownFileResult.success) {
        logger.success?.(`Markdown report saved successfully at ${markdownFileResult.filepath}.`);
      } else {
        logger.error(`Failed to save Markdown report to ${markdownFileResult.filepath}.`);
        return;
      }

      if (markdownFileResult.success) {
        const pdfFileResult = await fileConversionHelper.convertMdFileToPdf(markdownFileResult.filepath ?? "", `AwsResourceReport-${response.accountName}.pdf`);
        if (markdownFileResult.success) {
          logger.success?.(`PDF report saved successfully at ${pdfFileResult.filepath}.`);
        } else {
          logger.error(`Failed to save PDF report to ${pdfFileResult.filepath}.`);
        }
      }
      logger.info("AWS Resource Report Process completed.");
    }
    catch (err) {
      logger.error("Failed to generate report:", err);
    }
    console.log("✅ Processing complete");
  }
  catch (error) {
    console.error("Fatal error during application startup:", error);
    process.exit(1);
  }
})();