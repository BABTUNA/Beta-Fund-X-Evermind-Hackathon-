// EverNav background service worker.
//
// Responsibilities:
//   1. Route messages between popup ↔ content script.
//   2. Persist session state to chrome.storage.session (SW idles after ~30s).
//   3. Orchestrate: vision call → overlay step → success → write to Evermind + Butterbase.
//   4. On task start, check Evermind cache first. Cache hit = replay trail, skip vision.
//   5. Keep the SW warm during an active session via chrome.alarms.
//
// Structure: all stubs in this commit; vision/evermind/butterbase wired in later commits.

const KEEPALIVE_ALARM = "evernav-keepalive";
const SHARED_USER = "global_skills"; // cross-user cache-hit bucket

// ─── state helpers ────────────────────────────────────────────────────────────

async function getState() {
  const { sessionState } = await chrome.storage.session.get("sessionState");
  return sessionState || null;
}

async function setState(patch) {
  const cur = (await getState()) || {};
  const next = { ...cur, ...patch };
  await chrome.storage.session.set({ sessionState: next });
  return next;
}

async function clearState() {
  await chrome.storage.session.remove("sessionState");
}

// ─── keep-alive ───────────────────────────────────────────────────────────────

async function startKeepAlive() {
  await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.3 });
}

async function stopKeepAlive() {
  await chrome.alarms.clear(KEEPALIVE_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // No-op: just touching the SW keeps it warm.
  }
});

// ─── key/config access ────────────────────────────────────────────────────────

async function getConfig() {
  return await chrome.storage.local.get([
    "anthropic",
    "evermind",
    "butterbase",
    "bbAppId",
  ]);
}

// ─── vendor calls (stubs, filled in later commits) ────────────────────────────

const VISION_MODEL = "claude-sonnet-4-6";
const VISION_SYSTEM = `You guide users through web UIs.

You will receive a screenshot of the user's current browser tab and a JSON
list of interactive elements visible in the viewport. Each element has an
\`idx\`, \`tag\`, \`text\`, \`aria\`, \`testid\`, \`role\`, and \`bbox\`.

Pick the single next element the user should click to make progress on
their stated task. Prefer elements whose \`text\` or \`aria\` matches the
task intent. The screenshot is only the visible viewport — if the task
requires off-screen content, pick an element that will scroll there.

Return STRICT JSON, nothing else, no markdown fences:
{"idx": <number>, "instruction": "<one short imperative sentence>", "done": <boolean>}

If the task appears complete based on the current screenshot, set
done=true and idx=-1.`;

async function callVision({ screenshotB64, elements, task, apiKey }) {
  const body = {
    model: VISION_MODEL,
    max_tokens: 256,
    system: VISION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: screenshotB64,
            },
          },
          {
            type: "text",
            text: `Task: ${task}\n\nElements (JSON):\n${JSON.stringify(elements)}`,
          },
        ],
      },
    ],
  };

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`vision ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const text = data?.content?.[0]?.text || "";
  return parseVisionJson(text);
}

function parseVisionJson(text) {
  // Strip markdown fences in case the model ignored the system prompt.
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // Find the first {…} block if the model added prose.
  const match = stripped.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : stripped;
  const parsed = JSON.parse(raw);
  if (typeof parsed.idx !== "number") throw new Error("vision returned no idx");
  if (typeof parsed.done !== "boolean") parsed.done = false;
  if (typeof parsed.instruction !== "string") parsed.instruction = "Click this.";
  return parsed;
}

const EVERMIND_BASE = "https://everos.evermind.ai/api/v1";

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function sessionIdFor(site, task) {
  // Encodes site + task into a single filterable field. If filters in Evermind
  // turns out to accept only user_id (not arbitrary keys), session_id is still
  // first-class and we can filter on that instead.
  return `${site}::${slugify(task)}`;
}

async function evermindRead({ task, site }) {
  const cfg = await getConfig();
  if (!cfg.evermind) return null;

  const body = {
    query: `${task} on ${site}`,
    method: "hybrid",
    memory_types: ["episodic_memory"],
    top_k: 3,
    filters: { user_id: SHARED_USER },
  };

  let resp;
  try {
    resp = await fetch(`${EVERMIND_BASE}/memories/search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.evermind}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[evernav] evermind unreachable:", e.message);
    return null;
  }
  if (!resp.ok) {
    console.warn("[evernav] evermind search non-2xx:", resp.status);
    return null;
  }

  const data = await resp.json();
  // The hybrid search response shape can vary; we look for any field that
  // looks like a list of hits with `content`. Be liberal in what we accept.
  const hits = data?.results || data?.memories || data?.hits || data?.data || [];
  const wantId = sessionIdFor(site, task);

  for (const h of hits) {
    // Try common content paths.
    const raw =
      h?.content ||
      h?.message?.content ||
      h?.messages?.[0]?.content ||
      h?.text ||
      "";
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    if (!parsed?.trail || !Array.isArray(parsed.trail)) continue;

    // Prefer exact session_id match (set on write); fall back to site match.
    const matchesId = h?.session_id === wantId || parsed?.session_id === wantId;
    const matchesSite = parsed?.site === site;
    if (matchesId || matchesSite) return parsed;
  }
  return null;
}

async function evermindWrite({ task, site, trail }) {
  const cfg = await getConfig();
  if (!cfg.evermind) return;

  const session_id = sessionIdFor(site, task);
  const payload = {
    user_id: SHARED_USER,
    session_id,
    messages: [
      {
        message_id: `evernav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sender_id: "evernav",
        sender_name: "EverNav Recorder",
        role: "assistant",
        timestamp: Date.now(),
        content: JSON.stringify({ task, site, session_id, trail }),
      },
    ],
  };

  try {
    const resp = await fetch(`${EVERMIND_BASE}/memories`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.evermind}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.warn("[evernav] evermind write non-2xx:", resp.status, await resp.text());
    }
  } catch (e) {
    console.warn("[evernav] evermind write failed:", e.message);
  }
}

async function butterbaseLog({ user, site, task, stepCount }) {
  // TODO(commit 11): POST one row into sessions table.
}

// ─── orchestration ────────────────────────────────────────────────────────────

async function startGuidance({ task, user, tabId, url }) {
  const site = new URL(url).hostname;
  await startKeepAlive();
  await setState({ task, user, site, tabId, trail: [], step: 0, status: "active" });

  // Cache check first.
  const cached = await evermindRead({ task, site });
  if (cached && Array.isArray(cached.trail) && cached.trail.length > 0) {
    await setState({ trail: cached.trail, source: "cache" });
    await dispatchToContent(tabId, {
      type: "REPLAY_TRAIL",
      trail: cached.trail,
    });
    return { ok: true, cacheHit: true, steps: cached.trail.length };
  }

  // Live path: capture viewport + ask vision for first step.
  await setState({ source: "live" });
  await requestNextLiveStep();
  return { ok: true, cacheHit: false, steps: null };
}

async function stopGuidance({ tabId }) {
  await dispatchToContent(tabId, { type: "CLEAR_OVERLAY" });
  await stopKeepAlive();
  await clearState();
  return { ok: true };
}

async function requestNextLiveStep() {
  const st = await getState();
  if (!st || st.status !== "active") return;

  const cfg = await getConfig();
  if (!cfg.anthropic) {
    console.error("[evernav] missing anthropic key — set it in options");
    return;
  }

  // 1) Screenshot the active tab.
  const screenshotDataUrl = await chrome.tabs.captureVisibleTab(undefined, {
    format: "jpeg",
    quality: 70,
  });
  const screenshotB64 = screenshotDataUrl.split(",")[1];

  // 2) Ask the content script for the current interactive-element list.
  const enumResp = await dispatchToContent(st.tabId, { type: "ENUMERATE_ELEMENTS" });
  if (!enumResp?.ok) {
    console.error("[evernav] could not enumerate elements");
    return;
  }
  const elements = enumResp.elements;

  // 3) Call vision.
  let pick;
  try {
    pick = await callVision({
      screenshotB64,
      elements,
      task: st.task,
      apiKey: cfg.anthropic,
    });
  } catch (e) {
    console.error("[evernav] vision call failed:", e);
    return;
  }

  // 4) If the model says done, flip the flag — the next STEP_COMPLETED will
  //    trigger the write+log path. If the user is already done, just close out.
  if (pick.done || pick.idx === -1) {
    await setState({ taskDone: true });
    // Synthesize a completion (no real click happened) so onStepCompleted runs.
    onStepCompleted({ stepIndex: st.step, target: null });
    return;
  }

  // 5) Highlight the chosen element.
  await dispatchToContent(st.tabId, {
    type: "HIGHLIGHT_INDEX",
    idx: pick.idx,
    instruction: pick.instruction,
    stepIndex: st.step,
  });
}

async function onStepCompleted({ stepIndex, target }) {
  const st = await getState();
  if (!st) return;

  const trail = [...(st.trail || []), { stepIndex, target }];
  await setState({ trail, step: stepIndex + 1 });

  // If this was the final step (vision returned done:true earlier), persist + log.
  if (st.taskDone) {
    await evermindWrite({ task: st.task, site: st.site, trail });
    await butterbaseLog({
      user: st.user,
      site: st.site,
      task: st.task,
      stepCount: trail.length,
    });
    await stopGuidance({ tabId: st.tabId });
  } else if (st.source === "live") {
    await requestNextLiveStep();
  }
}

// ─── messaging ────────────────────────────────────────────────────────────────

async function dispatchToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    console.warn("[evernav] content script not present:", e.message);
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "START_GUIDANCE":
          sendResponse(await startGuidance(msg));
          break;
        case "STOP_GUIDANCE":
          sendResponse(await stopGuidance(msg));
          break;
        case "STEP_COMPLETED":
          await onStepCompleted(msg);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `unknown type: ${msg.type}` });
      }
    } catch (e) {
      console.error("[evernav]", e);
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

console.log("[evernav] background service worker loaded");
