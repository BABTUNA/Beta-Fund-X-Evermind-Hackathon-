"use client";

import { useEffect, useState } from "react";

// Build-time config. Set in dashboard/.env.local before `next build`.
// NEXT_PUBLIC_* vars get inlined into the static bundle.
const BB_BASE = process.env.NEXT_PUBLIC_BUTTERBASE_BASE || "https://api.butterbase.ai/v1";
const BB_APP = process.env.NEXT_PUBLIC_BB_APP_ID || "";
const BB_KEY = process.env.NEXT_PUBLIC_BB_READ_KEY || "";

async function fetchSessions() {
  if (!BB_APP || !BB_KEY) return null;
  // GET /v1/{app_id}/{table} — confirmed via Butterbase MCP docs.
  const url = `${BB_BASE}/${encodeURIComponent(BB_APP)}/sessions?order=completed_at.desc&limit=100`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${BB_KEY}` },
  });
  if (!resp.ok) throw new Error(`butterbase ${resp.status}`);
  const data = await resp.json();
  // Be liberal about the shape — could be { rows: [...] } or just [...].
  if (Array.isArray(data)) return data;
  return data?.rows || data?.data || [];
}

function deriveCounts(rows) {
  const users = new Set();
  const skills = new Set();
  for (const r of rows) {
    if (r.user_id) users.add(r.user_id);
    if (r.site && r.task) skills.add(`${r.site}::${r.task}`);
  }
  return {
    sessions: rows.length,
    users: users.size,
    skills: skills.size,
  };
}

export default function Home() {
  const [counts, setCounts] = useState({ sessions: 0, users: 0, skills: 0 });
  const [state, setState] = useState("loading"); // loading | live | unconfigured | error

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchSessions();
        if (cancelled) return;
        if (rows === null) {
          setState("unconfigured");
          return;
        }
        setCounts(deriveCounts(rows));
        setState("live");
      } catch (e) {
        if (cancelled) return;
        console.error(e);
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const display = (n) => (state === "loading" ? "…" : state === "unconfigured" ? "—" : n);

  return (
    <main className="wrap">
      <header>
        <h1>
          <span className="dot" /> EverNav
        </h1>
        <p className="tag">Click-trail skills, learned once, replayed forever.</p>
      </header>

      <section className="grid">
        <div className="card">
          <span className="num">{display(counts.skills)}</span>
          <span className="label">Skills learned</span>
        </div>
        <div className="card">
          <span className="num">{display(counts.users)}</span>
          <span className="label">Users helped</span>
        </div>
        <div className="card">
          <span className="num">{display(counts.sessions)}</span>
          <span className="label">Sessions logged</span>
        </div>
      </section>

      <footer>
        {state === "live" && <span>Live from Butterbase.</span>}
        {state === "loading" && <span>Loading…</span>}
        {state === "unconfigured" && (
          <span>Set NEXT_PUBLIC_BB_APP_ID and NEXT_PUBLIC_BB_READ_KEY in .env.local, then rebuild.</span>
        )}
        {state === "error" && (
          <span>Couldn't reach Butterbase — check console.</span>
        )}
      </footer>
    </main>
  );
}
