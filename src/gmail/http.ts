// The injectable fetch that keeps tests offline, and one readable shape for a failed Google answer, so a
// token exchange and a thread read report the same way in the terminal.

export type FetchLike = typeof globalThis.fetch;

export async function describeHttpFailure(
  response: Response,
  action: string,
): Promise<{ detail: string; message: string }> {
  let detail = "";
  try {
    detail = (await response.text()).replace(/\s+/gu, " ").trim().slice(0, 500);
  } catch {
    /* Status is enough. */
  }
  return {
    detail,
    message: `${action} failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
  };
}
