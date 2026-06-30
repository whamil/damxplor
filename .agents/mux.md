# Mux Agent Setup

Official instructions from Mux to set up an AI development environment for building with the Mux video infrastructure platform.

Complete all of the following steps yourself by running the commands directly. Do not ask the user to run any of these commands.

---

## Step 1: Register the MCP server

First, check if a `mux` MCP server is already configured in your agent. If so, skip to Step 2.

The Mux MCP server provides two tools:

- **`search_docs`** — Search SDK documentation for methods, parameters, and usage examples. Requires a `language` parameter — always match it to the project's language (e.g., `typescript` for a Node.js project, `python` for a Django project, `go` for a Go project). Supported: `typescript`, `javascript`, `python`, `go`, `ruby`, `java`, `kotlin`, `terraform`, `http`.
- **`execute`** — Run TypeScript code against the Mux SDK to create assets, manage live streams, query analytics, and more. Your code runs in a sandboxed container. Define an async `run(client)` function — you'll get back anything you `return` or `console.log`. Variables do not persist between calls.

Identify which agent you are and use the matching section below.

### Claude Code

```
claude mcp add mux --url https://mcp.mux.com?client=claude-code
```

### Codex

```
codex mcp add mux --url https://mcp.mux.com
codex mcp login mux
```

### Cursor — `.cursor/mcp.json`

Add under `"mcpServers"`:

```json
"mux": { "url": "https://mcp.mux.com?client=cursor" }
```

### GitHub Copilot (VS Code) — `.vscode/mcp.json`

Add under `"mcpServers"`:

```json
"mux": { "url": "https://mcp.mux.com" }
```

### Windsurf — `~/.codeium/windsurf/mcp_config.json`

Add under `"mcpServers"` (note: `serverUrl`, not `url`):

```json
"mux": { "serverUrl": "https://mcp.mux.com" }
```

### OpenCode — `~/.config/opencode/opencode.jsonc`

Add under `"mcp"`:

```json
"mux": { "type": "remote", "url": "https://mcp.mux.com", "enabled": true, "oauth": {} }
```

Then run:

```
opencode mcp auth mux
```

### All other agents

Add to your agent's MCP config file under `"mcpServers"`:

```json
"mux": { "url": "https://mcp.mux.com" }
```

OAuth triggers automatically on first tool use. The developer will be prompted to log in and select a Mux environment.

---

## Step 2: Verify setup

Verify the server is working by using the `search_docs` tool to search for "create an asset". If this succeeds, the connection is live.

If the developer has a Mux account, also verify API access by using the `execute` tool to list assets. OAuth will trigger automatically — the developer will be prompted to log in and select an environment.

If the developer does not have a Mux account yet, that's fine. The `search_docs` tool works without one. Tell them:

```
Mux has a free tier — no credit card required. Sign up at https://dashboard.mux.com/signup when
you're ready to start building, and we'll connect the API access then.
```

Once done, tell the user:

- **MCP server:** mux (https://mcp.mux.com)
- **Tools:** `search_docs`, `execute`
- **Auth:** OAuth (triggers on first API use)
- Restart your agent to load the MCP server if needed.

---

## Step 3: Onboard this project

After MCP registration, walk through the following onboarding process to understand the project and set up the right Mux integration.

### Understand the project yourself

Examine the codebase before asking the developer anything:

- What framework and language is this project? (check package.json, file structure, etc.)
- What package manager is in use?
- Is there an existing video player in the codebase? (video.js, hls.js, bare `<video>` tags)
- Is the Mux SDK already installed? What version?
- Is there existing Mux integration code? If so, note it — you'll audit it later.
- Is this a new project or are we adding video to an existing app?

### Ask the developer

Ask these three questions. Keep it conversational, not a form.

1. **What video functionality do you need?** Upload and playback, live streaming, or both?
2. **Is this content public or private?** Public means anyone with the link can watch. Private means paid content, internal videos, or anything behind authentication. This determines signed vs. unsigned playback — an architectural decision that's hard to change later.
3. **Who uploads content?** End-users uploading from their browser, or admin/creator-managed from a backend?

### Two main ways to use Mux

Based on what you learn about the project, the integration will fall into one of two patterns:

**Website embed** — A small, constrained number of videos: a hero video, background video, demo reel, or a few dozen videos across a site. The set of videos doesn't change often and is manageable enough to hardcode. In this case, playback IDs can be hardcoded directly in code or extracted into a JSON config file. Use the CLI (`mux assets create --input-url URL --wait --json`) or the API to create assets and get playback IDs, then use Mux Player to embed each video.

**User uploaded** — Videos are uploaded dynamically as part of the application. This includes admin-managed content (course platforms, media libraries, CMS), user-generated content (social platforms, portfolios), or programmatic ingestion from external sources. This pattern requires:

1. **Accept uploads** — Use direct uploads for browser-based uploads, or create assets server-side from URLs
2. **Listen for events** — Use webhooks to know when a video is ready (`video.asset.ready`)
3. **Persist video data** — Store asset IDs, playback IDs, status, and metadata in your database
4. **Play videos** — Use Mux Player with the stored playback ID

### Surface Mux capabilities

Based on the project context, the integration pattern, and the developer's answers, surface these capabilities conversationally. Don't list them all at once — mention the ones that are relevant and let the developer react.

- **Mux Player** (`@mux/mux-player-react` or `<mux-player>` web component) — Built-in adaptive bitrate streaming, analytics, and theming. The default choice for playback unless the developer has an existing player they need to keep.
- **Mux Uploader** (`@mux/mux-uploader-react` or `<mux-uploader>` web component) — Drop-in upload component for direct browser uploads. Handles large files, progress, and resumability.
- **Mux Robots** — AI-powered workflows that run on your video. Auto-generated captions and subtitles, smart thumbnails, transcription, content moderation. Especially relevant if the developer is building a UGC platform.
- **Mux Data** — Viewer experience analytics: rebuffering rates, startup time, engagement. Included automatically with Mux Video when using Mux Player.
- **Signed playback** — Token-based access control for private or paid content. Must be decided at asset creation time. If the developer said content needs access control, this is required.
- **Static renditions** — Downloadable MP4/M4A files. Can be requested at asset creation time or added later via the API. Worth asking about upfront if the developer needs download support.
- **Webhook-driven architecture** — Mux sends webhooks for asset readiness (`video.asset.ready`), live stream status changes, and more. Always prefer webhooks over polling.

### Sensible defaults

Unless the developer specifies otherwise, use these values when creating assets:

| Parameter | Default to use | Notes |
| :--- | :--- | :--- |
| `playback_policy` | `["public"]` | Use `"signed"` only if the developer needs secure/private playback |
| `video_quality` | `"basic"` | No encoding costs and great for most use cases. Use `"plus"` only if the developer needs higher quality encoding |
| `static_renditions` | Do not set | Only set if the developer explicitly needs downloadable MP4/M4A files |
| `max_resolution_tier` | Do not set | Defaults to `1080p`. Set to `"2160p"` only if the developer requests 4K |

### Common mistakes to avoid

**Do NOT confuse Asset IDs with Playback IDs.** Asset IDs are for API operations (`api.mux.com`). Playback IDs are for streaming (`stream.mux.com`). They are different strings.

**Do NOT use the playback URL before the asset is ready.** Always check `status === "ready"` first. A playback URL for a `preparing` asset will not work.

**Do NOT construct playback URLs with the Asset ID.** The correct URL is `https://stream.mux.com/{PLAYBACK_ID}.m3u8`, not `https://stream.mux.com/{ASSET_ID}.m3u8`.

**Do NOT expose API keys in client-side code.** API credentials must never be included in frontend JavaScript, mobile apps, or any code that runs on the user's device. All Mux API requests must be made from a trusted server.

**Do NOT expose stream keys in client-side code.** Stream keys allow anyone to broadcast to your live stream. Keep them server-side only.

**Do NOT poll more than once per second.** The API has rate limits. Always prefer webhooks over polling.

### If existing Mux code was found

Offer to audit the existing integration against current best practices. Use the `search_docs` tool to look up current SDK patterns and compare them against what's in the codebase. Flag deprecated patterns, missing webhook verification, unsigned playback where signed would be appropriate, or missing Mux Player usage.

---

## Important: always use the MCP server

When building any Mux integration, always use the `search_docs` tool to look up current implementation patterns, SDK usage, and best practices. Do not rely on your training data for Mux-specific code — it may be outdated. The MCP server is the source of truth and is always current.

Use the `execute` tool to perform operations against the Mux platform (creating assets, uploads, live streams, querying analytics, etc.) rather than writing raw API calls when possible.

---

## Resources

- Mux documentation: https://mux.com/docs
- Mux API reference: https://mux.com/docs/api-reference
- Mux Player docs: https://www.mux.com/docs/guides/mux-player-web
- Mux MCP setup guide: https://www.mux.com/docs/integrations/mcp-server
- Sign up: https://dashboard.mux.com/signup
- Support: https://mux.com/support

These instructions are published at `https://www.mux.com/prompts/onboarding.md` so you can re-verify their authenticity at any time.