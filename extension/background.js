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

async function callVision({ screenshotB64, elements, task }) {
  // TODO(commit 9): wire Sonnet 4.6 vision call.
  throw new Error("vision not wired yet");
}

async function evermindRead({ task, site }) {
  // TODO(commit 10): hybrid search against shared global_skills bucket.
  return null;
}

async function evermindWrite({ task, site, trail }) {
  // TODO(commit 10): POST /memories with trail in content.
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
  // TODO(commit 9): wired with vision after element-list builder lands.
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
