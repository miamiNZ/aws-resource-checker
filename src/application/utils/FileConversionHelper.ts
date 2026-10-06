import { inject, injectable } from "inversify";
import { TYPES } from "../../infrastructure/di/types";
import { ILogger } from "../../domain/interfaces/ILogger";
import path from "path";
import puppeteer from "puppeteer";
import { marked } from "marked";
import { FileHelper } from "../../infrastructure/utils/FileHelper";
import { generateMarkdownReportGrouped } from "./generateMarkdownReport";
import { GenerateResourceReportResponse } from "../reports/GenerateResourceReportResponse ";
@injectable()
export class FileConversionHelper {
  constructor(@inject(TYPES.ILogger) private logger: ILogger) {}
  async makeMdFileFromData(data: GenerateResourceReportResponse,filename: string): Promise<{success: boolean, filepath? :string | null}> {
    try {
      const tableMarkdown = generateMarkdownReportGrouped(data);
      if (!tableMarkdown) {
        this.logger.error("Failed to generate Markdown content from data.");
        return { success: false };
      }
      const fileHelper = new FileHelper();
      const { success, filepath } = await fileHelper.saveFile(filename, tableMarkdown, {encoding: "utf-8",});
      return { success, filepath };
    } catch (error) {
      this.logger.error(`Failed to create Markdown file: ${error}`);
      return { success: false };
    }
  }
  async makeMdFileFromFile(jsonFilePath: string, filename: string): Promise<{ success: boolean; filepath?: string | null }> {
    try {
      const fileHelper = new FileHelper();
      const inputPath = path.isAbsolute(jsonFilePath)
        ? jsonFilePath
        : path.join(process.cwd(), "reports", jsonFilePath);

      this.logger.info(`Reading report data from: ${inputPath}`);

      const fileContent = await fileHelper.readFile(inputPath);
      const data = JSON.parse(fileContent) as GenerateResourceReportResponse;
      const reportData = new GenerateResourceReportResponse(
        data.accountId,
        data.accountName,
        data.region,
        new Date(data.generatedAt),
        data.resources
      );
      return this.makeMdFileFromData(reportData, filename);
    } catch (error) {
      this.logger.error(`Failed to create Markdown file from JSON file: ${error}`);
      return { success: false };
    }
  }

  async makeMdContentFromData(data: GenerateResourceReportResponse): Promise<{mdContent:string | null}> {
    try {
      const tableMarkdown = generateMarkdownReportGrouped(data);
      if (!tableMarkdown) {
        this.logger.error("Failed to generate Markdown content from data.");
        return { mdContent: null };
      }
      return { mdContent: tableMarkdown }
    } catch (error) {
      this.logger.error(`Failed to create Markdown content: ${error}`);
      return { mdContent: null };
    }
  }

  async makeMdContentFromFile(jsonFilePath: string, filename: string): Promise<{mdContent:string | null}> {
    try {
      const fileHelper = new FileHelper();
      const inputPath = path.isAbsolute(jsonFilePath)
        ? jsonFilePath
        : path.join(process.cwd(), "reports", jsonFilePath);

      this.logger.info(`Reading report data from: ${inputPath}`);

      const fileContent = await fileHelper.readFile(inputPath);
      const data = JSON.parse(fileContent) as GenerateResourceReportResponse;

      return this.makeMdContentFromData(data);
    } catch (error) {
      this.logger.error(`Failed to create Markdown content from JSON file: ${error}`);
      return { mdContent: null };
    }
  }


  async convertMdContentToPdf(data: string, baseFilename: string): Promise<void> {
    const reportsDir = path.join(process.cwd(), "reports");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(reportsDir, `${baseFilename}-${timestamp}.pdf`);

    try {
      const success = await this.markDownToPdf(data, filePath);
      if (success) {
        this.logger.info(`PDF generated successfully: ${filePath}`);
      } else {
        this.logger.error(`PDF generated failed for: ${filePath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to convert MD to PDF: ${error}`);
      throw error;
    }
  }
  
  async convertMdFileToPdf(mdFilePath: string, fileName: string): Promise<{ success: boolean; filepath?: string | null} > {
    const fileHelper = new FileHelper();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ext = path.extname(fileName) || ".pdf";
    const baseName = path.basename(fileName, ext);
    const dir = path.isAbsolute(fileName) ? path.dirname(fileName) : path.join(process.cwd(), "reports");
    const pdfFilePath = path.isAbsolute(fileName) ? fileName: path.join(dir, `${baseName}-${timestamp}${ext}`);
    try {

      const inputPath = path.isAbsolute(mdFilePath)
        ? mdFilePath
        : path.join(process.cwd(), "reports", mdFilePath);
      this.logger.info(`Reading report data from: ${inputPath}`);

      const mdContent = await fileHelper.readFile(mdFilePath);
      if (!mdContent) {
        this.logger.error(`Markdown file is empty or could not be read: ${mdFilePath}`);
        return { success: false };
      }
      const success = await this.markDownToPdf(mdContent, pdfFilePath);
      if (success) {
        this.logger.info(`PDF generated successfully: ${pdfFilePath}`);
        return { success: true, filepath: pdfFilePath };
      } else {
        this.logger.error(`PDF generated failed for: ${pdfFilePath}`);
        return { success: false, filepath: pdfFilePath };
      }
    } catch (err) {
      this.logger.error(`Failed to convert Markdown file ${mdFilePath} to PDF ${pdfFilePath}`, err);
      return { success: false, filepath: pdfFilePath };
    }  
  }

  private async markDownToPdf(markdownContent: string, pdfFileName: string):Promise<boolean> {
    let browser;
    try {
      const html = marked(markdownContent); // convert Markdown to HTML
      const fullHtml = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <title>AWS Resource Report</title>
          <style>
              body { 
                font-family: Arial, sans-serif;
                margin: 40px;
              }
              table {
                border-collapse: collapse;
                width: 100%;
                font-size: 12px;
                table-layout: fixed;
                word-wrap: break-word;
              }
              th, td {
                border: 1px solid #ccc;
                padding: 8px;
                text-align: left;
              }
              th {
                background: #f2f2f2;
              }
            </style>
        </head>
        <body>
          ${html}
        </body>
        </html>
      `;
      browser = await puppeteer.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(fullHtml, { waitUntil: "load" });
      await page.pdf({
        path: pdfFileName,
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", bottom: "20mm", left: "15mm", right: "15mm" },
      });
      return true;
    } 
    catch (err) {
      this.logger.error(`Error occured during markDown To Pdf conversion`,err);
      return false;
    }
    finally {
      if (browser) {
        await browser.close().catch(err =>this.logger.warn(`Failed to close Puppeteer browser`, err));
      }
    }
  }
}