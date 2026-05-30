# EverNav

A Chrome extension that guides you through complex web UIs.
Type what you want to do, and EverNav blurs the page and glows the exact
element to click. Once one user completes a task, every future user gets
that click-trail replayed instantly from memory.

Built for the **Beta Fund × Evermind One Person Company Hackathon (2026-05-30)**.

## How it works

```
   ┌─ popup ──────────┐
   │ "rotate my PAT"  │
   └────────┬─────────┘
            ▼
   ┌─ background SW ──────────────────────────────────────────┐
   │  1. Evermind /memories/search   ── cache hit? replay ────┼──► overlay
   │  2. else: screenshot tab        + element list           │
   │       → Sonnet 4.6 vision       → element idx + text     │
   │  3. on click: record step, advance                       │
   │  4. on done: Evermind /memories + Butterbase row         │
   └──────────────────────────────────────────────────────────┘
```

- **Anthropic Claude Sonnet 4.6** — the vision call that picks the next click target
- **Evermind EverOS** — stores completed trails as shared "skills"; the cross-user cache hit is the demo wow moment
- **Butterbase** — logs each session, hosts the static companion dashboard

## Repo layout

```
extension/    Chrome MV3 extension (sideload in developer mode)
dashboard/    Next.js static-export dashboard, deployed via Butterbase
fixtures/     Pre-recorded fallback trails for demo safety
scripts/      Cache priming + demo helpers
docs/         Demo-day pre-flight checklist
```

## Setup

### 1. Get your three API keys

| Provider | URL | Note |
|---|---|---|
| Anthropic | `console.anthropic.com` | Set a $5 spend cap. |
| Butterbase | `dashboard.butterbase.ai` | Apply promo `Build0530`. Generate a `bb_sk_` key and note your **app_id**. |
| Evermind | `everos.evermind.ai` | Cloud signup. |

### 2. Stand up the Butterbase backend

Install the Butterbase MCP plugin in Claude Code:

```bash
claude plugin marketplace add https://github.com/NetGPT-Inc/butterbase-plugin
claude plugin install butterbase
export BUTTERBASE_API_KEY=bb_sk_...
```

Then ask Claude Code: *"create an app called `evernav`, apply this schema, and give me the runtime POST URL for inserting a row."*

```json
{
  "tables": {
    "sessions": {
      "columns": {
        "id":           { "type": "uuid", "primary_key": true, "default": "gen_random_uuid()" },
        "user_id":      { "type": "text", "nullable": false },
        "site":         { "type": "text", "nullable": false },
        "task":         { "type": "text", "nullable": false },
        "step_count":   { "type": "integer", "default": 0 },
        "completed_at": { "type": "timestamptz", "default": "now()" }
      }
    }
  }
}
```

If the runtime POST URL differs from `https://api.butterbase.ai/v1/apps/{app_id}/tables/sessions/rows`, update `BUTTERBASE_BASE` in `extension/background.js` and `NEXT_PUBLIC_BUTTERBASE_BASE` in `dashboard/.env.local`.

### 3. Sideload the extension

```
chrome://extensions  →  Developer mode ON  →  Load unpacked  →  pick extension/
```

Pin the extension. Click ⚙ in the popup → paste your three keys + your Butterbase app_id → Save.

### 4. Build + deploy the dashboard

```bash
cd dashboard
cp .env.example .env.local
# edit .env.local: NEXT_PUBLIC_BB_APP_ID and NEXT_PUBLIC_BB_READ_KEY
npm install
npm run build      # produces ./out
```

Deploy via the Butterbase MCP — ask Claude Code: *"deploy `dashboard/out` as a static frontend for app evernav."* Note the public URL.

### 5. Prime the Evermind cache

```bash
EVERMIND_KEY=evos_... \
DASHBOARD_URL=https://your-app.butterbase.ai \
node scripts/prime-evermind.js fixtures/rotate-pat-trail.json
```

Paste the `chrome.storage.local.set(...)` snippet the script prints into the extension service worker's DevTools console (`chrome://extensions` → EverNav → "service worker").

### 6. Demo

1. Open `github.com/settings/tokens`.
2. Click the extension. Type `rotate my personal access token`. Hit **Guide me**.
3. First time: vision picks each element, blur + glow walks you through.
4. Switch user (popup → `switch`). Same task → instant cache replay from Evermind.
5. Open the dashboard URL → session count incremented.

See `docs/demo-day-checklist.md` for the 15-minute pre-flight and co-driver hot-key map.

## Security

- API keys live in `chrome.storage.local`, never in the repo.
- `.env.local` is gitignored. Use `.env.example` as a template.
- **Rotate every key within an hour of demo end** — treat any key that ever existed on the demo laptop as burned.

## Known caveats

- The Butterbase runtime POST URL is **inferred** from documented patterns. Verify via the MCP before relying on it.
- The Evermind cloud `/memories/search` response envelope isn't documented inline; the parser is liberal in what it accepts (`results`, `memories`, `hits`, `data`).
- The shipped fallback trail in `fixtures/` is a best-guess. Re-record after the first successful live run.
- Scope is github.com only (manifest content_scripts). Adding sites is one line.
