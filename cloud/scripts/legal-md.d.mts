export declare class LegalSyntaxError extends Error {
  readonly line: number;
  constructor(line: number, why: string);
}

export declare function renderLegal(
  md: string,
  o: { strict: boolean; links: Record<string, string> },
): { title: string; html: string; placeholders: string[]; marks: { line: number; text: string }[]; draft: boolean };
