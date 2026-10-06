import { IRequest } from "../../domain/interfaces/IRequest";
import { GenerateResourceReportResponse } from "./GenerateResourceReportResponse ";

export class GenerateResourceReportRequest implements IRequest<GenerateResourceReportResponse> {
  constructor( public readonly region : string = process.env.AWS_REGION || "ap-southeast-2", public readonly stackName?: string) {} 
}