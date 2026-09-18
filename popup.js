const DEFAULTS = { enabled: true, knight: 'auto', king: 'auto', noncon: 'auto', parity: 'auto', badge: true, warnWrong: true, quadHighlight: true };

function $(id) { return document.getElementById(id); }
function radio(name) { return document.querySelector(`input[name="${name}"]:checked`).value; }
function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}

function save() {
  chrome.storage.sync.set({
    enabled: $('enabled').checked,
    badge: $('badge').checked,
    warnWrong: $('warnWrong').checked,
    quadHighlight: $('quadHighlight').checked,
    knight: radio('knight'),
    king: radio('king'),
    noncon: radio('noncon'),
    parity: radio('parity'),
  }, refreshStatus);
}

function refreshStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !/^https?:\/\/([^/]*\.)?sudoku\.coach\//.test(tab.url || '')) {
      $('status').textContent = 'Not a sudoku.coach tab.';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'pencil-guard-status' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        $('status').textContent = 'Extension not loaded on this page yet. Reload the tab.';
        return;
      }
      const yn = (b) => (b ? 'yes' : 'no');
      $('status').textContent = res.gridFound
        ? `Grid: ${res.size}×${res.size}\n` +
          `Detected on page: knight ${yn(res.detected.knight)}, king ${yn(res.detected.king)}, noncon ${yn(res.detected.noncon)}, odd/even ${yn(res.detected.parity)}\n` +
          `Active: knight ${yn(res.active.knight)}, king ${yn(res.active.king)}, noncon ${yn(res.active.noncon)}, odd/even ${yn(res.active.parity)} (${res.parityCells} cells)\n` +
          `Candidates auto-removed: ${res.removed}\n` +
          `Solution: ${res.solution === 'page' ? 'from page' : res.solution === 'solver' ? 'solved locally' : 'not available (no error warnings)'}\n` +
          `Errors warned: ${res.errors}
` +
          `Quadruple clues on grid: ${res.quadruples}`
        : 'No puzzle grid found on this page.';
    });
  });
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  $('enabled').checked = !!s.enabled;
  $('badge').checked = !!s.badge;
  $('warnWrong').checked = !!s.warnWrong;
  $('quadHighlight').checked = !!s.quadHighlight;
  setRadio('knight', s.knight);
  setRadio('king', s.king);
  setRadio('noncon', s.noncon);
  setRadio('parity', s.parity);
  refreshStatus();
});

document.querySelectorAll('input').forEach((el) => el.addEventListener('change', save));
