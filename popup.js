/**
 * popup.js — the small UI. Talks to content.js in the active MyFitnessPal tab.
 * The export itself runs in the tab, so closing this popup does not interrupt it;
 * reopening the popup picks up the live progress.
 */
const $ = id => document.getElementById(id);
const sections = ['wrongSite', 'form', 'progress', 'result'];
const show = name => sections.forEach(s => { $(s).hidden = s !== name; });
// Local calendar date, not toISOString() (which is UTC and is a day off for part of every day
// depending on the user's timezone — east of UTC it would stop users selecting today).
const today = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

let tabId = null;
let pollTimer = null;

async function getMfpTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/www\.myfitnesspal\.com\//.test(tab.url || '')) return null;
  return tab;
}

async function send(msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch (_) { return null; }
}

async function ensureContentScript() {
  let res = await send({ type: 'ping' });
  if (res && res.ok) return res;
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  res = await send({ type: 'ping' });
  if (!(res && res.ok)) throw new Error('Could not connect to the MyFitnessPal page. Reload it and try again.');
  return res;
}

function renderState(state) {
  if (state.status === 'running') {
    show('progress');
    const pct = state.total ? Math.round((state.done / state.total) * 100) : 0;
    $('fill').style.width = pct + '%';
    $('counts').textContent = `${state.done} / ${state.total} windows · ${state.days.toLocaleString()} days · ${state.entries.toLocaleString()} entries`;
    $('message').textContent = state.message || '';
  } else if (state.status === 'done' || state.status === 'cancelled' || state.status === 'failed') {
    show('result');
    $('resultMessage').textContent = (state.status === 'failed' ? 'Export failed: ' : '') + (state.message || state.status);
    $('resultMessage').className = state.status === 'failed' ? 'error' : '';
  } else {
    show('form');
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const res = await send({ type: 'status' });
    if (!res) return;
    renderState(res.state);
    if (res.state.status !== 'running') stopPolling();
  }, 500);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

async function init() {
  const tab = await getMfpTab();
  if (!tab) { show('wrongSite'); return; }
  tabId = tab.id;

  let info;
  try { info = await ensureContentScript(); }
  catch (err) { show('wrongSite'); $('wrongSite').querySelector('p').textContent = err.message; return; }

  // Prefill the form from what the page knows about the account.
  const saved = JSON.parse(localStorage.getItem('mfpExporter') || '{}');
  $('username').value = saved.username || info.username || '';
  $('from').value = saved.from || info.createdAt || '2005-01-01';
  $('to').value = today();
  $('to').max = today();

  renderState(info.state);
  if (info.state.status === 'running') startPolling();
}

$('start').addEventListener('click', async () => {
  const options = {
    username: $('username').value.trim(),
    from: $('from').value,
    to: $('to').value,
    windowDays: Math.min(180, Math.max(7, Number($('windowDays').value) || 90)),
    pauseMs: Math.min(5000, Math.max(0, Number($('pauseMs').value) || 0))
  };
  const err = !options.username ? 'Enter your MyFitnessPal username.'
            : !options.from || !options.to ? 'Choose both dates.'
            : options.from > options.to ? '"From" must be on or before "To".'
            : null;
  $('formError').hidden = !err;
  $('formError').textContent = err || '';
  if (err) return;

  localStorage.setItem('mfpExporter', JSON.stringify({ username: options.username, from: options.from }));
  $('start').disabled = true;
  const res = await send({ type: 'start', options });
  $('start').disabled = false;
  if (!res || res.error) {
    $('formError').hidden = false;
    $('formError').textContent = (res && res.error) || 'Could not start the export. Reload the page and try again.';
    return;
  }
  renderState({ status: 'running', done: 0, total: 0, days: 0, entries: 0, message: 'Starting…' });
  startPolling();
});

$('cancel').addEventListener('click', async () => {
  $('cancel').disabled = true;
  await send({ type: 'cancel' });
  setTimeout(() => { $('cancel').disabled = false; }, 1000);
});

$('again').addEventListener('click', () => show('form'));

init();
