/**
 * FlyCode Note: OCR extension point
 * Provides reserved interfaces for future OCR providers without coupling current v1 behavior.
 */
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
