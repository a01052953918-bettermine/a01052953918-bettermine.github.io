'use strict';

const LS_SALT = 'keynook.salt';
const LS_VAULT = 'keynook.vault';

const $ = (sel) => document.querySelector(sel);

/* ---------------- crypto (same scheme as the keynook web app) ---------------- */

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
async function deriveKey(password, saltB64) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBuf(saltB64), iterations: 200000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function decryptJSON(key, ivB64, ctB64) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(ivB64) }, key, b64ToBuf(ctB64));
  return JSON.parse(new TextDecoder().decode(data));
}

/* ---------------- chrome.storage helpers ---------------- */

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

/* ---------------- state ---------------- */

const state = { key: null, vault: null, tabId: null, hostname: '' };

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2000);
}

function hostnameOf(urlLike) {
  try {
    const u = new URL(/^https?:\/\//i.test(urlLike) ? urlLike : 'https://' + urlLike);
    return u.hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

/* ---------------- boot ---------------- */

async function boot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  state.hostname = tab && tab.url ? hostnameOf(tab.url) : '';

  const stored = await storageGet([LS_SALT, LS_VAULT]);
  const hasVault = !!stored[LS_SALT] && !!stored[LS_VAULT];

  if (!hasVault) {
    $('#auth-empty').classList.remove('hidden');
  } else {
    $('#auth-form').classList.remove('hidden');
    setTimeout(() => $('#auth-password').focus(), 30);
  }
}

$('#import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const data = JSON.parse(text);
    if (!data.salt || !data.iv || !data.ct) throw new Error('invalid');
    await storageSet({ [LS_SALT]: data.salt, [LS_VAULT]: { iv: data.iv, ct: data.ct } });
    $('#auth-empty').classList.add('hidden');
    $('#auth-form').classList.remove('hidden');
    toast('가져왔습니다. 잠금을 해제하세요.');
    setTimeout(() => $('#auth-password').focus(), 30);
  } catch (err) {
    toast('올바른 백업 파일이 아닙니다');
  }
});

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#auth-password').value;
  const errorEl = $('#auth-error');
  errorEl.textContent = '';
  try {
    const stored = await storageGet([LS_SALT, LS_VAULT]);
    const key = await deriveKey(password, stored[LS_SALT]);
    const vault = await decryptJSON(key, stored[LS_VAULT].iv, stored[LS_VAULT].ct);
    state.key = key;
    state.vault = vault;
    enterList();
  } catch (err) {
    errorEl.textContent = '비밀번호가 올바르지 않습니다.';
  }
});

$('#btn-lock').addEventListener('click', () => {
  state.key = null;
  state.vault = null;
  $('#view-list').classList.add('hidden');
  $('#auth-form').classList.remove('hidden');
  $('#auth-password').value = '';
  setTimeout(() => $('#auth-password').focus(), 30);
});

$('#btn-show-all').addEventListener('click', () => {
  const el = $('#all-list');
  el.classList.toggle('hidden');
  $('#btn-show-all').textContent = el.classList.contains('hidden') ? '전체 계정 보기' : '전체 계정 숨기기';
});

function enterList() {
  $('#view-auth').classList.add('hidden');
  $('#view-list').classList.remove('hidden');
  $('#site-label').textContent = state.hostname || '(알 수 없는 사이트)';

  const accounts = state.vault.accounts.filter((a) => !a.deletedAt && a.storageMode !== 'location' && a.password);
  const matches = state.hostname ? accounts.filter((a) => a.url && hostnameOf(a.url) === state.hostname) : [];
  const rest = accounts.filter((a) => !matches.includes(a));

  renderRows($('#match-list'), matches, matches.length ? null : '이 사이트에 등록된 계정이 없습니다');
  renderRows($('#all-list'), rest, rest.length ? null : '다른 계정이 없습니다');
}

function renderRows(container, list, emptyMsg) {
  container.innerHTML = '';
  if (!list.length) {
    if (emptyMsg) {
      const p = document.createElement('div');
      p.className = 'empty-note';
      p.textContent = emptyMsg;
      container.appendChild(p);
    }
    return;
  }
  list.forEach((a) => {
    const row = document.createElement('div');
    row.className = 'acct-row';
    row.innerHTML = `
      <span class="acct-dot"></span>
      <div class="acct-info">
        <span class="service">${escapeHtml(a.service)}</span>
        <span class="user">${escapeHtml(a.username || '')}</span>
      </div>
      <button class="btn-fill">채우기</button>
    `;
    row.querySelector('.btn-fill').addEventListener('click', () => fillAccount(a));
    container.appendChild(row);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function fillAccount(account) {
  if (!state.tabId) { toast('현재 탭을 찾을 수 없습니다'); return; }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: fillCredentialsInPage,
      args: [{ username: account.username || '', password: account.password || '' }],
    });
    if (result && result.ok) {
      toast(result.filledUsername ? '아이디·비밀번호를 채웠습니다' : '비밀번호 필드를 채웠습니다');
    } else {
      toast('이 페이지에서 비밀번호 입력란을 찾지 못했습니다');
    }
  } catch (err) {
    toast('채우지 못했습니다 (이 페이지에서는 실행할 수 없어요)');
  }
}

// Injected into the page — runs in the page's context, not the extension's.
function fillCredentialsInPage({ username, password }) {
  function visible(el) {
    const r = el.getBoundingClientRect();
    return el.offsetParent !== null && r.width > 0 && r.height > 0;
  }
  const pwInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
  if (!pwInputs.length) return { ok: false, reason: 'no-password-field' };
  const pwInput = pwInputs[0];
  const scope = pwInput.closest('form') || document;
  const candidates = Array.from(scope.querySelectorAll('input')).filter(visible);
  const pwIndex = candidates.indexOf(pwInput);
  let userInput = null;
  for (let i = pwIndex - 1; i >= 0; i--) {
    const t = (candidates[i].type || 'text').toLowerCase();
    const ac = (candidates[i].autocomplete || '').toLowerCase();
    if (['text', 'email', 'tel'].includes(t) || ac.includes('username') || ac.includes('email')) {
      userInput = candidates[i];
      break;
    }
  }
  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (userInput && username) setValue(userInput, username);
  if (password) setValue(pwInput, password);
  pwInput.focus();
  return { ok: true, filledUsername: !!userInput };
}

boot();
