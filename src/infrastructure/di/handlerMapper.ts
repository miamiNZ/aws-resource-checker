import { TYPES } from "./types";
export function getHandlerSymbol(requestName: string): symbol {
  switch (requestName) {
    case "GenerateResourceReportRequest":
      return TYPES.GenerateResourceReportHandler;
    default:
      throw new Error(`No handler registered for request: ${requestName}`);
  }
}