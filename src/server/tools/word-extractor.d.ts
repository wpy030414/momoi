declare module 'word-extractor' {
  export default class WordExtractor {
    extract(buffer: Buffer): Promise<WordDocument>
  }
  export interface WordDocument {
    getBody(): string
    getFootnotes(): string
    getEndnotes(): string
  }
}