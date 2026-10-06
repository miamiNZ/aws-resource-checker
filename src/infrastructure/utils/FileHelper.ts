import path from "path";
import fs from "fs/promises";
export class FileHelper {
  private reportsDir: string;
  // Placeholder for potential file helper methods
  constructor() {
    this.reportsDir = path.join(process.cwd(), "reports");
  }

  async readFile(fileName: string): Promise<string> {
    const filePath = path.isAbsolute(fileName)
    ? fileName
    : path.join(process.cwd(), "reports", fileName)  
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return content;
    } catch (err) {
      console.error(`Failed to read file at ${filePath}:`, err);
      throw err;
    }
  }

  async saveJsonFile<T extends object>(fileName: string, data: T): Promise<{success: boolean, filepath? :string | null}> {
    let jsonContent: string;
    try {
      jsonContent = JSON.stringify(data, null, 2);
    } catch (err) {
      console.error(`Invalid JSON content detected:`, err);
      return {success: false};
    }
    return await this.saveFile(fileName, jsonContent);
  }

  async saveFile(fileName: string, data: string | Buffer, options?: { encoding?: BufferEncoding }): Promise<{success: boolean, filepath? :string | null}> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = path.extname(fileName) || ".txt";
    const baseName = path.basename(fileName, ext);
    const dir = path.isAbsolute(fileName) ? path.dirname(fileName) : path.join(process.cwd(), "reports");
    const filePath = path.isAbsolute(fileName) ? fileName: path.join(dir, `${baseName}-${timestamp}${ext}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      const encoding = typeof data === "string" ? options?.encoding ?? "utf-8" : undefined;
      await fs.writeFile(filePath, data, encoding);
      console.log(`File saved: ${filePath}`)
      return {success: true, filepath: filePath};
    } catch (err) {
      console.error(`Failed to create file at ${filePath}:`, err);
      return {success: false};
    }
  }
}