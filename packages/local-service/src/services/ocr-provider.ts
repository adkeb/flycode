export interface OcrProvider {
  name: string;
  extractText(_filePath: string): Promise<string>;
}

export class NoopOcrProvider implements OcrProvider {
  public readonly name = "noop";

  async extractText(): Promise<string> {
    throw new Error("OCR is not enabled in v1. This is a placeholder provider.");
  }
}
