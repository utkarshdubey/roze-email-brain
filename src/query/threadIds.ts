// Thread ownership comes from a thread path or a published list row; citations can name several threads.
const THREAD_PATH = /^(?:evidence\/)?threads\/([0-9a-f]{8,})\.md$/iu;
const YEAR_ROW = /^([0-9a-f]{8,}) \|/iu;
const CITATION = /\[t:([0-9a-f]{8,})(?=\s|\])/giu;

export function directThreadId(path: string, text: string): string | null {
  return (THREAD_PATH.exec(path)?.[1] ?? YEAR_ROW.exec(text)?.[1] ?? null)?.toLowerCase() ?? null;
}

export function threadIdsInSearchHit(path: string, text: string): string[] {
  const ids: string[] = [];
  const pathId = THREAD_PATH.exec(path)?.[1];
  const rowId = YEAR_ROW.exec(text)?.[1];
  if (pathId) ids.push(pathId);
  if (rowId) ids.push(rowId);
  for (const match of text.matchAll(CITATION)) ids.push(match[1]!);
  return [...new Set(ids)];
}
