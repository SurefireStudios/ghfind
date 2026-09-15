import { enqueueAuthorEmail, scoreContext } from "./author-email";
import {
  ApiError,
  appJWT,
  github,
  installationToken,
  jsonRequest,
  positive,
  record,
  repositoryName,
} from "./github";
import {
  initializeLabels,
  scoreToLabel,
  syncLabel,
  syncComment,
} from "./review";

export interface Job {
  id: string;
  installation: number;
  repository: number | null;
  full_name: string | null;
  // GitHub issues and PRs share the same repository number namespace.
  pr: number | null;
  kind: "discover" | "initialize" | "label";
  state: string;
  attempts: number;
  created: number;
  started: number;
  due: number;
  lease: number;
  score: string | null;
  score_context?: string | null;
  page: number;
  result: string | null;
  updated: number;
}
export function allowed(env: Env, fullName: string) {
  const accounts = env.ALLOWED_ACCOUNTS.split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  return (
    accounts.includes("*") ||
    accounts.includes(fullName.split("/")[0].toLowerCase())
  );
}
export async function putJob(
  env: Env,
  input: Pick<Job, "id" | "installation" | "kind"> &
    Partial<Pick<Job, "repository" | "full_name" | "pr">>,
) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO jobs(id,installation,repository,full_name,pr,kind,created,due,updated) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      input.id,
      input.installation,
      input.repository ?? null,
      input.full_name ?? null,
      input.pr ?? null,
      input.kind,
      now,
      now,
      now,
    )
    .run();
}
export async function dispatch(env: Env) {
  if (env.ENABLED !== "true") return;
  const now = Date.now();
  // SQL is the durable outbox: queue-send failures are recovered by cron.
  const { results } = await env.DB.prepare(
    "SELECT id FROM jobs WHERE (state='pending' AND due<=?) OR (state='running' AND lease<?) ORDER BY due LIMIT 100",
  )
    .bind(now, now)
    .all<{ id: string }>();
  if (results.length)
    await env.JOBS.sendBatch(results.map((x) => ({ body: { id: x.id } })));
  await env.DB.prepare("DELETE FROM sessions WHERE expires<?").bind(now).run();
  await env.DB.prepare(
    "DELETE FROM jobs WHERE state IN ('done','cancelled') AND updated<?",
  )
    .bind(now - 30 * 86400_000)
    .run();
}
async function finish(env: Env, job: Job, state: string, result: string) {
  await env.DB.prepare(
    "UPDATE jobs SET state=?,result=?,lease=0,updated=? WHERE id=?",
  )
    .bind(state, result, Date.now(), job.id)
    .run();
}
async function processJob(env: Env, job: Job) {
  const deadline = job.started + 8 * 60_000;
  if (Date.now() >= deadline)
    throw new Error("Execution deadline exceeded; retry from setup");
  if (job.kind === "discover") {
    const installation = record(
      await github(
        appJWT(env),
        deadline,
      )(`/app/installations/${job.installation}`),
    );
    if (installation.suspended_at) throw new ApiError(403, false);
    const account = record(installation.account);
    if (
      typeof account.login !== "string" ||
      !allowed(env, `${account.login}/_`)
    ) {
      await finish(env, job, "cancelled", "Account outside rollout");
      return;
    }
    const api = github(
      await installationToken(env, job.installation, undefined, deadline),
      deadline,
    );
    // One page per queue execution, so even large installations stay bounded.
    const page = record(
      await api(`/installation/repositories?per_page=100&page=${job.page}`),
    );
    if (!Array.isArray(page.repositories))
      throw new Error("Invalid repository list");
    for (const item of page.repositories) {
      const repo = record(item);
      if (repo.archived === true) continue;
      await putJob(env, {
        id: `${job.id}:repo:${positive(repo.id)}`,
        kind: "initialize",
        installation: job.installation,
        repository: positive(repo.id),
        full_name: repositoryName(repo.full_name),
      });
    }
    if (page.repositories.length === 100) {
      await env.DB.prepare(
        "UPDATE jobs SET page=page+1,state='pending',lease=0,due=?,updated=? WHERE id=?",
      )
        .bind(Date.now(), Date.now(), job.id)
        .run();
    } else
      await finish(env, job, "done", "Repositories queued for initialization");
    return;
  }
  if (!job.repository) throw new Error("Missing repository");
  // Repository-scoped token issuance rechecks current installation membership.
  const api = github(
    await installationToken(env, job.installation, job.repository, deadline),
    deadline,
  );
  const repo = record(await api(`/repositories/${job.repository}`));
  const fullName = repositoryName(repo.full_name);
  if (repo.archived === true || !allowed(env, fullName)) {
    await finish(
      env,
      job,
      "cancelled",
      "Repository unavailable or outside rollout",
    );
    return;
  }
  await env.DB.prepare("UPDATE jobs SET full_name=? WHERE id=?")
    .bind(fullName, job.id)
    .run();
  await initializeLabels(api, fullName);
  if (job.kind === "initialize") {
    await finish(env, job, "done", "All five labels ready");
    return;
  }
  const pr = record(await api(`/repos/${fullName}/issues/${job.pr}`));
  if (pr.state !== "open") {
    await finish(env, job, "cancelled", "Issue or pull request closed");
    return;
  }
  const user = record(pr.user);
  if (
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(user.login)
  )
    throw new Error("Invalid author login");
  if (job.score === null) {
    let score: unknown = null;
    if (Date.now() < job.started + 4 * 60_000) {
      try {
        const response = record(
          await jsonRequest(
            `https://ghfind.com/api/score/${encodeURIComponent(user.login)}`,
            { headers: { Accept: "application/json" } },
            Math.min(deadline, job.started + 4 * 60_000),
            env.SCORE.fetch.bind(env.SCORE),
          ),
        );
        score = response.final_score;
        job.score_context = JSON.stringify(scoreContext(response));
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.retry &&
          job.attempts < 7 &&
          Date.now() + Math.max(5000, error.delay) < job.started + 4 * 60_000
        )
          throw error;
      }
    }
    // Persist before the first label write: a replay cannot oscillate on score changes.
    job.score = JSON.stringify(
      typeof score === "number" &&
        Number.isFinite(score) &&
        score >= 0 &&
        score <= 100
        ? score
        : null,
    );
    await env.DB.prepare("UPDATE jobs SET score=?,score_context=? WHERE id=?")
      .bind(job.score, job.score_context ?? null, job.id)
      .run();
  }
  const label = scoreToLabel(JSON.parse(job.score));
  await syncLabel(api, fullName, positive(job.pr), label);
  await syncComment(
    api,
    fullName,
    positive(job.pr),
    user.login,
    JSON.parse(job.score),
    env.APP_SLUG,
    env.EMAIL_ENABLED === "true",
  );
  if (env.EMAIL_ENABLED === "true")
    await enqueueAuthorEmail(
      env,
      positive(user.id),
      {
        login: user.login,
        repository: fullName,
        number: positive(job.pr),
        installation: job.installation,
        repositoryId: job.repository,
        kind: pr.pull_request ? "PR" : "issue",
        ...(job.score_context
          ? JSON.parse(job.score_context)
          : { score: JSON.parse(job.score), percentile: null }),
      },
      job.repository,
      api,
    );
  await finish(env, job, "done", label);
}
export async function runJob(env: Env, id: string) {
  if (env.ENABLED !== "true") return;
  const now = Date.now();
  // Lease outlives the eight-minute request budget. Queue consumer concurrency=1
  // serializes different jobs targeting the same PR as well as duplicate deliveries.
  const job = await env.DB.prepare(
    "UPDATE jobs SET state='running',lease=?,updated=?,started=CASE WHEN started=0 THEN ? ELSE started END WHERE id=? AND ((state='pending' AND due<=?) OR (state='running' AND lease<?)) RETURNING *",
  )
    .bind(now + 10 * 60_000, now, now, id, now, now)
    .first<Job>();
  if (!job) return;
  try {
    await processJob(env, job);
  } catch (error) {
    if (
      error instanceof ApiError &&
      [401, 403, 404, 422].includes(error.status) &&
      !error.retry
    ) {
      await finish(
        env,
        job,
        "failed",
        `GitHub access/configuration error (${error.status}); check installation permissions and repository access`,
      );
      return;
    }
    const delay = Math.max(
      Math.min(5000 * 2 ** job.attempts, 20000),
      error instanceof ApiError ? error.delay : 0,
    );
    if (
      error instanceof ApiError &&
      error.retry &&
      job.attempts < 7 &&
      Date.now() + delay < job.started + 8 * 60_000
    ) {
      await env.DB.prepare(
        "UPDATE jobs SET state='pending',attempts=attempts+1,due=?,lease=0,result=?,updated=? WHERE id=?",
      )
        .bind(Date.now() + delay, error.message, Date.now(), job.id)
        .run();
      await env.JOBS.send(
        { id: job.id },
        { delaySeconds: Math.ceil(delay / 1000) },
      );
    } else {
      const result =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Job failed";
      // Do not include tokens, payloads, author data or response bodies in DLQ/logs.
      await env.DEAD.send({ id: job.id });
      await finish(env, job, "failed", result);
    }
  }
}
