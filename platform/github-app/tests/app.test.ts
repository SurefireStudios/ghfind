import { env, SELF } from "cloudflare:test";
import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import worker, { verifySignature, webhook } from "../src/index";
import { putJob, runJob, Job, dispatch } from "../src/jobs";
import { LABELS, scoreToLabel } from "../src/review";
import { ui } from "../src/ui";
import { ApiError, jsonRequest, appJWT } from "../src/github";

declare const TEST_SQL: string[];
const testEnv = env as Env;
interface Expectation {
  url: string;
  method: string;
  body?: string;
  status: number;
  response: string;
  headers?: Record<string, string>;
}
const pending: Expectation[] = [];
const fetchMock = {
  activate() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const at = pending.findIndex(
          (x) =>
            x.url === url &&
            x.method === method &&
            (x.body === undefined || x.body === init?.body),
        );
        if (at < 0) throw new Error(`Unexpected request: ${method} ${url}`);
        const x = pending.splice(at, 1)[0];
        return new Response(x.status === 204 ? null : x.response, {
          status: x.status,
          headers: x.headers,
        });
      }),
    );
  },
  disableNetConnect() {},
  deactivate() {
    vi.unstubAllGlobals();
  },
  assertNoPendingInterceptors() {
    expect(pending.splice(0)).toEqual([]);
  },
  get(origin: string) {
    return {
      intercept(match: { path: string; method?: string; body?: string }) {
        return {
          reply(
            status: number,
            response: string,
            options?: { headers: Record<string, string> },
          ) {
            pending.push({
              url: origin + match.path,
              method: match.method ?? "GET",
              body: match.body,
              status,
              response,
              headers: options?.headers,
            });
          },
        };
      },
    };
  },
};
const api = "https://api.github.com";
const repo = "AsperforMias/test-bot";
const signature = async (body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(testEnv.WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return (
    "sha256=" +
    Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    ).toString("hex")
  );
};
async function event(type: string, payload: unknown, id = "delivery-1") {
  const body = JSON.stringify(payload);
  return new Request("https://bot.example/webhook", {
    method: "POST",
    headers: {
      "x-github-event": type,
      "x-github-delivery": id,
      "x-hub-signature-256": await signature(body),
    },
    body,
  });
}
const prEvent = {
  action: "opened",
  number: 1,
  installation: { id: 10, node_id: "installation" },
  repository: { id: 100, full_name: repo, owner: { login: "AsperforMias" } },
};
const intercept = (path: string, body: unknown, status = 200, method = "GET") =>
  fetchMock
    .get(api)
    .intercept({ path, method })
    .reply(status, JSON.stringify(body));
function scope() {
  intercept(
    "/app/installations/10/access_tokens",
    { token: "installation-test-token" },
    201,
    "POST",
  );
  intercept("/repositories/100", { id: 100, full_name: repo, archived: false });
}
const labelList = () =>
  LABELS.map((name) => ({
    name,
    color: "123456",
    description: "Owner settings",
  }));
async function job(id = "job-1") {
  return testEnv.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind(id)
    .first<Job>();
}
async function add(id = "job-1", kind: "label" | "initialize" = "label") {
  await putJob(testEnv, {
    id,
    installation: 10,
    repository: 100,
    full_name: repo,
    pr: 1,
    kind,
  });
}
beforeAll(async () => {
  for (const sql of TEST_SQL) await testEnv.DB.prepare(sql).run();
});
beforeEach(async () => {
  await testEnv.DB.exec("DELETE FROM jobs; DELETE FROM sessions;");
  fetchMock.activate();
  fetchMock.disableNetConnect();
  vi.spyOn(testEnv.SCORE, "fetch").mockImplementation(async () =>
    Response.json({ final_score: 82.7 }),
  );
});
afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  fetchMock.deactivate();
  vi.restoreAllMocks();
});

describe("GitHub App delivery", () => {
  it("honors rate-limit headers without waiting for a stalled error body", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 429, headers: { "retry-after": "90" } },
    );
    await expect(
      jsonRequest(
        "https://example.test",
        {},
        Date.now() + 100,
        async () => response,
      ),
    ).rejects.toMatchObject({ status: 429, retry: true, delay: 90000 });
    expect(cancelled).toBe(true);
  });

  it("discovers selected repositories using installation token and durable jobs", async () => {
    await putJob(testEnv, {
      id: "discover-1",
      installation: 10,
      kind: "discover",
    });
    intercept("/app/installations/10", {
      account: { login: "AsperforMias" },
      suspended_at: null,
    });
    intercept(
      "/app/installations/10/access_tokens",
      { token: "discovery-token" },
      201,
      "POST",
    );
    intercept("/installation/repositories?per_page=100&page=1", {
      repositories: [
        { id: 100, full_name: repo },
        { id: 101, full_name: "AsperforMias/archived", archived: true },
      ],
    });
    await runJob(testEnv, "discover-1");
    expect((await job("discover-1"))?.state).toBe("done");
    expect((await job("discover-1:repo:100"))?.kind).toBe("initialize");
    expect(await job("discover-1:repo:101")).toBeNull();
  });
  it("starts execution budget when a queued job is claimed, not when the event arrived", async () => {
    await add("job-1", "initialize");
    await testEnv.DB.prepare("UPDATE jobs SET created=? WHERE id=?")
      .bind(Date.now() - 3600000, "job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("requires the session user to be repository admin for retries", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET state='failed' WHERE id=?")
      .bind("job-1")
      .run();
    const e = { ...testEnv, APP_CLIENT_ID: "client-test" };
    const login = await ui(
      new Request("https://bot.example/login?installation_id=10"),
      e,
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    fetchMock
      .get("https://github.com")
      .intercept({ path: "/login/oauth/access_token", method: "POST" })
      .reply(200, JSON.stringify({ access_token: "user-test-token" }));
    const callback = await ui(
      new Request(`https://bot.example/callback?code=test&state=${state}`, {
        headers: { cookie: `ghfind_bot_state=${state}` },
      }),
      e,
    );
    const cookie = callback.headers.get("set-cookie")!.split(";")[0];
    const csrf = cookie.split("=")[1];
    intercept("/user/installations/10/repositories?per_page=100&page=1", {
      repositories: [{ id: 100, full_name: repo }],
    });
    intercept(`/repos/${repo}`, { permissions: { admin: false } });
    const denied = await ui(
      new Request("https://bot.example/retry?installation_id=10", {
        method: "POST",
        headers: { cookie, origin: "https://bot.example" },
        body: new URLSearchParams({ csrf, id: "job-1" }),
      }),
      e,
    );
    expect(denied.status).toBe(403);
    expect((await job())?.state).toBe("failed");
    intercept("/user/installations/11/repositories?per_page=100&page=1", {
      repositories: [],
    });
    const other = await ui(
      new Request("https://bot.example/setup?installation_id=11", {
        headers: { cookie },
      }),
      e,
    );
    expect(await other.text()).not.toContain(repo);
    const stored = await testEnv.DB.prepare(
      "SELECT value FROM sessions WHERE id LIKE 'session:%'",
    ).first<{ value: string }>();
    expect(stored?.value).not.toContain("user-test-token");
  });
  it("rejects cross-installation job retry even for an administrator elsewhere", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET state='failed' WHERE id=?")
      .bind("job-1")
      .run();
    const e = { ...testEnv, APP_CLIENT_ID: "client-test" };
    const login = await ui(
      new Request("https://bot.example/login?installation_id=11"),
      e,
    );
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    fetchMock
      .get("https://github.com")
      .intercept({ path: "/login/oauth/access_token", method: "POST" })
      .reply(200, JSON.stringify({ access_token: "user-test-token" }));
    const cb = await ui(
      new Request(`https://bot.example/callback?code=test&state=${state}`, {
        headers: { cookie: `ghfind_bot_state=${state}` },
      }),
      e,
    );
    const cookie = cb.headers.get("set-cookie")!.split(";")[0];
    intercept("/user/installations/11/repositories?per_page=100&page=1", {
      repositories: [{ id: 200, full_name: "AsperforMias/other" }],
    });
    const denied = await ui(
      new Request("https://bot.example/retry?installation_id=11", {
        method: "POST",
        headers: { cookie, origin: "https://bot.example" },
        body: new URLSearchParams({ csrf: cookie.split("=")[1], id: "job-1" }),
      }),
      e,
    );
    expect(denied.status).toBe(404);
  });

  it.each([
    [0, LABELS[0]],
    [39.99, LABELS[0]],
    [40, LABELS[1]],
    [69.99, LABELS[1]],
    [70, LABELS[2]],
    [89.99, LABELS[2]],
    [90, LABELS[3]],
    [100, LABELS[3]],
    [NaN, LABELS[4]],
    [-1, LABELS[4]],
    [101, LABELS[4]],
    [null, LABELS[4]],
    ["90", LABELS[4]],
  ])("score %s -> %s", (score, label) =>
    expect(scoreToLabel(score)).toBe(label),
  );
  it("verifies exact raw-body signatures", async () => {
    const body = '{"x":1}';
    expect(
      await verifySignature(
        body,
        await signature(body),
        testEnv.WEBHOOK_SECRET,
      ),
    ).toBe(true);
    expect(
      await verifySignature(
        body + " ",
        await signature(body),
        testEnv.WEBHOOK_SECRET,
      ),
    ).toBe(false);
    expect(await verifySignature(body, "sha256=zz", "secret")).toBe(false);
  });
  it("rejects unsigned requests before admission", async () => {
    const r = await SELF.fetch("https://bot.example/webhook", {
      method: "POST",
      body: JSON.stringify(prEvent),
    });
    expect(r.status).toBe(401);
    expect(await job("delivery-1")).toBeNull();
  });
  it("accepts real minimal PR installation shape and deduplicates delivery", async () => {
    expect(
      (await webhook(await event("pull_request", prEvent), testEnv)).status,
    ).toBe(202);
    expect(
      (await webhook(await event("pull_request", prEvent), testEnv)).status,
    ).toBe(202);
    expect(
      (
        await testEnv.DB.prepare("SELECT count(*) n FROM jobs").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(1);
  });
  it("ignores accounts outside rollout and non-opened events", async () => {
    await webhook(
      await event("pull_request", { ...prEvent, action: "synchronize" }),
      testEnv,
    );
    await webhook(
      await event("pull_request", {
        ...prEvent,
        repository: { ...prEvent.repository, owner: { login: "someone-else" } },
      }),
      testEnv,
    );
    expect(await job("delivery-1")).toBeNull();
  });
  it("generates a bounded signed App JWT", () => {
    const token = appJWT(testEnv).split(".");
    const claims = JSON.parse(Buffer.from(token[1], "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBe(600);
    expect(token[2].length).toBeGreaterThan(100);
  });
  it("initializes only missing labels and preserves custom settings", async () => {
    await add("job-1", "initialize");
    scope();
    intercept(
      `/repos/${repo}/labels?per_page=100&page=1`,
      labelList().slice(0, 4),
    );
    fetchMock
      .get(api)
      .intercept({
        path: `/repos/${repo}/labels`,
        method: "POST",
        body: JSON.stringify({
          name: LABELS[4],
          color: "ededed",
          description: "ghfind author score unavailable (not zero)",
        }),
      })
      .reply(201, "{}");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("labels an opened PR once and preserves unrelated labels", async () => {
    await add();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/pulls/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: "bug" },
      { name: LABELS[0] },
    ]);
    intercept(`/repos/${repo}/issues/1/labels`, {}, 200, "POST");
    intercept(
      `/repos/${repo}/issues/1/labels/${encodeURIComponent(LABELS[0])}`,
      null,
      204,
      "DELETE",
    );
    await runJob(testEnv, "job-1");
    expect((await job())?.result).toBe(LABELS[2]);
    expect((await job())?.score).toBe("82.7");
    await runJob(testEnv, "job-1");
  });
  it("does not write when target label is already applied", async () => {
    await add();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/pulls/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[2] },
      { name: "bug" },
    ]);
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("reconciles an ambiguous successful write before replaying", async () => {
    await add();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/pulls/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, []);
    intercept(`/repos/${repo}/issues/1/labels`, {}, 502, "POST");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("pending");
    expect((await job())?.attempts).toBe(1);
    await testEnv.DB.prepare("UPDATE jobs SET due=0 WHERE id=?")
      .bind("job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/pulls/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, [
      { name: LABELS[2] },
    ]);
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("fails closed if repository-scoped token cannot be issued after removal", async () => {
    await add();
    intercept("/app/installations/10/access_tokens", {}, 422, "POST");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("failed");
  });
  it("cancels pending work on uninstall", async () => {
    await add();
    await webhook(
      await event("installation", {
        action: "deleted",
        installation: {
          id: 10,
          app_id: 123,
          account: { login: "AsperforMias" },
        },
      }),
      testEnv,
    );
    expect((await job())?.state).toBe("cancelled");
  });
  it("persists Retry-After without sleeping in the webhook", async () => {
    await add();
    fetchMock
      .get(api)
      .intercept({
        path: "/app/installations/10/access_tokens",
        method: "POST",
      })
      .reply(429, "{}", { headers: { "retry-after": "70" } });
    const before = Date.now();
    await runJob(testEnv, "job-1");
    expect((await job())!.due).toBeGreaterThanOrEqual(before + 70000);
  });
  it("terminates after seven retries", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET attempts=7 WHERE id=?")
      .bind("job-1")
      .run();
    intercept("/app/installations/10/access_tokens", {}, 502, "POST");
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("failed");
  });
  it("recovers expired leases but does not steal active jobs", async () => {
    await add("job-1", "initialize");
    await testEnv.DB.prepare(
      "UPDATE jobs SET state='running',lease=? WHERE id=?",
    )
      .bind(Date.now() + 600000, "job-1")
      .run();
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("running");
    await testEnv.DB.prepare("UPDATE jobs SET lease=0 WHERE id=?")
      .bind("job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    await runJob(testEnv, "job-1");
    expect((await job())?.state).toBe("done");
  });
  it("uses unavailable after score deadline while reserving GitHub time", async () => {
    await add();
    await testEnv.DB.prepare("UPDATE jobs SET started=? WHERE id=?")
      .bind(Date.now() - 250000, "job-1")
      .run();
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, labelList());
    intercept(`/repos/${repo}/pulls/1`, {
      state: "open",
      user: { login: "AsperforMias" },
    });
    intercept(`/repos/${repo}/issues/1/labels?per_page=100&page=1`, []);
    fetchMock
      .get(api)
      .intercept({
        path: `/repos/${repo}/issues/1/labels`,
        method: "POST",
        body: JSON.stringify({ labels: [LABELS[4]] }),
      })
      .reply(200, "{}");
    await runJob(testEnv, "job-1");
    expect((await job())?.result).toBe(LABELS[4]);
  });
  it("blocks callbacks without matching browser state", async () => {
    expect(
      (await SELF.fetch("https://bot.example/callback?code=test&state=other"))
        .status,
    ).toBe(403);
  });
  it("does not expose jobs from an installation ID without authentication", async () => {
    await add();
    const r = await SELF.fetch("https://bot.example/setup?installation_id=10");
    expect(await r.text()).not.toContain(repo);
  });
  it("rejects archived labels without overwriting owner configuration", async () => {
    await add("job-1", "initialize");
    scope();
    intercept(`/repos/${repo}/labels?per_page=100&page=1`, [
      { name: LABELS[0], archived: true },
    ]);
    await runJob(testEnv, "job-1");
    expect((await job())?.result).toContain("Unarchive");
  });
  it("times out and cancels a stalled body", async () => {
    let cancelled = false;
    await expect(
      jsonRequest(
        "https://example.test",
        {},
        Date.now() + 20,
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("{"));
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(cancelled).toBe(true);
  });
  it("keeps HTTP retries outside single-request transport", async () => {
    intercept("/test", {}, 500);
    await expect(jsonRequest(api + "/test")).rejects.toMatchObject({
      status: 500,
      retry: true,
    });
  });
  it("supports a paused rollout without discarding durable work", async () => {
    await add();
    const paused = { ...testEnv, ENABLED: "false" } as Env;
    await runJob(paused, "job-1");
    await dispatch(paused);
    expect((await job())?.state).toBe("pending");
    expect(
      (await worker.fetch(await event("pull_request", prEvent), paused)).status,
    ).toBe(503);
  });
});
