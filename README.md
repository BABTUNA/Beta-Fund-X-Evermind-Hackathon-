# EverNav

A Chrome extension that guides you through complex web UIs.
Type what you want to do, and EverNav blurs the page and glows the right element to click.

Built for the Beta Fund x Evermind One Person Company Hackathon (2026-05-30).

## Stack

- **Chrome Extension (MV3)** — captures the active tab, calls a vision model, renders a guided overlay
- **Anthropic Claude Sonnet 4.6** — vision model that picks the next element to click
- **Evermind EverOS** — caches completed click trails so subsequent users skip the vision call
- **Butterbase** — logs each session and hosts the companion dashboard

## Repo layout

```
extension/    Chrome extension (sideload in developer mode)
dashboard/    Next.js static-export dashboard, deployed via Butterbase
fixtures/     Pre-recorded fallback trails for demo safety
scripts/      Cache-priming + demo helpers
```

## Setup (TL;DR)

See full instructions at the end of the build. BYO API keys via the extension's options page.
