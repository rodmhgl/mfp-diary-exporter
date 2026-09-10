/**
 * background.js — service worker.
 * Its only job is to turn the finished CSV into a download, since the downloads API
 * is not available to content scripts. No data is stored or sent anywhere.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'download') return false;

  const url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(msg.csv);
  chrome.downloads.download({ url, filename: msg.filename, saveAs: false }, downloadId => {
    if (chrome.runtime.lastError) {
      sendResponse({ error: chrome.runtime.lastError.message });
    } else {
      sendResponse({ ok: true, downloadId });
    }
  });
  return true; // keep the message channel open for the async response
});
