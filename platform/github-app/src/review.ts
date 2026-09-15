import { ApiError, github, record } from "./github";

// Same contract as PR #288 (f72a4b3); no CLI/Node entry point in the Worker.
export const LABELS = [
  "review-level: low",
  "review-level: medium",
  "review-level: high",
  "review-level: xhigh",
  "review-level: unavailable",
] as const;
export type Label = (typeof LABELS)[number];
export function scoreToLabel(score: unknown): Label {
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 100
  )
    return LABELS[4];
  return score < 40
    ? LABELS[0]
    : score < 70
      ? LABELS[1]
      : score < 90
        ? LABELS[2]
        : LABELS[3];
}
export async function labels(
  api: ReturnType<typeof github>,
  path: string,
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  for (let page = 1; page <= 100; page++) {
    const body = await api(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(body)) throw new Error("Invalid label list");
    for (const value of body) {
      const label = record(value);
      if (typeof label.name !== "string") throw new Error("Invalid label");
      result.set(label.name, label);
    }
    if (body.length < 100) return result;
  }
  throw new Error("Label pagination exceeded limit");
}
export async function initializeLabels(
  api: ReturnType<typeof github>,
  repository: string,
) {
  const path = `/repos/${repository}/labels`;
  const existing = await labels(api, path);
  for (const name of LABELS) {
    if (existing.has(name)) {
      if (existing.get(name)?.archived === true)
        throw new Error(`Unarchive repository label: ${name}`);
      continue;
    }
    if (
      [...existing.keys()].some((x) => x.toLowerCase() === name.toLowerCase())
    )
      throw new Error(`Rename repository label to exact spelling: ${name}`);
    try {
      await api(path, "POST", {
        name,
        color: "ededed",
        description:
          name === LABELS[4]
            ? "ghfind author score unavailable (not zero)"
            : "ghfind author score; see https://ghfind.com",
      });
    } catch (error) {
      // An ambiguous write is retried as a complete reconciliation. A 422 can
      // be a concurrent initializer; verify the exact label, preserving owner settings.
      if (!(error instanceof ApiError && error.status === 422)) throw error;
      const found = record(await api(`${path}/${encodeURIComponent(name)}`));
      if (found.name !== name || found.archived === true) throw error;
    }
  }
}
export async function syncLabel(
  api: ReturnType<typeof github>,
  repository: string,
  pr: number,
  target: Label,
) {
  const path = `/repos/${repository}/issues/${pr}/labels`;
  const current = await labels(api, path);
  if (!current.has(target)) await api(path, "POST", { labels: [target] });
  for (const name of LABELS)
    if (name !== target && current.has(name)) {
      try {
        await api(`${path}/${encodeURIComponent(name)}`, "DELETE");
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
    }
}
