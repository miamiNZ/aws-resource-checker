import { injectable } from "inversify";
import path from "path";
import { ILogger } from "../../domain/interfaces/ILogger";
import * as fs from "fs/promises";
import util from "util";
@injectable()
export class FileLogger implements ILogger {
  private logFilePath: string;
  // Writes are chained so each one waits for the logs folder to exist and lines stay in order.
  private pendingWrites: Promise<void>;
  constructor(logsDirName  = "logs") {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFileName = `app-${timestamp}.log`;
    const logsDir = path.join(process.cwd(), logsDirName);
    this.pendingWrites = this.ensureLogsDirectory(logsDir);
    this.logFilePath = path.join(logsDir, logFileName);
  }

  private async ensureLogsDirectory(dir: string) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      console.error(`Failed to create logs directory ${dir}:`, err);
    }
  }

  private writeLog(level: string, message: string, ...args: any[]): Promise<void> {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length ? args.map(a => util.inspect(a, { depth: 3, colors: false })).join(" ") : "";
    const formatted = `[${timestamp}] [${level}] ${message} ${formattedArgs}\n`;
    this.pendingWrites = this.pendingWrites.then(async () => {
      try {
        await fs.appendFile(this.logFilePath, formatted, "utf8");
      } catch (err) {
        console.error("Failed to write log to file:", err);
      }
    });
    return this.pendingWrites;
  }

  /** Resolves once every log line written so far is on disk. */
  flush(): Promise<void> {
    return this.pendingWrites;
  }

  info(message: string, ...args: any[]) {
    this.writeLog("INFO", message, ...args).catch(err => console.error("Logger failed:", err));
  }

  warn(message: string, ...args: any[]) {
    this.writeLog("WARN", message, ...args).catch(err => console.error("Logger failed:", err));
  }

  error(message: string, ...args: any[]) {
    this.writeLog("ERROR", message, ...args).catch(err => console.error("Logger failed:", err));
  }

  debug(message: string, ...args: any[]) {
    this.writeLog("DEBUG", message, ...args).catch(err => console.error("Logger failed:", err));
  }
  
  success(message: string, ...args: any[]) {
    this.writeLog("SUCCESS", message, ...args).catch(err => console.error("Logger failed:", err));
  }

}