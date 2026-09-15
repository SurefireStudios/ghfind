# ghfind Review GitHub App

**English** · [中文](./README.zh.md) · [Project README](../../README.md)

A hosted GitHub App that initializes five repository labels and labels and comments on opened issues and PRs
(including drafts) using the author's public ghfind score. It uses installation
tokens, so GitHub records the App's own bot identity and avatar.

## Install

The service is live at <https://bot.ghfind.com>. Install
[ghfind Review](https://github.com/apps/ghfind-review/installations/new).
The registered App is owned by **AsperforMias** (App ID `4950248`) and writes as
`ghfind-review[bot]` with the ghfind avatar. Production processing is open to all
accounts (`ALLOWED_ACCOUNTS=*`). Each owner must install the App and choose the
repositories it may access.

1. Follow the installation link and select repositories. Grant **Issues: read and write**, **Pull requests:
   read and write** and the implicit **Metadata: read** permission.
2. The App automatically creates missing `review-level: low`, `medium`, `high`,
   `xhigh`, and `unavailable` labels. Owner-customized colors/descriptions are preserved;
   original bot-owned grey defaults are upgraded to the palette below.
   Archived labels and case conflicts are reported for the owner to fix.
3. The installation setup page offers GitHub sign-in to view accessible
   repository jobs. Retrying a failed repository job requires repository admin
   permission. Sign-in is optional for automatic labeling.
4. Open a new issue or PR (drafts and empty descriptions are supported). Processing
   is asynchronous; wait for the queue, then refresh. Confirm the label and comment
   are authored by `ghfind-review[bot]`.
5. If your repository already uses the old `PR review level` Actions workflow,
   disable it before switching to this App to avoid duplicate processing.

You do not need to add a workflow, personal access token or secret to your repository.
For personal repositories, installation is managed by the account owner; organization
installations may require an organization owner to approve the request.

### Existing installation: accept Issues permission

Open [GitHub Settings → Applications → Installed GitHub Apps](https://github.com/settings/installations),
select **Configure** for ghfind Review, then **Review request → Accept new permissions**
if prompted. Issues read/write access is required alongside Pull requests read/write.
New installations request both automatically.

### Troubleshooting and removal

| Symptom                            | What to check                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No labels or comment               | Confirm the App is installed on this repository, the object was created after installation, and required permissions were accepted. Open the installation's setup page and sign in to inspect job status. |
| Initialization fails               | Check for archived labels or conflicting capitalization; fix them in the repository's Labels page, then use **Retry (admin)** on the setup page.                                                          |
| `unavailable`                      | The score is missing, invalid or could not be retrieved within the retry budget. It is not zero. A completed job is not automatically rescored.                                                           |
| No additional comment after replay | Expected: the App reconciles its existing comment rather than adding another.                                                                                                                             |
| Want to stop processing            | Remove the repository from the App installation, suspend it or uninstall it. Existing labels and comments remain.                                                                                         |

The setup page is reached from the App installation flow/settings; it requires GitHub
sign-in for status visibility. Only repository admins may retry failed jobs.

The score thresholds match PR #288 at `f72a4b3`: 40, 70 and 90. A score outside
0–100, a missing score or exhausted score retries produces `unavailable`, never
an inferred zero. This is an author-profile signal, not a code-quality review or
permission to merge. Both `issues.opened` and `pull_request.opened` are processed.
Existing issues/PRs are not retroactively processed merely by updating the App.

## Runtime

- Separate Worker, Queues and D1; no writes to scoring/Feed databases.
- Webhook HMAC validates the raw body before admission. Only minimal task
  metadata is retained; PR text/code is not stored or executed.
- D1 is the durable outbox. Queue sends are recovered by a one-minute cron.
  Delivery IDs deduplicate redelivery. Consumer concurrency **must remain 1**
  until repository/PR-scoped serialization is introduced.
- An atomic ten-minute lease excludes duplicate executions. Execution budget is
  eight minutes from first claim, not from webhook arrival; four minutes are
  reserved for GitHub operations. Each HTTP call is capped at sixty seconds,
  including streamed body reads. Seven retries maximum, using 5/10/20-second
  backoff and GitHub Retry-After/reset guidance. No webhook sleep loops.
- The score is persisted before the first PR label write. Replays reconcile
  current labels, add the target first, and remove only known obsolete review
  labels. Unrelated labels and owner customization remain unchanged.
- Installation-scoped discovery paginates repositories. Repository tasks mint a
  repository-scoped token and refetch the repository by ID, handling renames and
  access revocation. Suspended/deleted installations cannot mint usable tokens.
- D1 sessions contain encrypted user tokens; Secure/HttpOnly/SameSite cookies,
  one-use OAuth state, origin/CSRF checks, and live repository-admin checks guard
  retries. A supplied installation ID is never treated as proof of access.
- Score reads use the `SCORE` service binding to the existing `ghfind` Worker.

The labeling contract was ported from #288; the CLI implementation is not
imported because that PR was closed in favor of this App and its Node entry point/internal retry
loop do not fit queue execution. Keep the threshold/label fixtures aligned if
the contract changes.

## Develop and verify

```sh
cd platform/github-app
pnpm install --frozen-lockfile
pnpm types
pnpm typecheck
pnpm test
pnpm build
```

Tests run inside workerd with a real local D1, native service-binding transport
for the score fixture, and mocked external GitHub requests. Keep the service
binding unmocked so runtime-specific fetch restrictions remain covered. HTTP
redirects are handled manually and rejected as non-success responses; Workers
does not implement `redirect: "error"`.
Compatibility date is `2026-09-10`, the newest supported by the pinned test
runtime. `wrangler types --strict-vars=false` keeps rollout switches string-typed.
The separate GitHub App checks workflow runs this package on PRs and pushes.
For UI changes also run repository `pnpm typecheck` and `pnpm lint`, and inspect
Light, Dark and Auto in the navbar.

## Register under the maintainer account

The production App is already registered under **AsperforMias**. Do not register
a duplicate when deploying updates. The following procedure is for a separate
self-hosted App. Registration is distinct from repository installation; GitHub
may require account two-factor/sudo verification.
Installing into `hikariming`'s personal repositories must be completed by that
account's owner.

```sh
node scripts/register.mjs https://bot.example.com /absolute/private/credentials.json
```

Open the printed loopback URL, confirm the logged-in account and register the
App. The script binds only `127.0.0.1`, uses a one-time random state, exchanges
the manifest code directly with GitHub, and writes credentials with mode `0600`.
It refuses to overwrite an existing credentials file. Keep the terminal running
until the callback succeeds; stop it afterward. Never commit the output.

In App settings, upload `assets/avatar.png` (200×200, derived from the website
icon). Confirm webhook is `/webhook`, OAuth callback `/callback`, setup `/setup`,
Issues and Pull requests write permissions and both `issues` and `pull_request`
event subscriptions. Existing installations must accept the added Issues
permission in their GitHub installation settings. GitHub
also delivers installation lifecycle events automatically. Keep optional OAuth
on installation disabled: it is only needed to view the setup dashboard.

## Deploy

The production account is pinned to `8f19bebe359e4ec1a24c68c5f49c1584` (the same
account as ghfind). App ownership in GitHub does not change Cloudflare billing.
Before deploy, verify `wrangler whoami`, `wrangler d1 list`, and
`wrangler queues list`. Never substitute another Cloudflare account to get a
deploy through. The default configuration is for local/staging development;
staging's placeholder D1 ID must be provisioned before a remote staging deploy.

Set non-secret `APP_ID`, `APP_CLIENT_ID`, `APP_SLUG` in the production vars.
Secrets are `APP_PRIVATE_KEY`, `WEBHOOK_SECRET`, `APP_CLIENT_SECRET`, and a random
32-byte `SESSION_SECRET`. Supply a private JSON file on first deploy:

```sh
pnpm exec wrangler d1 migrations apply ghfind-bot --remote --env production
pnpm exec wrangler deploy --env production --secrets-file /absolute/private/worker-secrets.json
```

For later rotations use `wrangler secret bulk` with a private file. Never put
secret values in command arguments, GitHub comments, screenshots or logs.
Bootstrap deployments keep `ENABLED=false` and use throwaway local credentials;
they are not an operational GitHub App until replaced by real credentials.

Enable processing only after credentials, avatar and webhook configuration are
ready. Production uses `ALLOWED_ACCOUNTS=*` after real installation/labeling E2E
verification. For a separate restricted deployment, use a comma-separated list
of repository owner logins.

## Observe and recover

The setup page shows the latest 100 installation jobs intersected with the
user's accessible repositories. Only repository admins can submit Retry. For a
failed discovery job, a maintainer can redeliver the installation webhook from
GitHub App settings; use the SQL/operator procedure below for a fresh budget.
Replaying a completed delivery is intentionally a no-op.

```sh
pnpm exec wrangler d1 execute ghfind-bot --remote --env production \
  --command "SELECT id,kind,state,attempts,result,updated FROM jobs ORDER BY updated DESC LIMIT 30"
```

An operator may reset one **failed** job after fixing the cause (use its actual
ID): `UPDATE jobs SET state='pending', attempts=0, started=0, score=NULL, lease=0,
due=0 WHERE id='<job-id>' AND state='failed'`. Cron will enqueue it again. This is
also the way to recover an exhausted discovery job. Failed tasks stay in D1;
retry/deadline exhaustion and other terminal processing errors also send their
ID to the dead-letter queue. Infrastructure queue failures use the configured
DLQ. No user token or raw payload belongs in a DLQ entry.

Pause with `ENABLED=false` and redeploy. Pending tasks remain durable. Uninstall
or remove a repository in GitHub to revoke access; existing labels stay in place.
Rollback the Worker version with `wrangler rollback --env production`; do not
roll back/drop the D1 schema. Completed/cancelled records are purged after 30 days
by cron; expired dashboard sessions are purged at the same time.

## Real E2E acceptance

Use an empty, disposable repository in the maintainer account. Install only on
that repository; verify five labels exist before opening a draft PR. Check the
GitHub timeline's actor login/type/avatar, the applied level against the live
score, and the setup status. Redeliver the same event and ensure there is no new
label transition. Remove repository access/uninstall and confirm no further
writes. Unit tests and a deployed health page alone do not establish bot identity.

Validated against the live service on 2026-09-15:

- A new private test repository received all five labels automatically on install.
- A draft PR by `AsperforMias` received `review-level: high` for a live score of
  **82.7**. The GitHub timeline recorded `ghfind-review[bot]` (type `Bot`) with
  the custom avatar, not the maintainer or GitHub Actions identity.
- GitHub redelivered the same opened event successfully (HTTP 202); the timeline
  still contained exactly one review-label event.
- The OAuth setup dashboard showed initialization and labeling as done. Light,
  Dark and Auto themes were checked with actual job rows.
- After uninstalling the test installation, the previously issued token returned
  HTTP 401 for reads and label writes, and new token creation returned HTTP 404.
  Existing labels remained unchanged. The disposable repository was archived.

The production App is available for installation; `hikariming/ghfind` still needs
its personal account owner's installation. This package does not install the App
in that repository or replace its workflows merely by being merged.

## Author-score comment

After label reconciliation succeeds, the App creates or updates its own comment:

| Profile                                              | Score      | Level                | Score interval  |
| ---------------------------------------------------- | ---------- | -------------------- | --------------- |
| [AsperforMias](https://ghfind.com/en/u/AsperforMias) | 82.7 / 100 | `review-level: high` | 70 ≤ score < 90 |

The template is `scoreComment` in `src/review.ts`. It uses the same persisted score
as the label. Unavailable scores show “Unavailable” with no numeric interval,
never zero. The footer explains that this is an author-profile signal.

Before posting, all comment pages are searched for the marker and this App's bot
identity. Matching comments are updated only when the body differs; user comments
with a copied marker are not modified. A failed label write cannot post a success
comment. Comment failures retain the durable job for retry, which reconciles the
label and checks existing comments before creating another. GitHub does not expose
an idempotency key for comment creation, so reconciliation handles ambiguous
responses rather than blindly reposting.

The existing `jobs.pr` column stores either the issue or PR number: GitHub shares
that number namespace and exposes both through the Issues API. No schema migration
is needed for this extension.

Issue/comment extension verified on the live service on 2026-09-15 in
`AsperforMias/ghfind-bot-demo-20260915`: empty-body issue #3 and draft PR #4 each
received one high label and one comment from `ghfind-review[bot]`, with the live
score 82.7, a working profile URL and interval `70 ≤ score < 90`. Both real GitHub
opened deliveries were redelivered (HTTP 202); each still had one label event and
one score comment. Test installation 161860552 accepted Issues write permission.

Repeat verification using:

```sh
node scripts/e2e.mjs verify owner/test-repository app-slug issue-or-pr-number
```

## Label palette

| Level       | Score interval                      | Color            | Hex       |
| ----------- | ----------------------------------- | ---------------- | --------- |
| low         | 0 ≤ score < 40                      | Muted light grey | `#d9dee3` |
| medium      | 40 ≤ score < 70                     | Light blue       | `#b6dfff` |
| high        | 70 ≤ score < 90                     | Bright orange    | `#ff922b` |
| xhigh       | 90 ≤ score ≤ 100                    | Gold             | `#ffc400` |
| unavailable | No valid score; no numeric interval | Neutral grey     | `#c3c7ce` |

Higher score levels are more visually prominent. New labels use this palette.
Existing labels with the App's original `ededed` color and exact default
description are upgraded during initialization (also run before labeling).
Owner-customized colors or descriptions remain unchanged.
