import { ApiError, github, record, positive } from "./github";

// Same contract as PR #288 (f72a4b3); no CLI/Node entry point in the Worker.
export const LABELS = [
  "review-level: low",
  "review-level: medium",
  "review-level: high",
  "review-level: xhigh",
  "review-level: unavailable",
] as const;
export type Label = (typeof LABELS)[number];
export const LABEL_COLORS: Record<Label, string> = {
  "review-level: low": "d9dee3",
  "review-level: medium": "b6dfff",
  "review-level: high": "ff922b",
  "review-level: xhigh": "ffc400",
  "review-level: unavailable": "c3c7ce",
};
const labelDescription = (name: Label) =>
  name === LABELS[4]
    ? "ghfind author score unavailable (not zero)"
    : "ghfind author score; see https://ghfind.com";
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
      // Upgrade only our original all-grey defaults; preserve owner customization.
      const label = existing.get(name)!;
      if (
        String(label.color).toLowerCase() === "ededed" &&
        label.description === labelDescription(name)
      )
        await api(`${path}/${encodeURIComponent(name)}`, "PATCH", {
          color: LABEL_COLORS[name],
        });
      continue;
    }
    if (
      [...existing.keys()].some((x) => x.toLowerCase() === name.toLowerCase())
    )
      throw new Error(`Rename repository label to exact spelling: ${name}`);
    try {
      await api(path, "POST", {
        name,
        color: LABEL_COLORS[name],
        description: labelDescription(name),
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

export const COMMENT_MARKER = "<!-- ghfind-review:author-score:v1 -->";
export function scoreComment(login: string, score: unknown): string {
  if (!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(login))
    throw new Error("Invalid author login");
  const label = scoreToLabel(score);
  const ranges: Record<Label, string> = {
    "review-level: low": "0 ≤ score < 40",
    "review-level: medium": "40 ≤ score < 70",
    "review-level: high": "70 ≤ score < 90",
    "review-level: xhigh": "90 ≤ score ≤ 100",
    "review-level: unavailable": "Unavailable — no score interval",
  };
  const available = label !== LABELS[4];
  const author = login.replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `${COMMENT_MARKER}
### ghfind author profile

| Profile | Score | Level | Score interval |
| --- | --- | --- | --- |
| [${author}](https://ghfind.com/en/u/${encodeURIComponent(login)}) | ${available ? `${score} / 100` : "Unavailable"} | \`${label}\` | ${ranges[label]} |

${available ? "The label reflects the author's public GitHub profile at processing time." : "The score could not be obtained. Unavailable does not mean zero."}
This profile score is not a review of the issue or PR content, or a merge recommendation.`;
}

export async function syncComment(
  api: ReturnType<typeof github>,
  repository: string,
  number: number,
  login: string,
  score: unknown,
  appSlug: string,
  emailEnabled = false,
) {
  const body =
    scoreComment(login, score) +
    (emailEnabled
      ? "\n\n[Email preferences / 邮件设置](https://bot.ghfind.com/notifications): score emails go to available public GitHub addresses by default; unsubscribe in the email. / 有公开邮箱时默认发送评分邮件，可在邮件中退订。"
      : "");
  const path = `/repos/${repository}/issues/${number}/comments`;
  // Check ownership as well as the marker: quoted/spoofed user comments are never edited.
  for (let page = 1; page <= 100; page++) {
    const comments = await api(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error("Invalid comment list");
    for (const value of comments) {
      const comment = record(value);
      const user = record(comment.user);
      if (
        user.type === "Bot" &&
        user.login === `${appSlug}[bot]` &&
        typeof comment.body === "string" &&
        comment.body.startsWith(COMMENT_MARKER)
      ) {
        if (comment.body !== body)
          await api(
            `/repos/${repository}/issues/comments/${positive(comment.id)}`,
            "PATCH",
            { body },
          );
        return;
      }
    }
    if (comments.length < 100) {
      await api(path, "POST", { body });
      return;
    }
  }
  throw new Error("Comment pagination exceeded limit");
}
