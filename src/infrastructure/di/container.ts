import {Container} from "inversify";
import { TYPES } from "./types";
import { AwsService } from "../services/AwsService";
import { CloudFormation, CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { ILogger } from "../../domain/interfaces/ILogger";
import { ConsoleLogger } from "../services/ConsoleLogger";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudTrailClient } from "@aws-sdk/client-cloudtrail";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { RDSClient } from "@aws-sdk/client-rds";
import { EC2Client } from "@aws-sdk/client-ec2";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { Mediator } from "../Mediator";
import { STSClient } from "@aws-sdk/client-sts";
import { fromIni } from "@aws-sdk/credential-providers";
import { GenerateResourceReportHandler } from "../../application/reports/GenerateResourceReportHandler ";
import { FileLogger } from "../services/FileLogger";
import { FileConversionHelper } from "../../application/utils/FileConversionHelper";

const awsOptions = {
  region: process.env.AWS_REGION || "ap-southeast-2",
  credentials: process.env.AWS_PROFILE || process.env.AWS_SSO_PROFILE
    ? fromIni({ profile: process.env.AWS_PROFILE || process.env.AWS_SSO_PROFILE })
    : undefined, // default SDK chain
};

const container = new Container();
container.bind<Container>(TYPES.Container).toConstantValue(container);

container.bind<CloudFormationClient>(TYPES.CloudFormationClient)
  .toDynamicValue(() => new CloudFormationClient(awsOptions))
  .inSingletonScope();

container.bind<CloudWatchClient>(TYPES.CloudWatchClient)
  .toDynamicValue(() => new CloudWatchClient(awsOptions))
  .inSingletonScope();

container.bind<CloudTrailClient>(TYPES.CloudTrailClient)
  .toDynamicValue(() => new CloudTrailClient(awsOptions))
  .inSingletonScope();

container.bind<LambdaClient>(TYPES.LambdaClient)
  .toDynamicValue(() => new LambdaClient(awsOptions))
  .inSingletonScope();

container.bind<RDSClient>(TYPES.RDSClient)
  .toDynamicValue(() => new RDSClient(awsOptions))
  .inSingletonScope();

container.bind<EC2Client>(TYPES.EC2Client)
  .toDynamicValue(() => new EC2Client(awsOptions))
  .inSingletonScope();

container.bind<S3Client>(TYPES.S3Client)
  .toDynamicValue(() => new S3Client(awsOptions))
  .inSingletonScope();

container.bind<STSClient>(TYPES.STSClient)
  .toDynamicValue(() => new STSClient(awsOptions))
  .inSingletonScope();

container.bind<SQSClient>(TYPES.SQSClient)
  .toDynamicValue(() => new SQSClient(awsOptions))
  .inSingletonScope();

container.bind(TYPES.IAwsService).to(AwsService).inSingletonScope()
container.bind<ILogger>(TYPES.ILogger).to(FileLogger).inSingletonScope();
container.bind<Mediator>(TYPES.Mediator).to(Mediator).inSingletonScope();
// Handlers
container.bind<GenerateResourceReportHandler>(TYPES.GenerateResourceReportHandler).to(GenerateResourceReportHandler);
container.bind<FileConversionHelper>(TYPES.FileConversionHelper).to(FileConversionHelper).inSingletonScope();
export {container};