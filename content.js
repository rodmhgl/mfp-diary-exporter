/**
 * content.js — runs inside the logged-in www.myfitnesspal.com tab.
 *
 * The page's "Printable Diary" report is a front-end for POST /api/services/diary/report,
 * which accepts a from/to date range but caps each request at 365 days (longer ranges are
 * silently clipped, and full-year requests can fail). This script walks the requested range
 * in short windows, retries transient failures, splits a window in half if it keeps failing,
 * flattens every food entry into a CSV row, and hands the finished CSV to the background
 * service worker for download.
 *
 * All requests are same-origin and use the user's existing session cookies. Nothing leaves
 * the browser except the requests MyFitnessPal's own web app already makes.
 */
(() => {
  if (window.__mfpExporterLoaded) return;
  window.__mfpExporterLoaded = true;

  const COLS = [
    'date', 'meal_name', 'meal_position', 'brand_name', 'description', 'servings',
    'serving_value', 'serving_unit', 'gram_weight', 'calories', 'carbohydrates', 'fat',
    'protein', 'fiber', 'sugar', 'added_sugars', 'sodium', 'cholesterol', 'saturated_fat',
    'trans_fat', 'monounsaturated_fat', 'polyunsaturated_fat', 'potassium', 'calcium', 'iron',
    'vitamin_a', 'vitamin_c', 'vitamin_d', 'sugar_alcohols', 'food_id', 'entry_id',
    'created_at', 'logged_at'
  ];

  const state = {
    status: 'idle',          // idle | running | done | cancelled | failed
    done: 0, total: 0, days: 0, entries: 0,
    errors: [], message: '', cancel: false
  };

  // ---------- helpers ----------
  const fmt = d => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function detectAccount() {
    // Next.js pages embed the logged-in user's record in __NEXT_DATA__ (React Query's dehydrated
    // state). That blob also contains friends' usernames and UI strings such as
    // "username":"username", so a text regex can pick the wrong one — that once prefilled a
    // friend's numeric username and every request 404'd. Walk the parsed JSON instead and only
    // accept an object that also carries account details; friends' entries never do.
    const out = { username: null, createdAt: null };
    try {
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd && nd.textContent.trim()) {
        const user = findSessionUser(JSON.parse(nd.textContent));
        if (user) {
          out.username = user.username;
          const created = (user.account && user.account.created_at) || user.created_at;
          const iso = created && String(created).match(/^\d{4}-\d{2}-\d{2}/);
          if (iso) out.createdAt = iso[0];
        }
      }
    } catch (_) { /* fall through to the link-based fallback */ }
    if (!out.username) {
      // Legacy (non-Next.js) pages such as /food/diary have no __NEXT_DATA__ payload but do
      // link to the user's own diary.
      const a = document.querySelector('a[href*="/food/diary/"], a[href*="/printable-diary/"]');
      const m = a && a.getAttribute('href').match(/(?:printable-diary|food\/diary)\/([^/?#]+)/);
      if (m) out.username = decodeURIComponent(m[1]);
    }
    return out;
  }

  function findSessionUser(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return null;
    const hasAccount = (node.account && typeof node.account === 'object') || Array.isArray(node.profiles);
    if (typeof node.username === 'string' && node.username && hasAccount) return node;
    for (const key of Object.keys(node)) {
      const hit = findSessionUser(node[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function flatten(day, rows) {
    for (const e of (day.food_entries || [])) {
      const n = e.nutritional_contents || {}, f = e.food || {}, ss = e.serving_size || {};
      const row = {
        date: day.date, meal_name: e.meal_name, meal_position: e.meal_position,
        brand_name: f.brand_name, description: f.description, servings: e.servings,
        serving_value: ss.value, serving_unit: ss.unit, gram_weight: ss.gram_weight,
        calories: n.energy ? n.energy.value : null, carbohydrates: n.carbohydrates, fat: n.fat,
        protein: n.protein, fiber: n.fiber, sugar: n.sugar, added_sugars: n.added_sugars,
        sodium: n.sodium, cholesterol: n.cholesterol, saturated_fat: n.saturated_fat,
        trans_fat: n.trans_fat, monounsaturated_fat: n.monounsaturated_fat,
        polyunsaturated_fat: n.polyunsaturated_fat, potassium: n.potassium, calcium: n.calcium,
        iron: n.iron, vitamin_a: n.vitamin_a, vitamin_c: n.vitamin_c, vitamin_d: n.vitamin_d,
        sugar_alcohols: n.sugar_alcohols, food_id: f.id, entry_id: e.id,
        created_at: e.created_at, logged_at: e.logged_at
      };
      rows.push(COLS.map(c => esc(row[c])).join(','));
      state.entries++;
    }
  }

  // ---------- main export ----------
  async function runExport({ username, from, to, windowDays = 90, pauseMs = 400 }) {
    Object.assign(state, { status: 'running', done: 0, total: 0, days: 0, entries: 0,
                           errors: [], message: '', cancel: false });
    const rows = [];

    const csrfRes = await fetch('/api/auth/csrf', { credentials: 'include' });
    if (!csrfRes.ok) throw new Error('Could not get a CSRF token — are you logged in?');
    const csrf = (await csrfRes.json()).csrfToken;

    const start = new Date(from + 'T00:00:00Z'), end = new Date(to + 'T00:00:00Z');
    if (!(start <= end)) throw new Error('"From" date must be on or before "To" date.');
    const windows = [];
    for (let cur = start; cur <= end;) {
      let wEnd = addDays(cur, windowDays - 1); if (wEnd > end) wEnd = end;
      windows.push([fmt(cur), fmt(wEnd)]); cur = addDays(wEnd, 1);
    }
    state.total = windows.length;

    // Decide what one response means. Auth failures, an unknown username (404) and malformed
    // requests are permanent: retrying them and then splitting the window just burns minutes —
    // a wrong username used to cost ~93 requests and five minutes per 90-day window. Rate
    // limits, server errors and network failures are transient and worth retrying.
    const classify = (status, body) => {
      if (status === 200 && body.startsWith('[')) return { kind: 'ok' };
      if (status === 200) {
        // A 200 that is not a JSON array is the login page served after the session expired
        // (fetch follows the redirect). Retrying and splitting windows cannot fix that.
        return { kind: 'fatal', message: 'Your MyFitnessPal session has expired — reload the page, log in, and try again.' };
      }
      if (status === 401 || status === 403) {
        return { kind: 'fatal', message: 'Not authorised — log in to MyFitnessPal and try again.' };
      }
      let detail = '';
      try { detail = JSON.parse(body).error_description || ''; } catch (_) { /* not JSON */ }
      if (status === 404) {
        return { kind: 'fatal', message: `MyFitnessPal does not recognise the username "${username}". ` +
                                         'Check it matches your profile exactly.' + (detail ? ` (${detail})` : '') };
      }
      if (status === 400 || status === 422) {
        return { kind: 'fatal', message: `MyFitnessPal rejected the request (${status}${detail ? ': ' + detail : ''}).` };
      }
      return { kind: 'retry', message: `HTTP ${status}` + (detail ? `: ${detail}` : '') };
    };

    const fetchWin = async (wFrom, wTo, depth = 0) => {
      for (let attempt = 0; attempt < 3 && !state.cancel; attempt++) {
        let verdict;
        try {
          const r = await fetch('/api/services/diary/report', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
                       'X-CSRF-Token': csrf },
            body: JSON.stringify({ username, show_food_diary: 1, show_exercise_diary: 0,
                                   show_food_notes: 0, show_exercise_notes: 0,
                                   from: wFrom, to: wTo })
          });
          const t = await r.text();
          verdict = classify(r.status, t);
          if (verdict.kind === 'ok') {
            const j = JSON.parse(t);
            state.days += j.length;
            j.forEach(d => flatten(d, rows));
            return;
          }
        } catch (err) {
          verdict = { kind: 'retry', message: err.message || String(err) };
        }
        if (verdict.kind === 'fatal') throw new Error(verdict.message);
        console.warn(`[mfp-export] ${wFrom}..${wTo} attempt ${attempt + 1} failed: ${verdict.message}`);
        await sleep(1500 * (attempt + 1));
      }
      if (state.cancel) return;
      const a = new Date(wFrom + 'T00:00:00Z'), b = new Date(wTo + 'T00:00:00Z');
      if (b > a && depth < 4) {
        const mid = addDays(a, Math.floor((b - a) / 86400000 / 2));
        await fetchWin(wFrom, fmt(mid), depth + 1);
        await fetchWin(fmt(addDays(mid, 1)), wTo, depth + 1);
      } else {
        state.errors.push(`${wFrom}..${wTo}`);
      }
    };

    for (const [wFrom, wTo] of windows) {
      if (state.cancel) break;
      state.message = `Fetching ${wFrom} → ${wTo}`;
      await fetchWin(wFrom, wTo);
      state.done++;
      await sleep(pauseMs);
    }

    if (state.cancel) { state.status = 'cancelled'; state.message = 'Cancelled.'; return; }

    // Windows were fetched in order, so rows are already chronological. Hand off for download.
    const csv = '\uFEFF' + COLS.join(',') + '\n' + rows.join('\n') + '\n';
    const filename = `mfp_food_diary_${from}_to_${to}.csv`;
    const res = await chrome.runtime.sendMessage({ type: 'download', filename, csv });
    if (res && res.error) throw new Error(res.error);

    state.status = 'done';
    state.message = `Saved ${filename} — ${state.entries.toLocaleString()} food entries across ${state.days.toLocaleString()} logged days` +
                    (state.errors.length ? ` (${state.errors.length} window(s) failed)` : '') + '.';
  }

  // ---------- messaging ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'ping':
        sendResponse({ ok: true, ...detectAccount(), state });
        return false;
      case 'status':
        sendResponse({ state });
        return false;
      case 'cancel':
        state.cancel = true;
        sendResponse({ ok: true });
        return false;
      case 'start':
        if (state.status === 'running') { sendResponse({ error: 'An export is already running.' }); return false; }
        runExport(msg.options).catch(err => {
          state.status = 'failed';
          state.message = err.message || String(err);
        });
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
})();
