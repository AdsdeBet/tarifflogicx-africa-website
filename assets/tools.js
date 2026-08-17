// assets/tools.js
//
// Backs tools.html — real Search, AI Classify, and Landed Cost, calling the
// proxy's /web/* routes (see proxy-server/src/index.js). Those routes are
// intentionally secret-free (a client-side secret on a static site isn't
// one) and protected instead by CORS + per-IP rate limits server-side.

const API_BASE = 'https://tarifflogicx-africa-proxy-production.up.railway.app';

// Free-tier AI Classify tracking mirrors the app's device-based limit
// (FreemiumService) closely enough for a public demo — a random id
// persisted locally, not tied to identity. The real enforcement is the
// server's per-IP webClassifyLimiter; this id only lets the server's
// existing per-device FREE_AI_CALLS_PER_DAY counter work as designed.
function getDeviceId() {
  let id = localStorage.getItem('tlxa_web_device_id');
  if (!id) {
    id = 'web-' + crypto.randomUUID();
    localStorage.setItem('tlxa_web_device_id', id);
  }
  return id;
}

// ── Access token (admin login OR a redeemed Subscriber/Pro pass code) ──
// The token itself is only meaningful because the server re-verifies its
// signature on every request (see proxy-server auth.js) — storing it in
// localStorage is fine precisely because a *copy* of it is useless to
// anyone without also being able to forge a valid signature, unlike a
// plain "unlocked: true" flag would be. A redeemed code and an admin
// login are stored identically; the server tells us which one it was.
function getAccessToken() {
  const raw = localStorage.getItem('tlxa_access_token');
  if (!raw) return null;
  try {
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) { localStorage.removeItem('tlxa_access_token'); return null; }
    return token;
  } catch { return null; }
}
function hasAccess() { return getAccessToken() !== null; }
function accessHeaders() {
  const token = getAccessToken();
  return token ? { 'X-Access-Token': token } : {};
}
function storeAccessToken(token, expiresInMs) {
  localStorage.setItem('tlxa_access_token', JSON.stringify({ token, expiresAt: Date.now() + expiresInMs }));
}

const accessModal = document.getElementById('access-modal');
const accessLoggedInView = document.getElementById('access-logged-in-view');
const accessRedeemView = document.getElementById('access-redeem-view');
const accessAdminView = document.getElementById('access-admin-view');
const redeemForm = document.getElementById('redeem-form');
const redeemError = document.getElementById('redeem-error');
const adminLoginForm = document.getElementById('admin-login-form');
const adminLoginError = document.getElementById('admin-login-error');

function refreshAccessModalView() {
  const unlocked = hasAccess();
  accessLoggedInView.style.display = unlocked ? 'block' : 'none';
  accessRedeemView.style.display = unlocked ? 'none' : 'block';
  accessAdminView.style.display = 'none';
}

function openAccessModal() {
  redeemError.style.display = 'none';
  adminLoginError.style.display = 'none';
  refreshAccessModalView();
  accessModal.style.display = 'flex';
}

document.getElementById('access-link').addEventListener('click', (e) => { e.preventDefault(); openAccessModal(); });
document.getElementById('access-cancel-btn').addEventListener('click', () => { accessModal.style.display = 'none'; });
document.getElementById('admin-cancel-btn').addEventListener('click', () => { accessModal.style.display = 'none'; });
accessModal.addEventListener('click', (e) => { if (e.target === accessModal) accessModal.style.display = 'none'; });

document.getElementById('show-admin-login-link').addEventListener('click', (e) => {
  e.preventDefault();
  accessRedeemView.style.display = 'none';
  accessAdminView.style.display = 'block';
});

document.getElementById('access-logout-btn').addEventListener('click', () => {
  localStorage.removeItem('tlxa_access_token');
  accessModal.style.display = 'none';
});

redeemForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('redeem-code-input').value.trim();
  redeemError.style.display = 'none';
  if (!code) {
    redeemError.textContent = 'Paste your access code first.';
    redeemError.style.display = 'block';
    return;
  }
  // The code IS the token (see webAdminLogin.js generate-code) — nothing to
  // look up server-side, just store it and let the next real request prove
  // whether it's valid (a garbage paste simply won't unlock anything).
  storeAccessToken(code, 14 * 24 * 60 * 60 * 1000); // upper bound; server's own expiry inside the token is what actually governs
  document.getElementById('redeem-code-input').value = '';
  accessModal.style.display = 'none';
  if (typeof onAccessChanged === 'function') onAccessChanged();
});

adminLoginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('admin-username').value.trim();
  const password = document.getElementById('admin-password').value;
  adminLoginError.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE}/web/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok || !data.granted) throw new Error(data.error || 'Login failed.');
    storeAccessToken(data.token, data.expiresInMs);
    document.getElementById('admin-password').value = '';
    accessModal.style.display = 'none';
    if (typeof onAccessChanged === 'function') onAccessChanged();
  } catch (err) {
    adminLoginError.textContent = err.message || 'Login failed — try again.';
    adminLoginError.style.display = 'block';
  }
});

// ── Tabs ──────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  window.scrollTo({ top: document.querySelector('.tab-bar').offsetTop - 1, behavior: 'smooth' });
}
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function fmtR(v) {
  return 'R ' + v.toFixed(2).replace(/\d(?=(\d{3})+\.)/g, '$&,');
}

function dutyDisplay(code) {
  const formula = (code.duty_formula || '').trim();
  if (!formula) return (!code.general_duty) ? 'Free' : `${code.general_duty.toFixed(0)}%`;
  if (formula.toLowerCase() === 'free') return 'Free';
  return formula;
}

// ══════════════════════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════════════════════
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let searchDebounce = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (q.length < 2) { searchResults.innerHTML = ''; return; }
  searchDebounce = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q) {
  searchResults.innerHTML = '<div class="loading-row"><span class="spinner"></span> Searching the real SARS schedule…</div>';
  try {
    const res = await fetch(`${API_BASE}/web/search?q=${encodeURIComponent(q)}&deviceId=${encodeURIComponent(getDeviceId())}`, { headers: accessHeaders() });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        searchResults.innerHTML = `<div class="error-box">${escapeHtml(data.error)} <a href="#" id="search-unlock-link">Unlock full access</a>.</div>`;
        document.getElementById('search-unlock-link')?.addEventListener('click', (e) => { e.preventDefault(); openAccessModal(); });
        return;
      }
      throw new Error(data.error || 'Search failed.');
    }
    renderSearchResults(data.results || []);
  } catch (err) {
    searchResults.innerHTML = `<div class="error-box">${escapeHtml(err.message || 'Something went wrong — try again.')}</div>`;
  }
}

function renderSearchResults(results) {
  if (results.length === 0) {
    searchResults.innerHTML = '<div class="hint" style="margin-top:16px;">No matches. Try a broader term, or use AI Classify to describe the product in plain language.</div>';
    return;
  }
  searchResults.innerHTML = results.slice(0, 20).map((c) => resultCardHtml(c)).join('');
  searchResults.querySelectorAll('.result-card').forEach((el, i) => {
    el.addEventListener('click', () => openCodeDetail(results[i].hs_code));
  });
}

function resultCardHtml(c) {
  const badges = [`<span class="badge badge-duty">Duty: ${escapeHtml(dutyDisplay(c))}</span>`];
  badges.push(`<span class="badge badge-vat">VAT: ${c.vat_applicable ? '15%' : 'Exempt'}</span>`);
  if (c.permit_required) badges.push(`<span class="badge badge-warn">Permit: ${escapeHtml(c.permit_authority || 'required')}</span>`);
  else badges.push('<span class="badge badge-ok">No permit</span>');
  return `<div class="result-card">
    <span class="result-code">${escapeHtml(c.hs_code)}</span>
    <div class="result-desc">${escapeHtml(c.description)}</div>
    <div class="badge-row">${badges.join('')}</div>
  </div>`;
}

async function openCodeDetail(hsCode) {
  searchResults.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading full detail…</div>';
  try {
    const code = await fetchCode(hsCode);
    renderCodeDetail(code, searchResults, { showBackToSearch: true });
  } catch (err) {
    searchResults.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
  }
}

async function fetchCode(hsCode) {
  const res = await fetch(`${API_BASE}/web/tariff-data/${encodeURIComponent(hsCode)}`, { headers: accessHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not load that code.');
  return data;
}

function renderCodeDetail(code, container, opts) {
  const prefs = [];
  if (code.eu_uk_duty) prefs.push(['EU / UK', code.eu_uk_duty]);
  if (code.efta_duty) prefs.push(['EFTA', code.efta_duty]);
  if (code.sadc_duty) prefs.push(['SADC', code.sadc_duty]);
  if (code.mercosur_duty) prefs.push(['MERCOSUR', code.mercosur_duty]);
  if (code.afcfta_duty) prefs.push(['AfCFTA', code.afcfta_duty]);

  container.innerHTML = `
    ${opts?.showBackToSearch ? '<button class="btn-secondary" id="back-to-search">&larr; Back to results</button>' : ''}
    <div class="result-card" style="cursor:default; margin-top:14px;">
      <span class="result-code">${escapeHtml(code.hs_code)}</span>
      <div class="result-desc">${escapeHtml(code.description)}</div>
      <div class="badge-row">
        <span class="badge badge-duty">General duty: ${escapeHtml(dutyDisplay(code))}</span>
        <span class="badge badge-vat">VAT: ${code.vat_applicable ? '15%' : 'Exempt'}</span>
        ${code.permit_required ? `<span class="badge badge-warn">Permit: ${escapeHtml(code.permit_authority || 'required')}</span>` : '<span class="badge badge-ok">No permit</span>'}
      </div>
      ${prefs.length ? `<div class="lc-section-label">Preferential trade agreement rates</div>
        <div class="badge-row">${prefs.map(([n, r]) => `<span class="badge badge-ok">${escapeHtml(n)}: ${escapeHtml(r)}</span>`).join('')}</div>` : ''}
      ${code.permit_note ? `<div class="hint" style="margin-top:10px;">${escapeHtml(code.permit_note)}</div>` : ''}
      <button class="btn-primary" id="use-for-landed-cost" style="margin-top:14px;">Calculate landed cost for this code</button>
    </div>
  `;
  document.getElementById('use-for-landed-cost')?.addEventListener('click', () => {
    setLandedCostCode(code);
    showTab('landed-cost');
  });
  document.getElementById('back-to-search')?.addEventListener('click', () => runSearch(searchInput.value.trim()));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ══════════════════════════════════════════════════════════════════════
// AI CLASSIFY
// ══════════════════════════════════════════════════════════════════════
const classifyInput = document.getElementById('classify-input');
const classifyBtn = document.getElementById('classify-btn');
const classifyResults = document.getElementById('classify-results');

classifyBtn.addEventListener('click', async () => {
  const description = classifyInput.value.trim();
  if (description.length < 3) {
    classifyResults.innerHTML = '<div class="error-box">Describe the product in a bit more detail (a few words is enough).</div>';
    return;
  }
  classifyBtn.disabled = true;
  classifyResults.innerHTML = '<div class="loading-row"><span class="spinner"></span> Asking Claude for likely HS codes…</div>';
  try {
    const res = await fetch(`${API_BASE}/web/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...accessHeaders() },
      body: JSON.stringify({ description, deviceId: getDeviceId() }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 429) {
        classifyResults.innerHTML = `<div class="error-box">${escapeHtml(data.error)} The app has its own separate free allowance — <a href="https://play.google.com/store/apps/details?id=za.co.tarifflogicxafrica.app" target="_blank" rel="noopener">get it on Google Play</a>.</div>`;
      } else {
        throw new Error(data.error || 'Classification failed.');
      }
      return;
    }
    renderClassifyResults(data.suggestions || [], data.disclaimer);
  } catch (err) {
    classifyResults.innerHTML = `<div class="error-box">${escapeHtml(err.message || 'Something went wrong — try again.')}</div>`;
  } finally {
    classifyBtn.disabled = false;
  }
});

function renderClassifyResults(suggestions, disclaimer) {
  if (suggestions.length === 0) {
    classifyResults.innerHTML = '<div class="hint" style="margin-top:14px;">No confident suggestions for that description — try adding more detail (material, purpose, form).</div>';
    return;
  }
  classifyResults.innerHTML = suggestions.map((s, i) => `
    <div class="suggestion-card">
      <div class="suggestion-top">
        <span class="result-code">${escapeHtml(s.hs_code)}</span>
        <span class="badge confidence-${s.confidence}">${escapeHtml(s.confidence)} confidence</span>
      </div>
      <div class="result-desc">${escapeHtml(s.description)}</div>
      <div class="suggestion-reasoning">${escapeHtml(s.reasoning)}</div>
      <span class="use-code-link" data-code="${escapeHtml(s.hs_code)}">Look up full duty &amp; VAT for this code &rarr;</span>
    </div>
  `).join('') + `<div class="hint" style="margin-top:14px;">${escapeHtml(disclaimer || '')}</div>`;

  classifyResults.querySelectorAll('.use-code-link').forEach((el) => {
    el.addEventListener('click', async () => {
      el.textContent = 'Loading…';
      try {
        const code = await fetchCode(el.dataset.code);
        showTab('search');
        renderCodeDetail(code, searchResults, { showBackToSearch: false });
      } catch (err) {
        el.textContent = 'Could not load — try Search instead.';
      }
    });
  });
}

// ══════════════════════════════════════════════════════════════════════
// LANDED COST — mirrors mobile/lib/screens/landed_cost_screen.dart exactly:
//   Customs Value (CIF) = Goods + Freight + Insurance
//   Customs Duty        = Customs Value × duty rate
//   Ad Valorem           = Customs Value × ad valorem rate (optional)
//   ATV                  = Customs Value + 10% uplift (skip if BLNS) + Duty + Ad Valorem
//   Import VAT           = ATV × 15% (if applicable)
//   Total                = Customs Value + Duty + Ad Valorem + VAT + Clearing fee
// Source: SARS "Duties and Taxes for Importers". ZAR only on the website —
// the app additionally supports live multi-currency conversion.
// ══════════════════════════════════════════════════════════════════════
let lcCode = null; // currently selected TariffCode-shaped object, or null

const lcHeader = document.getElementById('lc-code-header');
const lcNoCode = document.getElementById('lc-no-code');
const lcForm = document.getElementById('lc-form');
const lcResults = document.getElementById('lc-results');
const lcDutyRateInput = document.getElementById('lc-duty-rate');

function setLandedCostCode(code) {
  lcCode = code;
  lcHeader.innerHTML = `<span class="result-code">${escapeHtml(code.hs_code)}</span><p class="result-desc">${escapeHtml(code.description)}</p>`;
  lcHeader.style.display = 'flex';
  lcNoCode.style.display = 'none';
  lcDutyRateInput.value = (code.general_duty ?? 0);
  document.getElementById('lc-vat-applicable').value = code.vat_applicable ? '1' : '0';
  if (code.ad_valorem_duty) document.getElementById('lc-ad-valorem').value = code.ad_valorem_duty;
}

document.getElementById('lc-calc-btn').addEventListener('click', () => {
  const goodsValue = parseFloat(document.getElementById('lc-goods-value').value.replace(/,/g, '')) || 0;
  if (goodsValue <= 0) {
    lcResults.innerHTML = '<div class="error-box">Enter a valid goods value first.</div>';
    return;
  }
  const freight = parseFloat(document.getElementById('lc-freight').value) || 0;
  const insurance = parseFloat(document.getElementById('lc-insurance').value) || 0;
  const dutyRatePct = parseFloat(lcDutyRateInput.value) || 0;
  const adValoremPct = parseFloat(document.getElementById('lc-ad-valorem').value) || 0;
  const clearingFee = parseFloat(document.getElementById('lc-clearing').value) || 0;
  const isBlns = document.getElementById('lc-blns').checked;
  const vatApplicable = document.getElementById('lc-vat-applicable').value === '1';

  const customsValue = goodsValue + freight + insurance;
  const dutyAmount = customsValue * (dutyRatePct / 100);
  const adValoremAmount = customsValue * (adValoremPct / 100);
  const upliftAmount = isBlns ? 0 : customsValue * 0.10;
  const atv = customsValue + upliftAmount + dutyAmount + adValoremAmount;
  const vatAmount = vatApplicable ? atv * 0.15 : 0;
  const total = customsValue + dutyAmount + adValoremAmount + vatAmount + clearingFee;

  lcResults.innerHTML = `
    <div class="lc-section-label">Customs value</div>
    <div class="lc-results-table">
      <div class="lc-row"><span>Goods value (FOB)</span><span>${fmtR(goodsValue)}</span></div>
      ${freight > 0 ? `<div class="lc-row"><span>+ Freight</span><span>${fmtR(freight)}</span></div>` : ''}
      ${insurance > 0 ? `<div class="lc-row"><span>+ Insurance</span><span>${fmtR(insurance)}</span></div>` : ''}
      <div class="lc-row total"><span>Customs value (CIF)</span><span>${fmtR(customsValue)}</span></div>
    </div>
    <div class="lc-section-label">Duty, uplift &amp; VAT</div>
    <div class="lc-results-table">
      <div class="lc-row"><span>Customs duty (${dutyRatePct}%)</span><span class="lc-val-duty">${fmtR(dutyAmount)}</span></div>
      ${adValoremAmount > 0 ? `<div class="lc-row"><span>Ad valorem excise (${adValoremPct}%)</span><span class="lc-val-duty">${fmtR(adValoremAmount)}</span></div>` : ''}
      <div class="lc-row"><span>${isBlns ? '10% ATV uplift (N/A — BLNS origin)' : '10% ATV uplift'}</span><span>${fmtR(upliftAmount)}</span></div>
      <div class="lc-row"><span>Added Tax Value (ATV)</span><span>${fmtR(atv)}</span></div>
      <div class="lc-row"><span>Import VAT (${vatApplicable ? '15% of ATV' : 'exempt'})</span><span class="lc-val-vat">${fmtR(vatAmount)}</span></div>
    </div>
    <div class="lc-section-label">Total</div>
    <div class="lc-results-table">
      <div class="lc-row"><span>Customs value</span><span>${fmtR(customsValue)}</span></div>
      <div class="lc-row"><span>Duty + ad valorem</span><span>${fmtR(dutyAmount + adValoremAmount)}</span></div>
      <div class="lc-row"><span>Import VAT</span><span>${fmtR(vatAmount)}</span></div>
      ${clearingFee > 0 ? `<div class="lc-row"><span>Clearing &amp; forwarding fee</span><span>${fmtR(clearingFee)}</span></div>` : ''}
      <div class="lc-row total"><span>Total landed cost</span><span>${fmtR(total)}</span></div>
    </div>
    <div class="lc-disclaimer">
      Reference estimate only, per SARS' published ATV formula (Customs Value + 10% uplift + Duty, then VAT on that total) — not a bill. Not included: anti-dumping/countervailing duties, environmental levies, ITAC permit fees, port/terminal handling, demurrage. The actual amount SARS charges is only finalised once your clearing agent submits the EDI customs declaration — always confirm before paying or invoicing a client.
    </div>
  `;
});

// ══════════════════════════════════════════════════════════════════════
// IMPORTANT INFORMATION — topic index is always free to browse; opening a
// topic's actual content requires access (Subscriber/Pro/redeemed code),
// no free quota — matches ReferenceSectionGate in the app exactly.
// ══════════════════════════════════════════════════════════════════════
const infoIndexEl = document.getElementById('info-index');
let infoIndexLoaded = false;
let infoIndexData = null;
let currentInfoKey = null; // so onAccessChanged can retry the topic just unlocked

document.querySelector('.tab-btn[data-tab="info"]').addEventListener('click', () => {
  if (!infoIndexLoaded) loadInfoIndex();
});

async function loadInfoIndex() {
  infoIndexEl.innerHTML = '<div class="loading-row"><span class="spinner"></span> Loading topic list…</div>';
  try {
    const res = await fetch(`${API_BASE}/web/reference-index`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the topic list.');
    infoIndexData = data.sections;
    infoIndexLoaded = true;
    renderInfoIndex();
  } catch (err) {
    infoIndexEl.innerHTML = `<div class="error-box">${escapeHtml(err.message || 'Something went wrong — try again.')}</div>`;
  }
}

function renderInfoIndex() {
  infoIndexEl.innerHTML = infoIndexData.map((section) => `
    <div class="lc-section-label" style="margin-top:20px;">${escapeHtml(section.header)}</div>
    ${section.items.map((item) => `
      <div class="result-card" data-key="${escapeHtml(item.key)}" data-type="${item.type}" ${item.type === 'external' ? `data-url="${escapeHtml(item.url)}"` : ''}>
        <div class="result-desc" style="font-weight:600; color:var(--text); margin-bottom:2px;">${escapeHtml(item.title)}</div>
        <div class="hint" style="margin:0;">${escapeHtml(item.subtitle)}</div>
        <div class="badge-row" style="margin-top:8px;">
          ${item.type === 'external' ? '<span class="badge badge-ok">Official link ↗</span>' : ''}
          ${item.type === 'free' ? '<span class="badge badge-ok">Free</span>' : ''}
          ${item.type === 'gated' ? '<span class="badge badge-warn">Subscriber/Pro</span>' : ''}
        </div>
      </div>
    `).join('')}
  `).join('');

  infoIndexEl.querySelectorAll('.result-card').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.type === 'external') {
        window.open(el.dataset.url, '_blank', 'noopener');
      } else {
        openInfoTopic(el.dataset.key);
      }
    });
  });
}

async function openInfoTopic(key) {
  currentInfoKey = key;
  infoIndexEl.innerHTML = '<button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button><div class="loading-row" style="margin-top:14px;"><span class="spinner"></span> Loading…</div>';
  document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
  try {
    const res = await fetch(`${API_BASE}/web/reference/${encodeURIComponent(key)}`, { headers: accessHeaders() });
    const data = await res.json();
    if (res.status === 402) {
      renderInfoPaywall(key);
      return;
    }
    if (!res.ok) throw new Error(data.error || 'Could not load that section.');
    renderInfoContent(key, data);
  } catch (err) {
    infoIndexEl.innerHTML = `<button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button><div class="error-box" style="margin-top:14px;">${escapeHtml(err.message)}</div>`;
    document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
  }
}

function renderInfoPaywall(key) {
  infoIndexEl.innerHTML = `
    <button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button>
    <div class="lc-no-code" style="margin-top:14px;">
      This section needs a Subscriber plan or Pro pass to open — same as in the app, no free quota on Important Information topics.
      <div style="margin-top:10px;"><button class="btn-primary" id="info-unlock-btn">Unlock full access</button></div>
    </div>
  `;
  document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
  document.getElementById('info-unlock-btn').addEventListener('click', () => openAccessModal());
}

// Generic renderer: these 39 topics come from many differently-shaped JSON
// structures (arrays of {title, body}, keyed objects, nested lists, etc.)
// — rather than hand-building 39 bespoke layouts, walk whatever comes back
// and render it reasonably. Good enough to be genuinely useful; a future
// pass could give the highest-traffic topics bespoke layouts.
function renderInfoContent(key, data) {
  const title = infoIndexData.flatMap((s) => s.items).find((i) => i.key === key)?.title || key;
  infoIndexEl.innerHTML = `
    <button class="btn-secondary" id="info-back-btn">&larr; Back to topics</button>
    <div class="result-card" style="cursor:default; margin-top:14px;">
      <div class="result-desc" style="font-weight:700; font-size:15px; color:var(--app-primary-dark); margin-bottom:10px;">${escapeHtml(title)}</div>
      ${renderJsonAsHtml(data)}
    </div>
  `;
  document.getElementById('info-back-btn').addEventListener('click', () => renderInfoIndex());
}

function renderJsonAsHtml(value, depth = 0) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return `<p style="font-size:13px; line-height:1.6; margin:4px 0;">${escapeHtml(value)}</p>`;
  if (typeof value === 'number' || typeof value === 'boolean') return `<span>${escapeHtml(String(value))}</span>`;
  if (Array.isArray(value)) {
    return value.map((v) => `<div style="margin:${depth === 0 ? '14px' : '6px'} 0 ${depth === 0 ? '14px' : '6px'} ${depth > 0 ? '14px' : '0'}; ${depth === 0 ? 'padding-top:12px; border-top:1px solid #F1EEE8;' : ''}">${renderJsonAsHtml(v, depth + 1)}</div>`).join('');
  }
  if (typeof value === 'object') {
    const looksLikeALink = typeof value.url === 'string';
    return Object.entries(value).map(([k, v]) => {
      if (k === 'url' || k === 'source_url') {
        return v ? `<p style="margin:4px 0;"><a href="${escapeHtml(v)}" target="_blank" rel="noopener" style="font-size:12px;">Official source ↗</a></p>` : '';
      }
      if (v === null || v === undefined || v === '') return '';
      const label = k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      const isTitleish = /title|heading|name/i.test(k) && typeof v === 'string';
      if (isTitleish) {
        return `<div style="font-weight:700; font-size:${depth <= 1 ? '13.5px' : '13px'}; margin-top:${depth === 0 ? '0' : '8px'};">${escapeHtml(v)}</div>`;
      }
      if (typeof v === 'object') {
        return `<div style="margin-top:6px;"><span style="font-size:10.5px; font-weight:700; text-transform:uppercase; color:var(--muted); letter-spacing:0.4px;">${escapeHtml(label)}</span>${renderJsonAsHtml(v, depth + 1)}</div>`;
      }
      return `<p style="font-size:12.5px; margin:3px 0; line-height:1.5;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(String(v))}</p>`;
    }).join('');
  }
  return '';
}

// Called after a successful admin login or code redemption — if the user
// was looking at a paywalled topic, retry it now that access may unlock it.
function onAccessChanged() {
  if (currentInfoKey) openInfoTopic(currentInfoKey);
}

// ── Init ──────────────────────────────────────────────────────────────
// ?tab=info&topic=hazchem deep-links here from the static SEO preview
// pages (info/<key>.html "Open in the free tools" button) straight into
// that specific topic, instead of just the generic tab.
(async () => {
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab');
  const initialTopic = params.get('topic');
  if (initialTab && document.querySelector(`.tab-btn[data-tab="${initialTab}"]`)) showTab(initialTab);
  if (initialTab === 'info' && initialTopic) {
    await loadInfoIndex();
    openInfoTopic(initialTopic);
  }
})();
