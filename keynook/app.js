'use strict';

/* ---------------- constants ---------------- */

const CATEGORIES = [
  { id: 'email_social', label: '이메일 · 소셜' },
  { id: 'subscription', label: '구독 · 쇼핑 · 게임' },
  { id: 'work', label: '업무 · 개발' },
  { id: 'finance_gov', label: '금융 · 정부' },
  { id: 'etc', label: '기타' },
];
const TIERS = [
  { id: 'normal', label: '일반' },
  { id: 'important', label: '중요' },
  { id: 'sensitive', label: '민감' },
];
const TRASH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DORMANT_THRESHOLD_MS = 180 * 24 * 60 * 60 * 1000;
const LS_SALT = 'keynook.salt';
const LS_VAULT = 'keynook.vault';
const LS_LAST_EXPORT = 'keynook.lastExportAt';

/* ---------------- helpers ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const catLabel = (id) => (CATEGORIES.find((c) => c.id === id) || {}).label || id;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

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
function fmtRelative(ts) {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return '오늘';
  if (diff < 2 * day) return '어제';
  if (diff < 30 * day) return Math.floor(diff / day) + '일 전';
  if (diff < 365 * day) return Math.floor(diff / (30 * day)) + '개월 전';
  return Math.floor(diff / (365 * day)) + '년 전';
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- crypto ---------------- */

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
async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: bufToB64(iv), ct: bufToB64(ct) };
}
async function decryptJSON(key, ivB64, ctB64) {
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBuf(ivB64) }, key, b64ToBuf(ctB64));
  return JSON.parse(new TextDecoder().decode(data));
}
async function sha1Hex(text) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-1', enc.encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* ---------------- state ---------------- */

const state = {
  key: null,
  vault: null, // { accounts: [...] }
  filter: 'all', // 'all' | category id | 'trash'
  search: '',
};

/* ---------------- persistence ---------------- */

async function persistVault() {
  const payload = await encryptJSON(state.key, state.vault);
  localStorage.setItem(LS_VAULT, JSON.stringify(payload));
}

function purgeExpiredTrash() {
  const now = Date.now();
  const before = state.vault.accounts.length;
  state.vault.accounts = state.vault.accounts.filter((a) => !(a.deletedAt && now - a.deletedAt > TRASH_RETENTION_MS));
  return state.vault.accounts.length !== before;
}

/* ---------------- auth ---------------- */

function hasExistingVault() {
  return !!localStorage.getItem(LS_SALT) && !!localStorage.getItem(LS_VAULT);
}

function renderAuthScreen() {
  const creating = !hasExistingVault();
  $('#auth-title').textContent = creating ? '마스터 비밀번호 설정' : '다시 오셨네요';
  $('#auth-sub').textContent = creating
    ? '이 비밀번호로 모든 계정 정보가 이 기기에서 암호화됩니다. 잊으면 복구할 수 없어요.'
    : '마스터 비밀번호로 잠금을 해제하세요.';
  $('#auth-confirm-field').classList.toggle('hidden', !creating);
  $('#auth-submit').textContent = creating ? '금고 만들기' : '잠금 해제';
  $('#auth-import-row').classList.toggle('hidden', !creating);
  $('#auth-error').textContent = '';
  $('#auth-password').value = '';
  $('#auth-confirm').value = '';
  $('#view-auth').classList.remove('hidden');
  $('#view-app').classList.add('hidden');
  setTimeout(() => $('#auth-password').focus(), 30);
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const password = $('#auth-password').value;
  const errorEl = $('#auth-error');
  errorEl.textContent = '';
  if (!password) { errorEl.textContent = '비밀번호를 입력하세요.'; return; }

  if (!hasExistingVault()) {
    const confirm = $('#auth-confirm').value;
    if (password.length < 6) { errorEl.textContent = '비밀번호는 6자 이상이어야 합니다.'; return; }
    if (password !== confirm) { errorEl.textContent = '비밀번호가 서로 다릅니다.'; return; }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltB64 = bufToB64(salt);
    localStorage.setItem(LS_SALT, saltB64);
    state.key = await deriveKey(password, saltB64);
    state.vault = { accounts: [] };
    await persistVault();
    toast('금고가 만들어졌습니다');
    enterApp();
    return;
  }

  try {
    const saltB64 = localStorage.getItem(LS_SALT);
    const key = await deriveKey(password, saltB64);
    const raw = JSON.parse(localStorage.getItem(LS_VAULT));
    const vault = await decryptJSON(key, raw.iv, raw.ct);
    state.key = key;
    state.vault = vault;
    if (purgeExpiredTrash()) await persistVault();
    enterApp();
  } catch (err) {
    errorEl.textContent = '비밀번호가 올바르지 않습니다.';
  }
}

function lockVault() {
  state.key = null;
  state.vault = null;
  renderAuthScreen();
}

function enterApp() {
  $('#view-auth').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  state.filter = 'all';
  state.search = '';
  renderApp();
}

/* ---------------- rendering: shell ---------------- */

function renderApp() {
  renderSidebar();
  renderContent();
}

function accountsVisible() {
  return state.vault.accounts.filter((a) => !a.deletedAt);
}

function renderSidebar() {
  const visible = accountsVisible();
  const counts = { all: visible.length };
  CATEGORIES.forEach((c) => { counts[c.id] = visible.filter((a) => a.category === c.id).length; });
  counts.trash = state.vault.accounts.filter((a) => a.deletedAt).length;

  const nav = $('#nav-list');
  nav.innerHTML = '';
  const items = [{ id: 'all', label: '전체 계정' }, ...CATEGORIES, { id: 'trash', label: '휴지통' }, { id: 'backup', label: '백업 · 내보내기' }];
  items.forEach((it) => {
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (state.filter === it.id ? ' active' : '');
    btn.innerHTML = `<span>${escapeHtml(it.label)}</span><span class="count mono">${counts[it.id] || 0}</span>`;
    btn.addEventListener('click', () => { state.filter = it.id; renderApp(); });
    nav.appendChild(btn);
  });

  const lastExport = localStorage.getItem(LS_LAST_EXPORT);
  $('#sidebar-backup-value').textContent = lastExport ? fmtRelative(Number(lastExport)) : '내보낸 적 없음';
}

function renderContent() {
  const area = $('#content-area');
  if (state.filter === 'trash') { area.innerHTML = ''; area.appendChild(buildTrashView()); return; }
  if (state.filter === 'backup') { renderBackupPanel(); return; }
  area.innerHTML = '';
  area.appendChild(buildStatGrid());
  area.appendChild(buildListView());
}

/* ---------------- dashboard views ---------------- */

function buildStatGrid() {
  const visible = accountsVisible();
  const now = Date.now();
  const dormant = visible.filter((a) => now - (a.lastCheckedAt || a.createdAt) > DORMANT_THRESHOLD_MS).length;
  const leaked = visible.filter((a) => a.leakStatus === 'breached').length;
  const lastExport = localStorage.getItem(LS_LAST_EXPORT);

  const wrap = document.createElement('div');
  wrap.className = 'stat-grid';
  wrap.innerHTML = `
    <div class="stat-card"><span class="k">등록된 계정</span><span class="v mono">${visible.length}</span></div>
    <div class="stat-card"><span class="k">마지막 백업</span><span class="v ${lastExport ? 'safe' : 'warn'}">${lastExport ? fmtRelative(Number(lastExport)) : '없음'}</span></div>
    <div class="stat-card"><span class="k">휴면 계정</span><span class="v ${dormant ? 'warn' : 'safe'}">${dormant}개 ${dormant ? '· 확인 필요' : ''}</span></div>
    <div class="stat-card"><span class="k">유출 경고</span><span class="v ${leaked ? 'danger' : 'safe'}">${leaked}건</span></div>
  `;
  return wrap;
}

function buildListView() {
  const visible = accountsVisible().filter((a) => {
    if (state.filter !== 'all' && a.category !== state.filter) return false;
    if (state.search && !a.service.toLowerCase().includes(state.search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => b.createdAt - a.createdAt);

  const card = document.createElement('div');
  card.className = 'list-card';
  const head = document.createElement('div');
  head.className = 'row head';
  head.innerHTML = `<span>서비스</span><span>카테고리</span><span>계정 ID</span><span>상태</span><span>최근 확인</span><span></span>`;
  card.appendChild(head);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = '등록된 계정이 없습니다. "계정 등록" 버튼으로 추가해보세요.';
    card.appendChild(empty);
    return card;
  }

  visible.forEach((a) => card.appendChild(buildRow(a)));
  return card;
}

function statusBadge(a) {
  const now = Date.now();
  if (a.leakStatus === 'breached') return `<span class="badge danger">유출 확인됨</span>`;
  const dormant = now - (a.lastCheckedAt || a.createdAt) > DORMANT_THRESHOLD_MS;
  if (dormant) return `<span class="badge warn">휴면</span>`;
  if (a.storageMode === 'location') return `<span class="badge muted">제한저장</span>`;
  return `<span class="badge safe">안전</span>`;
}

function buildRow(a) {
  const row = document.createElement('div');
  row.className = 'row';
  const idText = a.storageMode === 'location' ? '위치만 기록됨' : (a.username || '-');
  row.innerHTML = `
    <div class="row-service">
      <span class="row-dot" style="background:${a.category === 'finance_gov' ? 'var(--honey-deep)' : 'var(--honey)'}"></span>
      <span class="row-name" title="${escapeHtml(a.service)}">${escapeHtml(a.service)}</span>
    </div>
    <span class="row-sub">${escapeHtml(catLabel(a.category))}</span>
    <span class="row-sub mono" title="${escapeHtml(idText)}">${escapeHtml(idText)}</span>
    <span>${statusBadge(a)}</span>
    <span class="row-sub">${fmtRelative(a.lastCheckedAt || a.createdAt)}</span>
    <span class="row-actions"></span>
  `;
  const actions = row.querySelector('.row-actions');

  const launchBtn = document.createElement('button');
  launchBtn.className = 'icon-btn launch';
  launchBtn.title = a.url ? '바로 열기' : 'URL 미등록';
  launchBtn.innerHTML = svgExternal();
  launchBtn.addEventListener('click', () => launchAccount(a.id));
  actions.appendChild(launchBtn);

  if (a.storageMode !== 'location' && a.password) {
    const leakBtn = document.createElement('button');
    leakBtn.className = 'icon-btn';
    leakBtn.title = '유출 확인';
    leakBtn.innerHTML = svgShield();
    leakBtn.addEventListener('click', () => checkLeak(a.id));
    actions.appendChild(leakBtn);
  }

  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  editBtn.title = '수정';
  editBtn.innerHTML = svgEdit();
  editBtn.addEventListener('click', () => openAccountModal(a));
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn';
  delBtn.title = '삭제';
  delBtn.innerHTML = svgTrash();
  delBtn.addEventListener('click', () => softDeleteAccount(a.id));
  actions.appendChild(delBtn);

  return row;
}

function buildTrashView() {
  const wrap = document.createElement('div');
  const items = state.vault.accounts.filter((a) => a.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);

  const card = document.createElement('div');
  card.className = 'list-card';
  const head = document.createElement('div');
  head.className = 'row head';
  head.style.gridTemplateColumns = '2fr 1.4fr 1.4fr auto';
  head.innerHTML = `<span>서비스</span><span>삭제일</span><span>영구삭제까지</span><span></span>`;
  card.appendChild(head);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = '휴지통이 비어있습니다.';
    card.appendChild(empty);
  } else {
    items.forEach((a) => {
      const remain = Math.max(0, Math.ceil((TRASH_RETENTION_MS - (Date.now() - a.deletedAt)) / (24 * 60 * 60 * 1000)));
      const row = document.createElement('div');
      row.className = 'row';
      row.style.gridTemplateColumns = '2fr 1.4fr 1.4fr auto';
      row.innerHTML = `
        <div class="row-service"><span class="row-name">${escapeHtml(a.service)}</span></div>
        <span class="row-sub">${fmtRelative(a.deletedAt)}</span>
        <span class="row-sub">${remain}일 후</span>
        <span class="row-actions"></span>
      `;
      const actions = row.querySelector('.row-actions');
      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn-icon';
      restoreBtn.style.padding = '6px 12px';
      restoreBtn.style.fontSize = '12px';
      restoreBtn.textContent = '복구';
      restoreBtn.addEventListener('click', () => restoreAccount(a.id));
      actions.appendChild(restoreBtn);
      card.appendChild(row);
    });
  }

  const note = document.createElement('p');
  note.style.cssText = 'font-size:12px;color:var(--ink-faint);margin:2px 4px;';
  note.textContent = '삭제된 항목은 90일간 보관 후 자동으로 영구 삭제됩니다.';
  wrap.appendChild(note);
  wrap.appendChild(card);
  return wrap;
}

/* ---------------- account actions ---------------- */

function softDeleteAccount(id) {
  const a = state.vault.accounts.find((x) => x.id === id);
  if (!a) return;
  a.deletedAt = Date.now();
  persistVault().then(() => { toast('휴지통으로 이동했습니다'); renderApp(); });
}
function restoreAccount(id) {
  const a = state.vault.accounts.find((x) => x.id === id);
  if (!a) return;
  a.deletedAt = null;
  persistVault().then(() => { toast('복구했습니다'); renderApp(); });
}
function markChecked(id) {
  const a = state.vault.accounts.find((x) => x.id === id);
  if (!a) return;
  a.lastCheckedAt = Date.now();
  persistVault().then(() => renderApp());
}
function launchAccount(id) {
  const a = state.vault.accounts.find((x) => x.id === id);
  if (!a) return;
  if (a.url) {
    window.open(/^https?:\/\//i.test(a.url) ? a.url : 'https://' + a.url, '_blank', 'noopener');
  } else {
    toast('등록된 바로가기 URL이 없습니다');
  }
  markChecked(id);
}
async function checkLeak(id) {
  const a = state.vault.accounts.find((x) => x.id === id);
  if (!a || !a.password) return;
  toast('유출 여부 확인 중...');
  try {
    const hash = await sha1Hex(a.password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const res = await fetch('https://api.pwnedpasswords.com/range/' + prefix);
    if (!res.ok) throw new Error('network');
    const text = await res.text();
    const hit = text.split('\n').find((line) => line.split(':')[0].trim() === suffix);
    a.leakStatus = hit ? 'breached' : 'safe';
    a.leakCheckedAt = Date.now();
    await persistVault();
    toast(hit ? '유출된 비밀번호가 확인됐습니다' : '유출 기록이 없습니다');
    renderApp();
  } catch (err) {
    toast('유출 확인 중 오류가 발생했습니다 (네트워크 필요)');
  }
}

/* ---------------- account form modal ---------------- */

let editingId = null;

function openAccountModal(existing) {
  editingId = existing ? existing.id : null;
  $('#modal-title').textContent = existing ? '계정 수정' : '새 계정 등록';
  $('#f-service').value = existing ? existing.service : '';
  $('#f-username').value = existing ? existing.username || '' : '';
  $('#f-password').value = existing ? existing.password || '' : '';
  $('#f-url').value = existing ? existing.url || '' : '';
  $('#f-codes').value = existing ? existing.backupCodes || '' : '';
  $('#f-memo').value = existing ? existing.memo || '' : '';
  setSelectedPill('category', existing ? existing.category : 'email_social');
  setSelectedPill('tier', existing ? existing.tier : 'normal');
  updateFinanceFieldsVisibility();
  $('#modal-backdrop').classList.remove('hidden');
  setTimeout(() => $('#f-service').focus(), 30);
}
function closeAccountModal() {
  $('#modal-backdrop').classList.add('hidden');
  editingId = null;
}
function setSelectedPill(group, value) {
  $all(`.pill[data-group="${group}"]`).forEach((p) => p.classList.toggle('selected', p.dataset.value === value));
}
function getSelectedPill(group) {
  const el = $(`.pill.selected[data-group="${group}"]`);
  return el ? el.dataset.value : null;
}
function updateFinanceFieldsVisibility() {
  const isFinance = getSelectedPill('category') === 'finance_gov';
  $('#finance-note').classList.toggle('hidden', !isFinance);
  $('#password-field').classList.toggle('hidden', isFinance);
  $('#codes-field').classList.toggle('hidden', isFinance);
}

async function handleAccountFormSubmit(e) {
  e.preventDefault();
  const service = $('#f-service').value.trim();
  if (!service) { toast('서비스명을 입력하세요'); return; }
  const category = getSelectedPill('category') || 'etc';
  const tier = getSelectedPill('tier') || 'normal';
  const isFinance = category === 'finance_gov';

  if (editingId) {
    const a = state.vault.accounts.find((x) => x.id === editingId);
    a.service = service;
    a.category = category;
    a.tier = tier;
    a.storageMode = isFinance ? 'location' : 'full';
    a.username = $('#f-username').value.trim();
    a.password = isFinance ? null : $('#f-password').value;
    a.url = $('#f-url').value.trim();
    a.backupCodes = isFinance ? '' : $('#f-codes').value;
    a.memo = $('#f-memo').value.trim();
    a.leakStatus = null;
  } else {
    state.vault.accounts.push({
      id: uid(),
      service, category, tier,
      storageMode: isFinance ? 'location' : 'full',
      username: $('#f-username').value.trim(),
      password: isFinance ? null : $('#f-password').value,
      url: $('#f-url').value.trim(),
      backupCodes: isFinance ? '' : $('#f-codes').value,
      memo: $('#f-memo').value.trim(),
      createdAt: Date.now(),
      lastCheckedAt: Date.now(),
      deletedAt: null,
      leakStatus: null,
    });
  }
  await persistVault();
  closeAccountModal();
  toast('저장했습니다');
  renderApp();
}

/* ---------------- backup panel ---------------- */

function renderBackupPanel() {
  const area = $('#content-area');
  area.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:20px;max-width:900px;';

  wrap.innerHTML = `
    <div class="principle-box">
      <div>
        <div class="label">핵심 원칙</div>
        <div class="text">서버가 유일한 진실의 원천이 되지 않게 하라</div>
      </div>
    </div>
    <div class="action-grid">
      <div class="action-card">
        <div class="left">
          <div class="ico">${svgDownload()}</div>
          <div><div class="title">암호화 JSON 내보내기</div><div class="desc">이 기기의 마스터 비밀번호로만 열리는 백업 파일</div></div>
        </div>
        <button class="btn-icon accent" id="btn-export">내보내기</button>
      </div>
      <div class="action-card">
        <div class="left">
          <div class="ico">${svgUpload()}</div>
          <div><div class="title">백업 파일 가져오기</div><div class="desc">내보낸 JSON 파일로 이 기기의 금고를 교체합니다</div></div>
        </div>
        <label class="btn-icon" style="margin:0;">가져오기<input type="file" id="input-import" accept="application/json" class="hidden"></label>
      </div>
    </div>
    <p style="font-size:12px;color:var(--ink-faint);">가져오기는 현재 기기의 금고를 백업 파일로 완전히 교체합니다. 되돌릴 수 없으니 필요하면 먼저 현재 금고를 내보내두세요.</p>
  `;
  area.appendChild(wrap);

  $('#btn-export').addEventListener('click', exportVault);
  $('#input-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importVaultFile(e.target.files[0]);
  });
}

async function exportVault() {
  const salt = localStorage.getItem(LS_SALT);
  const raw = localStorage.getItem(LS_VAULT);
  if (!salt || !raw) return;
  const payload = { app: 'keynook', version: 1, salt, ...JSON.parse(raw) };
  const jsonStr = JSON.stringify(payload, null, 2);
  const filename = `keynook-backup-${new Date().toISOString().slice(0, 10)}.json`;

  // In a sandboxed preview (e.g. a published Artifact) plain downloads are blocked;
  // use the host's downloads capability when present, otherwise fall back to a
  // normal browser download (the path used on the real deployed site).
  const claudeApi = typeof claude !== 'undefined' ? claude : (typeof window !== 'undefined' ? window.claude : null);
  if (claudeApi && claudeApi.use) {
    try {
      const downloads = await claudeApi.use('downloads');
      if (downloads) {
        await downloads.save({ filename, data: jsonStr });
        localStorage.setItem(LS_LAST_EXPORT, String(Date.now()));
        toast('백업 파일을 내보냈습니다');
        renderSidebar();
        return;
      }
    } catch (err) {
      if (err && err.code === 'declined') { toast('내보내기를 취소했습니다'); return; }
      // fall through to classic download for any other error
    }
  }

  const blob = new Blob([jsonStr], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  localStorage.setItem(LS_LAST_EXPORT, String(Date.now()));
  toast('백업 파일을 내보냈습니다');
  renderSidebar();
}

function importVaultFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data.salt || !data.iv || !data.ct) throw new Error('invalid');
      localStorage.setItem(LS_SALT, data.salt);
      localStorage.setItem(LS_VAULT, JSON.stringify({ iv: data.iv, ct: data.ct }));
      toast('가져왔습니다. 다시 잠금 해제해주세요.');
      lockVault();
    } catch (err) {
      toast('올바른 백업 파일이 아닙니다');
    }
  };
  reader.readAsText(file);
}

/* ---------------- icons ---------------- */

function svgExternal() { return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path></svg>`; }
function svgShield() { return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 6v6c0 5 3.4 8.7 8 10 4.6-1.3 8-5 8-10V6l-8-4Z"></path></svg>`; }
function svgEdit() { return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`; }
function svgTrash() { return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>`; }
function svgDownload() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path></svg>`; }
function svgUpload() { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"></path><path d="m7 14 5-5 5 5"></path><path d="M5 3h14"></path></svg>`; }
function svgLock() { return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>`; }

/* ---------------- init ---------------- */

function initCategoryPills() {
  const catRow = $('#category-pills');
  catRow.innerHTML = CATEGORIES.map((c) => `<span class="pill" data-group="category" data-value="${c.id}">${escapeHtml(c.label)}</span>`).join('');
  const tierRow = $('#tier-pills');
  tierRow.innerHTML = TIERS.map((t) => `<span class="pill" data-group="tier" data-value="${t.id}">${escapeHtml(t.label)}</span>`).join('');
  $all('.pill').forEach((p) => {
    p.addEventListener('click', () => {
      setSelectedPill(p.dataset.group, p.dataset.value);
      if (p.dataset.group === 'category') updateFinanceFieldsVisibility();
    });
  });
}

function wireEvents() {
  $('#auth-form').addEventListener('submit', handleAuthSubmit);
  $('#btn-lock').addEventListener('click', lockVault);
  $('#btn-add-account').addEventListener('click', () => openAccountModal(null));
  $('#btn-backup-nav').addEventListener('click', () => { state.filter = 'backup'; renderApp(); });
  $('#search-input').addEventListener('input', (e) => { state.search = e.target.value; renderContent(); });
  $('#account-form').addEventListener('submit', handleAccountFormSubmit);
  $('#modal-close').addEventListener('click', closeAccountModal);
  $('#modal-cancel').addEventListener('click', closeAccountModal);
  $('#modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeAccountModal(); });
  $('#auth-import-input').addEventListener('change', (e) => {
    if (e.target.files[0]) importVaultFile(e.target.files[0]);
  });
}

function boot() {
  initCategoryPills();
  wireEvents();
  renderAuthScreen();
}

document.addEventListener('DOMContentLoaded', boot);
