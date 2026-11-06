# Repository instructions

This plugin connects opencode to `kimi-for-coding` through kimi-cli-compatible
device-flow OAuth. Static API keys and other models are outside its scope.
Use `@ai-sdk/openai-compatible` for SSE and `reasoning_content` handling.
Keep installation and usage instructions in [README.md](README.md).

## Architecture

Use the existing source modules for their listed responsibilities.

| File               | Responsibility                                                                 |
|--------------------|--------------------------------------------------------------------------------|
| `src/constants.ts` | Pinned strings that must mirror upstream kimi-cli (version, endpoints, client id). |
| `src/headers.ts`   | The seven `X-Msh-*` / UA headers + the persistent `~/.kimi/device_id` file.    |
| `src/oauth.ts`     | Device-code start, device-code poll, refresh-token exchange, and `GET /coding/v1/models` discovery. |
| `src/auth-store.ts`| Read/write opencode's `auth.json` entries for this provider.                    |
| `src/auth-refresh.ts`| Lock-based token refresh with cross-instance coordination, `ensureFreshStoredAuth` for standalone callers. |
| `src/index.ts`     | Plugin entry (v1 `PluginModule` format). Wires `auth` (login + loader) plus the Kimi chat hooks/body rewrite. |
| `src/usage.ts`     | Fetch and parse Kimi subscription usage (`/coding/v1/usages`).                 |
| `src/tui.tsx`      | TUI slash command `/kimi:usage` — renders usage in an opencode dialog.         |

Data flow on a chat request:

1. opencode asks the `@ai-sdk/openai-compatible` provider for a language model.
2. Before instantiating it, opencode calls our `auth.loader`. We return `{ apiKey, fetch }`.
3. The SDK uses our `fetch` for every HTTP call (models, chat, whatever).
4. Our `fetch` calls `ensureFresh()` → prefers the live opencode auth-store entry over stale `OPENCODE_AUTH_CONTENT` snapshots → maybe refreshes (sharing one in-flight promise in-process and a lock across plugin instances so they don't race the same refresh token) → lazily discovers `/coding/v1/models` when needed → sets Authorization + the seven `X-Msh-*` headers → on 401 refreshes once and retries.
5. Separately, opencode runs `chat.headers` and `chat.params`. `chat.headers` computes `thinking`, `reasoning_effort`, and `prompt_cache_key` from `input.model.options` plus the selected `input.message.model.variant`, then passes them to `loader.fetch` via private `x-opencode-kimi-*` headers. `loader.fetch` strips those headers and injects the wire fields into the JSON body. `chat.params` mirrors the same keys into `output.options` only as a forward-compat fallback if opencode later fixes its openai-compatible providerOptions namespace mismatch.

## Protocol contracts

Check the cited upstream implementation before changing these contracts.

1. **`X-Msh-Version` and `User-Agent` must track `kimi-cli`.** Bumping involves exactly one line in `src/constants.ts`. See upstream `research/kimi-cli/src/kimi_cli/constant.py`. The UA prefix is `KimiCLI/` (not `KimiCodeCLI/`) — Moonshot's `kimi-for-coding` backend 403s with `access_terminated_error: only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code…` on any other prefix. Likewise, `X-Msh-Device-Model` must mirror kimi-cli's `_device_model()` shape, including the Darwin/Windows special cases (`macOS <version> <arch>`, `Windows 10/11 <arch>`, Linux `"{system} {release} {machine}"`) — NOT just `{arch}` — and `X-Msh-Os-Version` is the kernel build string from `os.version()`, NOT `"{type} {release}"`. Tested live against `api.kimi.com/coding/v1` on 2026-04-17 — any of those three fields off-spec → 403.
2. **`X-Msh-Device-Id` must be stable across runs.** Never regenerate a fresh UUID at import time. `getDeviceId()` reads/writes `~/.kimi/device_id`; that path is shared with `kimi-cli` on purpose.
3. **`Authorization` header is owned by `loader.fetch`.** Anything else (opencode core, the SDK, future hooks) must be overridden. Our `loader` deletes both `authorization` and `Authorization` before setting its own. The private `x-opencode-kimi-*` transport headers are also consumed and stripped there; they must never leak upstream.
4. **Effort ↔ fields mapping** (kimi-cli `llm.py` / `kosong/chat_provider/kimi.py`):

   | Effort   | `reasoning_effort` | `thinking`            |
   |----------|--------------------|-----------------------|
   | `auto`   | *(omitted)*        | *(omitted)*           |
   | `off`    | *(omitted)*        | `{type:"disabled"}`   |
   | `low`    | `"low"`            | `{type:"enabled"}`    |
   | `medium` | `"medium"`         | `{type:"enabled"}`    |
   | `high`   | `"high"`           | `{type:"enabled"}`    |
   | `xhigh`  | `"high"` (clamped) | `{type:"enabled"}`    |
   | `max`    | `"high"` (clamped) | `{type:"enabled"}`    |

   `auto` is the "let the server decide dynamically" variant — neither field is sent, matching kimi-cli's "nothing passed" default. `xhigh` and `max` are clamped to `"high"` because Kimi's backend does not support higher tiers (kimi-cli's `Kimi.with_thinking()` does the same). When no effort is set at all, the plugin still emits `thinking: {type: "enabled"}` because the model is a reasoner. Compute this from `input.model.options` plus `input.model.variants[input.message.model.variant]`, not from `input.provider.info.id`. The `@opencode-ai/plugin` `ProviderContext` type claims `.info.id` exists, but the runtime shape opencode passes (see `research/opencode/packages/opencode/src/session/llm.ts::stream`, ~line 168, `provider: item`) is the flat `ProviderConfig` (`.id`). `input.model.providerID` is what every first-party plugin uses (cloudflare.ts, codex.ts, github-copilot/copilot.ts) and it avoids the runtime crash "undefined is not an object (evaluating 'input.provider.info.id')". Tested live 2026-04-17.

5. **`prompt_cache_key` only for `kimi-for-coding`.** Never attach it to unrelated models. The check is `input.model.id === MODEL_ID` in the Kimi chat hooks, and the actual wire injection happens in `loader.fetch`.
6. **Wire model id comes from `/coding/v1/models`, not from user config.** The opencode-side model id is a stable alias (`MODEL_ID = "kimi-for-coding"`); the plugin calls `GET /coding/v1/models` at login and on every token refresh (mirroring kimi-cli's `refresh_managed_models` in `research/kimi-cli/src/kimi_cli/auth/platforms.py`), caches the first returned `{id, context_length, display_name, supports_image_in, supports_video_in}` in loader memory, rewrites the JSON body `model` field inside `loader.fetch` whenever the discovered id differs from `MODEL_ID`, and backfills runtime model metadata from the same discovery response. A new loader instance re-discovers on first use if needed. Do not strip the `kimi-` prefix; send whatever the server returned. Discovery failures are non-fatal (warm cached id still works; 401 retry flushes broken tokens).
7. **Auth store is opencode's, not kimi-cli's.** We use opencode's auth store for tokens under the `kimi-for-coding-oauth` provider id. Do not read/write `~/.kimi/credentials/kimi-code.json`; that's kimi-cli's file and sharing it across independent apps causes token-race bugs. The plugin may live-read opencode's `auth.json` entry for this provider to bypass stale `OPENCODE_AUTH_CONTENT` workspace snapshots, but writes still go through opencode's auth store (`client.auth.set`). Also note that opencode's SDK auth schema only persists the standard oauth fields, so model discovery metadata cannot be stored there durably.
8. **Provider id must not collide with any id in the [models.dev](https://models.dev) catalog.** models.dev publishes `kimi-for-coding` as a separate API-key-driven integration. If we registered under that same id, `opencode auth login kimi-for-coding` would surface two methods under one entry and users could silently land on the wrong integration path. We deliberately use `kimi-for-coding-oauth` instead; `MODEL_ID` on the wire stays `kimi-for-coding` (rule 6).
9. **`src/index.ts` must have exactly one export — the default `PluginModule` object `{ id, server }`.** opencode's plugin loader (`research/opencode/packages/opencode/src/plugin/index.ts`) first tries `readV1Plugin` (detect mode) on the default export. If it finds an object with `server` (and optional `id`), it uses the v1 path directly. The older legacy path (`getLegacyPlugins`) iterates every export and throws `Plugin export is not a function` on any non-callable value — a problem that surfaced on Windows where Bun's standalone-binary dynamic imports can produce module namespace objects with unexpected non-function metadata. The v1 format bypasses `getLegacyPlugins` entirely. Keep constants in `src/constants.ts` and import them in `src/index.ts` rather than re-exporting. `test/exports.test.ts` guards this. The failure mode of a broken export is silent in the CLI (the provider just doesn't appear in `opencode auth login`); the error only surfaces in `~/.local/share/opencode/log/*.log`.
10. **The post-login config hint must not emit a partial `limit` object.** opencode's live config schema at `https://opencode.ai/config.json` requires both `limit.context` and `limit.output` whenever `limit` is present, while Kimi's `GET /coding/v1/models` only gives us `context_length`. Therefore `buildConfigBlock()` omits `limit` entirely and leaves `provider.models` to backfill `limit.context` at runtime. Do not invent `output` or set `input` heuristically; opencode's overflow logic treats `limit.input` as authoritative (`research/opencode/packages/opencode/src/session/overflow.ts`).
11. **Concurrent refreshes must collapse to one in-flight OAuth exchange, even across plugin instances.** `provider.models` and `auth.loader` can both notice an expiring token at about the same time, and separate opencode workspace/plugin instances can inherit stale auth snapshots. `refreshAuth()` in `src/index.ts` therefore shares one promise across overlapping callers, takes a provider-scoped auth-store lock before refreshing, re-reads opencode's live auth-store entry under that lock, and treats a changed on-disk token chain as authoritative. `test/plugin.test.ts` covers loader-vs-loader, provider.models-vs-loader, cross-instance lock reuse, and the `invalid_grant` self-heal path where another process already rotated the refresh token.
12. **Media-input capabilities must be backfilled from `/coding/v1/models`.** `supports_image_in` and `supports_video_in` from Kimi discovery are not cosmetic metadata: opencode's provider transform (`research/opencode/packages/opencode/src/provider/transform.ts::unsupportedParts`) rewrites every image part into local `ERROR: Cannot read ... (this model does not support image input)` text before the request reaches our loader when `capabilities.input.image` is false. Therefore `provider.models` must patch runtime model metadata for `kimi-for-coding`, and `buildConfigBlock()` must include `attachment: true` plus appropriate `modalities.input` / `modalities.output` when discovery says images/video are supported. `test/plugin.test.ts` covers both paths.

## Working on this repo

- Code style: see `tsconfig.json` (strict, `noUncheckedIndexedAccess`, ES2022). Prefer small pure functions, avoid `try`/`catch` except where we genuinely convert one error shape to another.
- Comments: match the existing density — only explain non-obvious upstream-parity reasoning. Do not narrate the obvious ("// refresh the token"); instead reference upstream files when the reasoning is "because kimi-cli does it that way".
- Dependencies: runtime deps are limited to `@opentui/core` and `@opentui/solid` (for the TUI slash command). The only dev/peer dep is `@opencode-ai/plugin` for types. Do not add further runtime deps.
- Git commits: small, logical, imperative subject ("Add oauth device flow"). Do not add a `Co-authored-by` trailer.
- Upstream research: the `research/` directory is a read-only git-ignored pair of shallow clones (opencode + kimi-cli) for grep. Never edit files there; re-clone if you suspect drift. When citing upstream in a comment, use the `research/…` path so the reference is resolvable.
- Version bumps: when kimi-cli bumps, (1) pull a fresh `research/kimi-cli`, (2) update `KIMI_CLI_VERSION` in `src/constants.ts`, (3) re-diff `_kimi_default_headers()` / `oauth.py` against `src/headers.ts` and `src/oauth.ts`, (4) smoke-test with `opencode auth login kimi-for-coding-oauth` and a one-turn chat, (5) tag release.
- Tests: `test/` holds one file per source file plus `test/exports.test.ts` (the rule-9 guard). Tests mock `fetch` via `test/_util/fetchMock.ts`; no real credentials or network. They use the real `~/.kimi/device_id` on purpose — it is shared with kimi-cli by design and `getDeviceId` is idempotent, so tests don't clobber state. When adding a new contract to the list above, add the matching offline check to the corresponding test file rather than creating new ones.

Keep model-ID checks in the Kimi chat hooks and `loader.fetch`.
Ship TypeScript source directly; opencode's Bun loader loads it without a build step.

## Verification

Run only tests and checks affected by the change locally, including callers
of changed shared code. The full test suite belongs in CI/CD, including final
acceptance. Check CI results for the exact delivered commit; report missing
or failed checks. Do not substitute a full local run for missing CI coverage.
For documentation-only changes, check meaning, references and formatting.

Offline checks, selected according to the changed files:

```sh
bunx tsc --noEmit                                  # type-check
bunx tsc --noEmit --project tsconfig.tests.json    # type-check tests/helpers
bun build --target=node --no-bundle src/index.ts   # syntax check
bun test test/affected.test.ts                    # select affected test files
```

For an authorized live check with a Kimi-for-coding account:

1. Install the local checkout via opencode's plugin flow (`opencode plugin /path/to/this/repo --global`) or point the `plugin` array in your opencode config at the repo root, as shown in `README.md`.
2. Paste the provider block from `README.md` into your opencode config.
3. `opencode auth login kimi-for-coding-oauth` — confirm a token lands in opencode's `auth.json` with `type: "oauth"`, a JWT `access`, and `expires` ~15 min in the future.
4. Start opencode and select `kimi-for-coding-oauth/kimi-for-coding`. Check that the outgoing model ID matches `/coding/v1/models`.
5. Confirm `reasoning_content` deltas render as thinking content (not assistant text).
6. In a second turn of the same session, check that the request reuses `prompt_cache_key`. Response time alone does not prove a cache hit.

If any of 3–6 fails, diff `research/kimi-cli` against the contracts above.

Add repository rules only when an observed incident or checked upstream source
supports them. Reference the upstream file when a comment explains parity.
