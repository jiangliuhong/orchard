export interface SourceMatch { file: string; line: number; column: number; length: number; }

/** Literal, case-insensitive search with offsets suitable for source highlighting. */
export function searchSourceFiles(files: readonly { path: string; code: string }[], query: string, limit = Number.POSITIVE_INFINITY): SourceMatch[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const result: SourceMatch[] = [];
  for (const file of files) {
    const lines = file.code.split("\n");
    for (let index = 0; index < lines.length; index++) {
      for (const match of lines[index]!.matchAll(pattern)) {
        if (result.length >= limit) return result;
        result.push({ file: file.path, line: index + 1, column: match.index!, length: match[0].length });
      }
    }
  }
  return result;
}
