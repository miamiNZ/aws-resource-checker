import { injectable } from "inversify";
import { ILogger } from "../../domain/interfaces/ILogger";

@injectable()
export class ConsoleLogger implements ILogger {
  private getTimestamp(): string {
    const now = new Date();
    const date = now.toISOString().split("T")[0];
    const time = now.toTimeString().split(" ")[0];
    return `${date} ${time}`;
  }

  info(message: string, ...args: any[]) {
    console.log(`[${this.getTimestamp()}] [INFO] ℹ️ ${" "}${message}`, ...args);
  }

  warn(message: string, ...args: any[]) {
    console.warn(`[${this.getTimestamp()}] [WARN] ⚠️ ${" "}${message}`, ...args);
  }

  error(message: string, ...args: any[]) {
    console.error(`[${this.getTimestamp()}] [ERROR] ❌ ${" "}${message}`, ...args);
  }

  debug(message: string, ...args: any[]) {
    console.debug(`[${this.getTimestamp()}] [DEBUG] ⚙️ ${" "}${message}`, ...args);
  }
  
  success(message: string, ...args: any[]) {
    console.error(`[${this.getTimestamp()}] [SUCCESS] ✅ ${" "}${message}`, ...args);
  }
}