# SURVIVE.EXE Pre-GitHub Security Audit

**Audit date:** 2026-08-31  
**Scope:** full application source, server routes, build output, local configuration hygiene, dependency advisories, persistence, Event Log streaming, chat, and the terminal UI.  
**Verdict:** **DO NOT PUBLICLY COMMIT YET.**

The application code is materially safer after the remediations in this audit: no production bundle secrets were found, no shell-execution path exists, and no Critical/High npm advisory remains. However, populated third-party credentials exist in the local `.env` and must be rotated before the first public commit or deployment. There are also three unresolved Moderate advisories inherited from the legacy Solana Web3 SDK; see `MED-01`.

## Immediate required action

Rotate the following credentials immediately through their respective provider dashboards, then replace the local values in `.env`:

- OpenAI API key
- Birdeye API key
- Helius RPC/WebSocket API key

Their values are intentionally not recorded in this document. `.env` is ignored by Git rules, but real credentials must be treated as exposed if they were ever pasted into a chat, committed in another clone, included in an archive, or shared with anyone.

## Executive summary

| Area | Result |
| --- | --- |
| Git repository/history | No Git repository exists in this directory, so there is no local commit, staged-file, remote, or history state to inspect. |
| Secret handling | `.env` contains real credentials locally; it is ignored. `.env.example` now contains placeholders only. No configured secret value was found in `dist/`. |
| Browser bundle | No `VITE_*` variables or provider credentials are emitted to the production bundle. |
| Server-only provider keys | Birdeye and OpenAI keys are accessed only from `server/` modules. Helius configuration remains server-only. |
| Terminal execution | **No Node process execution, shell, PowerShell, CMD, `eval`, `new Function`, or VM API exists.** The terminal is a fixed local command dispatcher. |
| Chat endpoint | Strict role normalization, 1,000-character message cap, 16-message history cap, 15 requests/minute/IP, one active generation/IP, 20-second timeout, same-origin protection, and server-owned prompts are present. |
| Event Log | One server WebSocket; bounded event/seen-signature buffers; public SSE stream now has global and per-client limits. |
| HTTP hardening | Production CSP, anti-framing, `nosniff`, referrer, permission, COOP/CORP headers, parser limits, and same-origin protection for chat were added. |
| Dependencies | Removed the unused `@solana/spl-token` tree and its High advisories. Three Moderate legacy `@solana/web3.js` advisories remain. |

## Findings

### CRIT-01 — Local provider credentials require rotation before public release

- **Severity:** Critical (operational secret exposure)
- **Location:** local `.env` (intentionally omitted from source and this report)
- **Scenario:** A populated `.env` file is copied, committed with force, included in a zip, shared in terminal output, or its values were previously exposed elsewhere.
- **Impact:** Unauthorized provider usage, API-credit loss, provider-account compromise, or access to usage data.
- **Current protection:** `.env` and all `.env.*` variants are ignored in [.gitignore](.gitignore:4); the production bundle scan passed; no Git repository/history exists in this directory.
- **Required fix:** Rotate OpenAI, Birdeye, and Helius credentials before creating/pushing the public repository. Keep only placeholders in [.env.example](.env.example:1).
- **Status:** **Action required outside the codebase.**

### MED-01 — Legacy `@solana/web3.js` dependency advisories remain

- **Severity:** Moderate
- **Location:** [package.json](package.json:14), transitive `jayson` / `uuid`
- **Scenario:** Untrusted RPC responses are parsed through the legacy Solana Web3 SDK dependency graph.
- **Impact:** npm audit reports the legacy Web3 dependency range as affected by Moderate advisories.
- **Evidence:** Post-remediation `npm audit --omit=dev` reports **3 Moderate**, **0 High**, **0 Critical** vulnerabilities. npm only proposes a breaking, non-viable automatic replacement (`@solana/web3.js@0.0.3`), so `npm audit fix --force` was not run.
- **Fix:** Track the SDK's security advisory and plan a tested migration to the maintained Solana client API when compatible. Do not blindly downgrade the SDK.
- **Status:** Open; release decision required after rotating credentials.

### MED-02 — Public stream and chat cost/connection abuse hardening

- **Severity:** Medium
- **Location:** [server/server.mjs](server/server.mjs:14), [server/survive/chat.mjs](server/survive/chat.mjs:6)
- **Scenario:** An attacker opens many EventSource connections or repeatedly calls the paid chat endpoint.
- **Impact:** Memory, socket, and model-cost exhaustion.
- **Fix applied:** Chat is limited to 15 requests/minute/IP, a maximum of 10,000 tracked client windows, one active request/IP, 1,000 characters/message, 16 normalized history entries, and a 20-second upstream timeout. SSE is limited to 3 streams/client and 200 total streams, with connection cleanup on close.
- **Status:** Remediated. Add reverse-proxy/WAF rate limiting before a large public launch.

### MED-03 — Persistent index write integrity

- **Severity:** Medium
- **Location:** [server/survive/index-store.mjs](server/survive/index-store.mjs:6)
- **Scenario:** Concurrent background status/index writes could previously interleave or leave partial JSON after interruption.
- **Impact:** Corrupted local cache or lost index state; this could trigger expensive re-indexing.
- **Fix applied:** Serialized writes through one queue and write-to-temporary-then-rename persistence. Local files are written with restrictive requested permissions where supported.
- **Status:** Remediated.

### LOW-01 — Reproducibility and supply-chain drift

- **Severity:** Low
- **Location:** [package.json](package.json:12)
- **Scenario:** `latest` and broad semver ranges change dependencies between installs.
- **Impact:** Unreviewed dependency drift and inconsistent builds.
- **Fix applied:** Production dependencies are now exact versions and remain locked in `package-lock.json`.
- **Status:** Remediated.

### LOW-02 — CSP uses inline styles for existing animation custom properties

- **Severity:** Low / accepted exception
- **Location:** [server/server.mjs](server/server.mjs:32)
- **Scenario:** A maximally strict CSP would block React inline custom properties used by the existing animation UI.
- **Impact:** `style-src 'unsafe-inline'` is less strict than nonce/hash-only CSP.
- **Fix:** The policy remains strict for scripts (`script-src 'self'`), frames, objects, connections, and forms. Only inline styles are allowed. Remove this exception only after moving all React style properties into static class-based CSS.
- **Status:** Accepted with documented rationale.

## Terminal injection verification

The terminal UI was specifically reviewed because a terminal-looking interface must never execute a real shell command.

- [src/terminal-page.jsx](src/terminal-page.jsx:124) extracts only the first whitespace-delimited token and checks it with `COMMAND_NAMES.includes(command)`.
- `COMMAND_NAMES` is a predefined JavaScript array in the same file. Aliases map to that same fixed list.
- Unknown input produces a React text message (`COMMAND NOT FOUND`) only; it is not forwarded to any server endpoint, model, or subprocess.
- The command input is now bounded at 256 characters ([src/terminal-page.jsx](src/terminal-page.jsx:9)).
- Repository-wide source scanning found no `child_process`, `exec`, `execFile`, `spawn`, `fork`, PowerShell, CMD, `eval`, `new Function`, or VM execution API in `src/` or `server/`.
- React renders terminal output as text. No `dangerouslySetInnerHTML`, `innerHTML`, `document.write`, or equivalent raw HTML sink exists in app source.

**Conclusion:** The terminal is a fake/client-side command UI with a fixed allow-list; it has no reachable shell or code-execution capability.

## Endpoint and provider review

| Endpoint/service | Input and exposure | Controls |
| --- | --- | --- |
| `GET /api/survive-status` | Public, read-only snapshot | No provider key/configuration is returned; `Cache-Control: no-store`. |
| `GET /api/event-log` | Public, read-only five-row snapshot | Server-owned normalized event data only. |
| `GET /api/event-log/stream` | Public SSE | Server-owned source, keepalive cleanup, 3 streams/client, 200 global streams. |
| `POST /api/chat` | JSON body, public | 16 KB parser cap, same-origin check, role normalization, length/history caps, scope gate, rate limit, one active generation, timeout, server-only API key. |
| Helius WSS | Server outbound only | One shared connection, bounded event and signature buffers, no browser key exposure. |
| Birdeye / Pyth / Solana RPC | Server outbound only | Keys/config remain in `process.env`, not browser code. |

No CORS middleware or wildcard `Access-Control-Allow-Origin` header is configured. Cross-origin chat attempts are rejected; a production smoke test returned HTTP 403.

## Build and runtime checks performed

- `node --check` passed for the changed server modules.
- `npm run build` passed after all changes.
- Production smoke test on a temporary local port returned:
  - `GET /api/survive-status` → HTTP 200
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - Content-Security-Policy present
  - cross-origin `POST /api/chat` → HTTP 403
- Configured credential values were checked against the generated `dist/` bundle without printing them; no matches were found.
- No PEM, private-key, certificate, or SSH private-key files were found in the project tree.
- `@solana/spl-token` was removed; a post-change dependency check confirms only `@solana/web3.js` remains from the Solana runtime dependency set.

## Files changed by this audit

- [.gitignore](.gitignore)
- [.env.example](.env.example)
- [package.json](package.json)
- [package-lock.json](package-lock.json)
- [server/server.mjs](server/server.mjs)
- [server/survive/chat.mjs](server/survive/chat.mjs)
- [server/survive/index-store.mjs](server/survive/index-store.mjs)
- [server/survive/solana.mjs](server/survive/solana.mjs)
- [src/terminal-page.jsx](src/terminal-page.jsx)
- `SECURITY_AUDIT.md`

## Safe first-commit checklist

After rotating the credentials, initialize Git and run the following before `git commit`:

```powershell
git init
git check-ignore -v .env .env.local .env.production data/survive-index.json
git add -A
git status --short
git diff --cached --name-only
git diff --cached -- .env .env.local .env.production
git log --all -- .env .env.local .env.production
git remote -v
```

Expected result: `.env*` and `data/` are ignored, no populated environment file appears in the staged file list, no secret appears in a diff, and no unexpected remote is configured. Do **not** use `git add -f .env`.

Before deployment, terminate TLS at the hosting platform/reverse proxy, keep this Node process bound behind that proxy, and add proxy-level request/connection limits appropriate to expected traffic.
