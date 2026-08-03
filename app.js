const SUPABASE_URL = 'https://ckaraszxheilemmynemi.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_oXQ75pz8KR1fv_FGyLkzBA_jk-oORDh';

const STORAGE = {
  legacyUsers: 'qingzhang_users_v1',
  legacySession: 'qingzhang_session_v1',
  bookCache: 'qingzhang_book_cache_v2'
};

const assetMeta = {
  cash: { label: '現金', icon: '⌁', className: 'cash' },
  tw: { label: '台股', icon: '台', className: 'tw' },
  us: { label: '美股', icon: '＄', className: 'us' },
  crypto: { label: '加密貨幣', icon: '₿', className: 'crypto' }
};

const expenseIcons = ['⌂', '◒', '⌁', '⌁', '◉'];
const app = document.querySelector('#app');
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});
let currentModal = null;
let toastTimer;
let viewMonth = todayMonth();
let activeUser = null;
let cloudSyncTimer;

function getLegacyUsers() {
  try { return JSON.parse(localStorage.getItem(STORAGE.legacyUsers) || '{}'); }
  catch { return {}; }
}
function cacheKey(userId) { return `${STORAGE.bookCache}:${userId}`; }
function getCachedBook(userId) {
  try { return JSON.parse(localStorage.getItem(cacheKey(userId)) || 'null'); }
  catch { return null; }
}
function cacheBook(user) { if (user?.id) localStorage.setItem(cacheKey(user.id), JSON.stringify(user)); }
function normalizeUser(user) {
  if (!user) return null;
  user.incomes ||= {};
  user.monthlyExpenses ||= [];
  user.assets ||= emptyAssets();
  user.expenses ||= [];
  user.history ||= [];
  return user;
}
function getUser() { return normalizeUser(activeUser); }
function localDateISO() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function periodMonthForDate(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const date = new Date(year, month - 1, day < 5 ? 1 : 5);
  if (day < 5) date.setMonth(date.getMonth() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function todayMonth() { return periodMonthForDate(localDateISO()); }
function todayDate() { return localDateISO(); }
function money(value) { return new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(Number(value || 0)); }
function inputAmount(value) { return Number(value || 0) === 0 ? '' : String(Number(value)); }
function calculateAmount(expression) {
  const normalized = String(expression ?? '').replace(/[，,\s]/g, '').replace(/×/g, '*').replace(/÷/g, '/');
  if (!normalized || !/^[0-9+\-*/().]+$/.test(normalized)) return null;
  try {
    const result = Function(`"use strict"; return (${normalized})`)();
    return Number.isFinite(result) && result >= 0 ? Math.round(result) : null;
  } catch { return null; }
}
function enableAmountCalculator(form) {
  form.querySelectorAll('[data-calculator]').forEach(input => {
    const preview = document.createElement('p');
    preview.className = 'calculation-preview';
    input.insertAdjacentElement('afterend', preview);
    const updatePreview = (commit = false) => {
      const result = calculateAmount(input.value);
      if (!input.value) { preview.textContent = ''; input.setCustomValidity(''); return; }
      if (result === null) { preview.textContent = '請使用數字與 + − × ÷ ( )'; input.setCustomValidity('請輸入可計算的非負金額'); return; }
      input.setCustomValidity('');
      preview.textContent = `= NT$ ${money(result)}`;
      if (commit) input.value = String(result);
    };
    input.addEventListener('input', () => updatePreview());
    input.addEventListener('blur', () => updatePreview());
    updatePreview();
  });
}
function amountFromForm(form, field) {
  const input = form.elements[field];
  const result = calculateAmount(input.value);
  if (result === null) { input.setCustomValidity('請輸入可計算的非負金額'); input.reportValidity(); input.focus(); return null; }
  input.value = String(result);
  input.setCustomValidity('');
  return result;
}
function monthText(month) { const [year, mon] = month.split('-'); return `${year} 年 ${Number(mon)} 月`; }
function periodRangeText(month) { const [year, mon] = month.split('-').map(Number); const end = new Date(year, mon, 4); return `${mon}/5 - ${end.getMonth() + 1}/4`; }
function dateText(date) { const [, month, day] = date.split('-'); return `${Number(month)}/${Number(day)}`; }
function initials(name) { return (name || '我').trim().slice(0, 1).toUpperCase(); }
function escapeHTML(text) { const el = document.createElement('div'); el.textContent = text; return el.innerHTML; }
function emptyAssets() { return { cash: 0, tw: 0, us: 0, crypto: 0 }; }
function monthSnapshot(user, month = viewMonth) { return user.history.find(item => item.month === month); }
function cloneFixedExpenses(expenses) { return expenses.map(item => ({ ...item })); }
function ensureMonthSnapshot(user, month = viewMonth) {
  let snapshot = monthSnapshot(user, month);
  if (!snapshot) {
    snapshot = { month, total: 0, assets: month === todayMonth() ? { ...user.assets } : emptyAssets(), fixedExpenses: cloneFixedExpenses(user.expenses) };
    user.history.push(snapshot);
  }
  snapshot.assets ||= emptyAssets();
  snapshot.fixedExpenses ||= cloneFixedExpenses(user.expenses);
  return snapshot;
}
function refreshMonthSnapshotTotal(user, month) {
  const snapshot = monthSnapshot(user, month);
  if (snapshot) snapshot.total = totalAssets(user, month);
}
function assetsForMonth(user, month = viewMonth) {
  if (month === todayMonth()) return user.assets;
  return monthSnapshot(user, month)?.assets || emptyAssets();
}
function fixedExpensesForMonth(user, month = viewMonth) {
  if (month === todayMonth()) return user.expenses;
  return monthSnapshot(user, month)?.fixedExpenses || user.expenses;
}
function hasManualExpenseOrder(expenses) { return expenses.some(expense => Number.isFinite(Number(expense.sortOrder))); }
function orderedFixedExpenses(expenses) {
  const manuallyOrdered = hasManualExpenseOrder(expenses);
  return expenses.slice().sort((a, b) => {
    if (manuallyOrdered) {
      const orderA = Number.isFinite(Number(a.sortOrder)) ? Number(a.sortOrder) : Number.MAX_SAFE_INTEGER;
      const orderB = Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
    }
    return Number(a.day || 0) - Number(b.day || 0);
  });
}
function grossAssets(user, month = viewMonth) { return Object.values(assetsForMonth(user, month)).reduce((total, amount) => total + Number(amount || 0), 0); }
function incomeForMonth(user, month = todayMonth()) { return { salary: 0, other: 0, otherNote: '', ...(user.incomes[month] || {}) }; }
function expensesForMonth(user, month = todayMonth()) { return user.monthlyExpenses.filter(item => item.date && periodMonthForDate(item.date) === month); }
function fixedExpenseTotal(user, month = viewMonth) { return fixedExpensesForMonth(user, month).reduce((sum, item) => sum + Number(item.amount || 0), 0); }
function cashExpenseTotal(user, month = viewMonth) { return expensesForMonth(user, month).filter(item => item.payment === 'cash').reduce((sum, item) => sum + Number(item.amount || 0), 0); }
function creditCardSpendTotal(user, month = viewMonth) { return expensesForMonth(user, month).filter(item => item.payment === 'card').reduce((sum, item) => sum + Number(item.amount || 0), 0); }
function creditCardPaymentDue(user, month = viewMonth) { return creditCardSpendTotal(user, previousMonth(month)); }
function totalAssets(user, month = viewMonth) { return grossAssets(user, month) - cashExpenseTotal(user, month) - creditCardPaymentDue(user, month) - fixedExpenseTotal(user, month); }
function previousMonth(month = todayMonth()) { const [year, mon] = month.split('-').map(Number); const date = new Date(year, mon - 2, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function monthlyChange(user, currentTotal, month = viewMonth) {
  const previous = monthSnapshot(user, previousMonth(month));
  if (!previous || Number(previous.total) === 0) return { className: 'neutral', label: '尚無上月比較資料' };
  const previousTotal = previous.assets ? totalAssets(user, previous.month) : Number(previous.total);
  if (previousTotal === 0) return { className: 'neutral', label: '尚無上月比較資料' };
  const change = ((currentTotal - previousTotal) / Math.abs(previousTotal)) * 100;
  return { className: change >= 0 ? 'up' : 'down', label: `${change >= 0 ? '↗' : '↘'} ${Math.abs(change).toFixed(1)}% 較上月` };
}
function shiftMonth(month, amount) { const [year, mon] = month.split('-').map(Number); const date = new Date(year, mon - 1 + amount, 1); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }

function defaultUser(name, email) {
  return {
    name, email,
    assets: { cash: 0, tw: 0, us: 0, crypto: 0 },
    expenses: [],
    incomes: {},
    monthlyExpenses: [],
    history: [{ month: todayMonth(), total: 0 }],
    createdAt: new Date().toISOString()
  };
}

function persistUser(user) {
  activeUser = normalizeUser(user);
  cacheBook(activeUser);
  window.clearTimeout(cloudSyncTimer);
  cloudSyncTimer = window.setTimeout(() => syncBookToCloud(), 350);
}

function bookPayload(user) {
  return {
    assets: user.assets,
    expenses: user.expenses,
    incomes: user.incomes,
    monthlyExpenses: user.monthlyExpenses,
    history: user.history,
    createdAt: user.createdAt || new Date().toISOString()
  };
}

function nameFromAuth(authUser) {
  return String(authUser.user_metadata?.display_name || authUser.email?.split('@')[0] || '我').slice(0, 30);
}

function makeUserFromCloud(authUser, row) {
  const legacy = getLegacyUsers()[authUser.email] || null;
  const cached = getCachedBook(authUser.id);
  const source = row?.book || legacy || cached || {};
  const user = normalizeUser({
    ...defaultUser(row?.display_name || source.name || nameFromAuth(authUser), authUser.email),
    ...source,
    id: authUser.id,
    email: authUser.email,
    name: row?.display_name || source.name || nameFromAuth(authUser)
  });
  delete user.passwordHash;
  return user;
}

async function syncBookToCloud({ quiet = false } = {}) {
  if (!supabaseClient || !activeUser?.id) return false;
  const { error } = await supabaseClient.from('user_books').upsert({
    user_id: activeUser.id,
    display_name: activeUser.name,
    book: bookPayload(activeUser)
  }, { onConflict: 'user_id' });
  if (error) {
    console.error('Supabase sync failed', error);
    if (!quiet) showToast('暫時無法同步到雲端，資料已保留在此裝置。');
    return false;
  }
  cacheBook(activeUser);
  return true;
}

async function loadCloudBook(authUser) {
  if (!supabaseClient) { renderCloudSetupError('無法載入雲端服務。請重新整理後再試。'); return; }
  const { data, error } = await supabaseClient.from('user_books').select('display_name, book').eq('user_id', authUser.id).maybeSingle();
  if (error) {
    console.error('Supabase load failed', error);
    const cached = getCachedBook(authUser.id);
    if (cached) {
      activeUser = normalizeUser(cached);
      renderDashboard();
      showToast('目前離線，顯示此裝置的暫存資料。');
      return;
    }
    renderCloudSetupError('雲端帳本尚未完成設定。請先建立資料表與安全規則。');
    return;
  }
  activeUser = makeUserFromCloud(authUser, data);
  cacheBook(activeUser);
  if (!data) await syncBookToCloud({ quiet: true });
  renderDashboard();
}

function renderCloudSetupError(message) {
  app.innerHTML = `<main class="auth-screen"><div class="auth-shell"><section class="auth-card"><span class="eyebrow">雲端設定</span><h1>還差最後一步。</h1><p class="subtle">${escapeHTML(message)}</p><p class="auth-note">完成 Supabase 的資料表設定後，重新整理青帳即可。</p><button class="button primary" id="cloud-retry" type="button">重新整理</button></section></div></main>`;
  app.querySelector('#cloud-retry').addEventListener('click', () => window.location.reload());
}

function showToast(message) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.textContent = message;
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), 2600);
}

function renderAuth(mode = 'login') {
  app.innerHTML = `
    <main class="auth-screen">
      <div class="auth-shell">
        <div class="brand" aria-label="青"><span class="brand-mark">青</span></div>
        <section class="auth-card">
          <span class="eyebrow">Your personal money space</span>
          <h1>${mode === 'login' ? '歡迎回來。' : '從今天開始，\n看見你的資產。'}</h1>
          <p class="subtle">${mode === 'login' ? '登入後，可在手機與電腦繼續追蹤每一個月的財務變化。' : '建立一個只屬於你的雲端資產帳本，資料會安全同步。'}</p>
          <div class="tabs"><button class="tab ${mode === 'login' ? 'active' : ''}" data-auth-mode="login">登入</button><button class="tab ${mode === 'register' ? 'active' : ''}" data-auth-mode="register">建立帳號</button></div>
          <form id="auth-form">
            ${mode === 'register' ? '<div class="form-row"><label for="name">你的稱呼</label><input id="name" name="name" autocomplete="name" placeholder="例如：小青" required maxlength="30"></div>' : ''}
            <div class="form-row"><label for="email">電子信箱</label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required></div>
            <div class="form-row"><label for="password">密碼</label><input id="password" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" placeholder="至少 6 個字元" required minlength="6"></div>
            <div id="form-error" class="form-error"></div>
            <button class="button primary" type="submit">${mode === 'login' ? '登入我的帳本' : '建立我的帳本'}</button>
          </form>
          <p class="auth-note">登入狀態會保留，之後可直接從手機桌面開啟。</p>
        </section>
      </div>
    </main>`;
  app.querySelectorAll('[data-auth-mode]').forEach(button => button.addEventListener('click', () => renderAuth(button.dataset.authMode)));
  app.querySelector('#auth-form').addEventListener('submit', event => handleAuth(event, mode));
}

async function handleAuth(event, mode) {
  event.preventDefault();
  if (!supabaseClient) { renderCloudSetupError('無法載入雲端服務。請重新整理後再試。'); return; }
  const form = new FormData(event.target);
  const email = String(form.get('email')).trim().toLowerCase();
  const password = String(form.get('password'));
  const error = app.querySelector('#form-error');
  const submitButton = app.querySelector('#auth-form button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = mode === 'login' ? '登入中…' : '建立中…';
  if (mode === 'register') {
    const name = String(form.get('name')).trim();
    if (!name) { error.textContent = '請填寫你的稱呼。'; submitButton.disabled = false; submitButton.textContent = '建立我的帳本'; return; }
    const { data, error: authError } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { display_name: name }, emailRedirectTo: window.location.origin + window.location.pathname }
    });
    if (authError) { error.textContent = authError.message; submitButton.disabled = false; submitButton.textContent = '建立我的帳本'; return; }
    if (!data.session) {
      error.textContent = '驗證信已寄出，請到信箱完成驗證後再回來登入。';
      submitButton.disabled = false;
      submitButton.textContent = '建立我的帳本';
      return;
    }
    await loadCloudBook(data.user);
    showToast('雲端帳本已建立，從這裡開始吧！');
    return;
  }
  const { data, error: authError } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (authError) { error.textContent = '電子信箱或密碼不正確，或帳號尚未完成驗證。'; submitButton.disabled = false; submitButton.textContent = '登入我的帳本'; return; }
  await loadCloudBook(data.user);
  showToast(`歡迎回來，${getUser()?.name || '你'}！`);
}

function renderDashboard() {
  const user = getUser();
  if (!user) { renderAuth(); return; }
  const total = totalAssets(user, viewMonth);
  const fixedExpenses = fixedExpenseTotal(user, viewMonth);
  const viewedAssets = assetsForMonth(user, viewMonth);
  const viewedFixedExpenses = fixedExpensesForMonth(user, viewMonth);
  const thisMonthIncome = incomeForMonth(user, viewMonth);
  const thisMonthIncomeTotal = Number(thisMonthIncome.salary || 0) + Number(thisMonthIncome.other || 0);
  const thisMonthExpenses = expensesForMonth(user, viewMonth);
  const cashExpenses = cashExpenseTotal(user, viewMonth);
  const cardExpenses = creditCardSpendTotal(user, viewMonth);
  const cardPaymentDue = creditCardPaymentDue(user, viewMonth);
  const actualMonthlyOutgoings = fixedExpenses + cashExpenses + cardPaymentDue;
  const monthlyBalance = thisMonthIncomeTotal - actualMonthlyOutgoings;
  const endingCash = Number(viewedAssets.cash || 0) - actualMonthlyOutgoings;
  const comparison = monthlyChange(user, total, viewMonth);
  const selectedSnapshot = monthSnapshot(user, viewMonth);
  const hasSnapshotDetails = Boolean(selectedSnapshot?.assets);
  app.innerHTML = `
    <main class="app-shell">
      <header class="topbar">
        <div class="brand" aria-label="青"><span class="brand-mark">青</span></div>
        <div class="user-menu"><span class="avatar">${escapeHTML(initials(user.name))}</span><button class="icon-button" id="logout-button" aria-label="登出">⋯</button></div>
      </header>
      <section class="overview">
        <p class="overview-label">我的總資產</p>
        <div class="total-number">$ ${money(total)}</div>
        <span class="currency-label">TWD</span>
        <div class="overview-ending-cash"><span>本月期末現金</span><strong>${endingCash >= 0 ? '' : '−'} NT$ ${money(Math.abs(endingCash))}</strong></div>
        <div class="overview-bottom"><div class="overview-meta"><span class="date-chip">檢視：${monthText(viewMonth)}（${periodRangeText(viewMonth)}）${hasSnapshotDetails ? '' : ' · 尚未同步'}</span><span class="change-chip ${comparison.className}">${comparison.label}</span></div></div>
      </section>
      <div class="dashboard-grid">
        <section>
          <div class="section-heading"><div><h2>資產配置</h2><p>點選卡片，更新目前總價</p></div><button class="text-button" id="asset-summary-button">查看明細</button></div>
          <div class="asset-grid">${Object.entries(assetMeta).map(([key, meta]) => `
            <button class="asset-card ${meta.className}" data-asset="${key}"><span class="asset-icon">${meta.icon}</span><small>${meta.label}</small><strong>$ ${money(viewedAssets[key])}</strong><span class="edit-hint">更新 ${monthText(viewMonth)} →</span></button>`).join('')}</div>
          <div class="section-heading"><div><h2>資產趨勢</h2><p>每一格代表 NT$100,000</p></div><button class="text-button" id="history-button">編輯紀錄</button></div>
          <section class="chart-card"><div class="chart-header"><div><h3>總資產變化</h3><span>${user.history.length > 1 ? `已追蹤 ${user.history.length} 個月份` : '同步本月資產後，會顯示走勢'}</span></div><span class="chart-caption">NT$ 100K / 格</span></div><div id="asset-chart" class="chart-wrap"></div></section>
        </section>
        <section>
          <section class="month-switcher compact" aria-label="選擇查看月份"><div><span>查看月份</span><small>${periodRangeText(viewMonth)} 記帳區間</small></div><div class="month-controls"><button class="month-arrow" id="previous-month" aria-label="上個月">‹</button><input id="view-month" type="month" value="${viewMonth}" aria-label="查看月份"><button class="month-arrow" id="next-month" aria-label="下個月">›</button></div></section>
          <div class="section-heading"><div><h2>本月收入</h2><p>${monthText(viewMonth)} · 合計 NT$ ${money(thisMonthIncomeTotal)}</p></div><button class="text-button" id="edit-income-button">更新收入</button></div>
          <section class="income-card" id="income">${renderIncome(thisMonthIncome, thisMonthIncomeTotal)}</section>
          <div class="section-heading"><div><h2>每月固定開銷</h2><p>${monthText(viewMonth)} · 合計 NT$ ${money(fixedExpenses)} / 月</p></div><button class="text-button" id="add-expense-button">＋ 新增</button></div>
          <section class="expense-card" id="expenses">${renderExpenses(viewedFixedExpenses)}</section>
          <div class="section-heading"><div><h2>本月開銷</h2><p>${monthText(viewMonth)} · 現金 NT$ ${money(cashExpenses)} · 本月刷卡 NT$ ${money(cardExpenses)}</p></div><button class="text-button" id="add-monthly-expense-button">＋ 記一筆</button></div>
          <section class="card-payment-card"><div><span>本月信用卡應繳</span><small>${monthText(previousMonth(viewMonth))}信用卡消費 · ${viewMonth}-25 繳納</small></div><strong>NT$ ${money(cardPaymentDue)}</strong></section>
          <section class="expense-card" id="monthly-expenses">${renderMonthlyExpenses(thisMonthExpenses)}</section>
          <section class="monthly-balance-card ${monthlyBalance >= 0 ? 'positive' : 'negative'}"><div class="balance-heading"><span>本月收支結餘</span><strong>${monthlyBalance >= 0 ? '+' : '−'} NT$ ${money(Math.abs(monthlyBalance))}</strong></div><div class="balance-formula"><span>收入 NT$ ${money(thisMonthIncomeTotal)}</span><span>－ 總開銷 NT$ ${money(actualMonthlyOutgoings)}</span></div><div class="balance-breakdown"><span>固定開銷 NT$ ${money(fixedExpenses)}</span><span>現金開銷 NT$ ${money(cashExpenses)}</span><span>信用卡應繳 NT$ ${money(cardPaymentDue)}</span></div><div class="ending-cash"><span>本月期末現金</span><strong>${endingCash >= 0 ? '' : '−'} NT$ ${money(Math.abs(endingCash))}</strong><small>本月現金 NT$ ${money(viewedAssets.cash)} － 總開銷 NT$ ${money(actualMonthlyOutgoings)}</small></div></section>
        </section>
      </div>
    </main>
    <nav class="bottom-nav" aria-label="主要功能"><button class="active"><span class="nav-icon">⌂</span>總覽</button><button id="mobile-history"><span class="nav-icon">⌁</span>趨勢</button><button id="mobile-expense"><span class="nav-icon">◒</span>固定開銷</button></nav>`;
  drawChart(user.history);
  bindDashboard();
}

function renderExpenses(expenses) {
  if (!expenses.length) return '<p class="expense-empty">還沒有固定開銷。<br>例如房租、訂閱服務或保險費。</p>';
  return orderedFixedExpenses(expenses).map((expense, index) => `<button class="expense-row fixed-expense-row" data-expense="${expense.id}" title="拖曳左側圖示排序；點選其餘區域可編輯 ${escapeHTML(expense.name)}"><span class="drag-handle" aria-hidden="true">⠿</span><span class="expense-icon">${expenseIcons[index % expenseIcons.length]}</span><span><span class="expense-name">${escapeHTML(expense.name)}</span><span class="expense-meta">每月 ${expense.day} 日${expense.category ? ` · ${escapeHTML(expense.category)}` : ''}</span></span><strong class="expense-amount">$ ${money(expense.amount)}</strong></button>`).join('');
}

function renderIncome(income, total) {
  return `<div class="income-total"><span>本月收入合計</span><strong>$ ${money(total)}</strong></div><div class="income-breakdown"><div class="income-item salary"><span class="income-symbol">＋</span><span><small>薪資收入</small><strong>$ ${money(income.salary)}</strong></span></div><div class="income-item other"><span class="income-symbol">＋</span><span><small>其他收入</small><strong>$ ${money(income.other)}</strong>${income.otherNote ? `<em class="income-note">${escapeHTML(income.otherNote)}</em>` : ''}</span></div></div>`;
}

function renderMonthlyExpenses(expenses) {
  if (!expenses.length) return '<p class="expense-empty">還沒有本月開銷。<br>記下每筆現金或信用卡消費吧。</p>';
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const rows = expenses.slice().sort((a, b) => b.date.localeCompare(a.date)).map(expense => { const label = expense.payment === 'card' ? '信用卡消費' : '現金開銷'; return `<button class="expense-row monthly-row" data-monthly-expense="${expense.id}" title="編輯${label}"><span class="expense-icon ${expense.payment === 'card' ? 'card-icon' : 'cash-icon'}">${expense.payment === 'card' ? '▣' : '⌁'}</span><span><span class="expense-name">${label}</span><span class="expense-meta">${dateText(expense.date)} <span class="payment-chip ${expense.payment}">${expense.payment === 'card' ? '下月繳' : '已支出'}</span></span></span><strong class="expense-amount">$ ${money(expense.amount)}</strong></button>`; }).join('');
  return `${rows}<div class="monthly-expense-total"><span>本月消費總額</span><strong>NT$ ${money(total)}</strong></div>`;
}

function drawChart(history) {
  const host = document.querySelector('#asset-chart');
  if (!host) return;
  const data = history.slice().sort((a, b) => a.month.localeCompare(b.month));
  if (data.length < 2) { host.innerHTML = '<div class="empty-chart">同步本月資產後，<br>下個月就能在這裡看見資產走勢。</div>'; return; }
  const width = 620, height = 244, left = 64, right = 14, top = 13, bottom = 35;
  const values = data.map(item => Number(item.total));
  const step = 100000;
  const max = Math.max(step, Math.ceil(Math.max(...values) / step) * step);
  const min = Math.min(0, Math.floor(Math.min(...values) / step) * step - (values.every(v => v === 0) ? 0 : step));
  const range = Math.max(step, max - min);
  const y = value => top + (max - value) / range * (height - top - bottom);
  const x = index => left + (data.length === 1 ? 0 : index / (data.length - 1)) * (width - left - right);
  // The vertical scale is deliberately fixed at NT$100,000 per interval.
  const gridValues = Array.from({ length: Math.ceil(range / step) + 1 }, (_, i) => max - step * i);
  const path = data.map((item, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(Number(item.total)).toFixed(1)}`).join(' ');
  const base = y(min);
  const area = `${path} L ${x(data.length - 1).toFixed(1)} ${base.toFixed(1)} L ${x(0).toFixed(1)} ${base.toFixed(1)} Z`;
  const points = data.map((item, i) => {
    const pointX = x(i), pointY = y(Number(item.total));
    const label = `NT$ ${money(item.total)}`;
    const labelWidth = Math.max(82, Math.min(146, label.length * 7 + 18));
    const labelY = pointY < 38 ? pointY + 10 : pointY - 32;
    return `<g class="chart-point-group" tabindex="0" role="button" aria-label="${monthText(item.month)}總資產 ${label}"><circle class="chart-hit" cx="${pointX}" cy="${pointY}" r="14"/><circle class="chart-point" cx="${pointX}" cy="${pointY}" r="4"/><g class="chart-tooltip"><rect x="${pointX - labelWidth / 2}" y="${labelY}" width="${labelWidth}" height="23" rx="6"/><text x="${pointX}" y="${labelY + 15}" text-anchor="middle">${label}</text></g></g><text class="month-label" text-anchor="middle" x="${pointX}" y="${height-9}">${item.month.slice(2).replace('-', '/')}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="總資產每月變化折線圖"><defs><linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a8dbc8" stop-opacity=".55"/><stop offset="100%" stop-color="#a8dbc8" stop-opacity=".02"/></linearGradient></defs>${gridValues.map(value => `<line class="grid-line" x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}"/><text class="grid-label" x="0" y="${y(value)+3}">${value === 0 ? '0' : `${Math.round(value / 10000)}萬`}</text>`).join('')}<path class="chart-area" d="${area}"/><path class="chart-line" d="${path}"/>${points}</svg>`;
  host.querySelectorAll('.chart-point-group').forEach(point => {
    point.addEventListener('pointerup', event => {
      if (event.pointerType !== 'touch') return;
      host.querySelectorAll('.chart-point-group').forEach(item => item.classList.remove('is-active'));
      point.classList.add('is-active');
    });
    point.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      host.querySelectorAll('.chart-point-group').forEach(item => item.classList.remove('is-active'));
      point.classList.add('is-active');
    });
  });
}

function bindDashboard() {
  bindFixedExpenseSorting();
  document.querySelector('#previous-month').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, -1); renderDashboard(); });
  document.querySelector('#next-month').addEventListener('click', () => { viewMonth = shiftMonth(viewMonth, 1); renderDashboard(); });
  document.querySelector('#view-month').addEventListener('change', event => { if (event.target.value) { viewMonth = event.target.value; renderDashboard(); } });
  document.querySelector('#logout-button').addEventListener('click', openAccountModal);
  document.querySelector('#history-button').addEventListener('click', openHistoryModal);
  document.querySelector('#asset-summary-button').addEventListener('click', openAssetsModal);
  document.querySelector('#edit-income-button').addEventListener('click', openIncomeModal);
  document.querySelector('#add-expense-button').addEventListener('click', () => openExpenseModal());
  document.querySelector('#add-monthly-expense-button').addEventListener('click', () => openMonthlyExpenseModal());
  document.querySelectorAll('[data-asset]').forEach(button => button.addEventListener('click', () => openAssetModal(button.dataset.asset)));
  document.querySelectorAll('[data-expense]').forEach(button => button.addEventListener('click', () => openExpenseModal(button.dataset.expense)));
  document.querySelectorAll('[data-monthly-expense]').forEach(button => button.addEventListener('click', () => openMonthlyExpenseModal(button.dataset.monthlyExpense)));
  document.querySelector('#mobile-history').addEventListener('click', () => document.querySelector('.chart-card').scrollIntoView({ behavior: 'smooth', block: 'center' }));
  document.querySelector('#mobile-expense').addEventListener('click', () => document.querySelector('#monthly-expenses').scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

function moveFixedExpense(movedId, targetId, placeAfter) {
  if (!movedId || !targetId || movedId === targetId) return;
  const user = getUser();
  const currentExpenses = fixedExpensesForMonth(user, viewMonth);
  const ordered = orderedFixedExpenses(currentExpenses);
  const movedIndex = ordered.findIndex(expense => expense.id === movedId);
  if (movedIndex < 0) return;
  const [moved] = ordered.splice(movedIndex, 1);
  const targetIndex = ordered.findIndex(expense => expense.id === targetId);
  if (targetIndex < 0) return;
  ordered.splice(placeAfter ? targetIndex + 1 : targetIndex, 0, moved);
  ordered.forEach((expense, index) => { expense.sortOrder = index; });
  if (viewMonth === todayMonth()) user.expenses = ordered;
  else ensureMonthSnapshot(user, viewMonth).fixedExpenses = ordered;
  persistUser(user);
  renderDashboard();
  showToast('固定開銷順序已更新');
}

function bindFixedExpenseSorting() {
  const rows = [...document.querySelectorAll('.fixed-expense-row')];
  let dragState = null;
  const clearMarkers = () => rows.forEach(row => row.classList.remove('dragging', 'drag-over-before', 'drag-over-after'));
  const markTarget = (clientX, clientY) => {
    const candidate = document.elementFromPoint(clientX, clientY)?.closest('.fixed-expense-row');
    rows.forEach(row => row.classList.remove('drag-over-before', 'drag-over-after'));
    if (!candidate || candidate.dataset.expense === dragState?.id) return null;
    const rect = candidate.getBoundingClientRect();
    const placeAfter = clientY >= rect.top + rect.height / 2;
    candidate.classList.add(placeAfter ? 'drag-over-after' : 'drag-over-before');
    return { id: candidate.dataset.expense, placeAfter };
  };
  rows.forEach(row => {
    const handle = row.querySelector('.drag-handle');
    handle.addEventListener('pointerdown', event => {
      dragState = { id: row.dataset.expense, startX: event.clientX, startY: event.clientY, active: false, target: null };
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!dragState || dragState.id !== row.dataset.expense) return;
      if (!dragState.active && Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) < 7) return;
      dragState.active = true;
      event.preventDefault();
      row.classList.add('dragging');
      dragState.target = markTarget(event.clientX, event.clientY);
    });
    const finishDrag = () => {
      if (!dragState || dragState.id !== row.dataset.expense) return;
      const { active, id, target } = dragState;
      clearMarkers();
      dragState = null;
      if (active && target) moveFixedExpense(id, target.id, target.placeAfter);
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', () => { clearMarkers(); dragState = null; });
  });
}

function openModal(content) {
  closeModal();
  currentModal = document.createElement('div');
  currentModal.className = 'modal-backdrop';
  currentModal.innerHTML = `<section class="modal" role="dialog" aria-modal="true">${content}</section>`;
  document.body.append(currentModal);
  currentModal.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
  currentModal.querySelector('input, select')?.focus();
}
function closeModal() { currentModal?.remove(); currentModal = null; }

function openAssetModal(key) {
  const user = getUser(), meta = assetMeta[key], assets = assetsForMonth(user, viewMonth);
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(viewMonth)}資產總價</span><h2>更新${meta.label}</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="asset-form"><div class="form-row"><label for="asset-amount">${monthText(viewMonth)}總價（TWD）</label><input id="asset-amount" name="amount" type="text" value="${inputAmount(assets[key])}" placeholder="例如：172883+100" required inputmode="text" data-calculator></div><p class="form-note">可直接輸入 172883+100、50000-3200 或 (1200+800)*2。填完四項資產後，再同步該月份資料到走勢圖。</p><div class="modal-actions"><button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">儲存金額</button></div></form>`);
  const assetForm = currentModal.querySelector('#asset-form'); enableAmountCalculator(assetForm);
  assetForm.addEventListener('submit', event => { event.preventDefault(); const user = getUser(), amount = amountFromForm(assetForm, 'amount'); if (amount === null) return; if (viewMonth === todayMonth()) user.assets[key] = amount; else ensureMonthSnapshot(user, viewMonth).assets[key] = amount; refreshMonthSnapshotTotal(user, viewMonth); persistUser(user); closeModal(); renderDashboard(); showToast(`${meta.label}已更新`); });
}

function openAssetsModal() {
  const user = getUser();
  const assets = assetsForMonth(user, viewMonth), gross = grossAssets(user, viewMonth), cashExpenses = cashExpenseTotal(user, viewMonth), cardDue = creditCardPaymentDue(user, viewMonth), cardSpending = creditCardSpendTotal(user, viewMonth), fixed = fixedExpenseTotal(user, viewMonth), total = totalAssets(user, viewMonth);
  openModal(`<header class="modal-header"><div><span class="eyebrow">資產明細</span><h2>${monthText(viewMonth)}資產配置</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><ul class="history-list">${Object.entries(assetMeta).map(([key, meta]) => `<li><span>${meta.icon}　${meta.label}</span><strong>NT$ ${money(assets[key])}</strong></li>`).join('')}<li><span>資產合計</span><strong>NT$ ${money(gross)}</strong></li><li><span>－ 本月現金開銷</span><strong>NT$ ${money(cashExpenses)}</strong></li><li><span>－ 本月信用卡應繳（${monthText(previousMonth(viewMonth))}）</span><strong>NT$ ${money(cardDue)}</strong></li><li><span>－ 固定開銷</span><strong>NT$ ${money(fixed)}</strong></li><li><span><b>總資產</b></span><strong>NT$ ${money(total)}</strong></li></ul><p class="form-note">本月刷卡 NT$ ${money(cardSpending)} 會在下個月 25 日從總資產扣除。</p><div class="modal-actions"><button class="button primary" data-close-modal>完成</button></div>`);
}

function openSnapshotModal() {
  const user = getUser(), total = totalAssets(user, viewMonth), month = viewMonth;
  openModal(`<header class="modal-header"><div><span class="eyebrow">月度紀錄</span><h2>同步本月資產</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="snapshot-form"><div class="calculated-total"><span>${monthText(month)}總資產</span><strong>NT$ ${money(total)}</strong><small>自動加總現金、台股、美股、加密貨幣</small></div><p class="form-note">同一月份重複同步會覆蓋舊紀錄。請先更新四項資產的目前總價。</p><div class="modal-actions"><button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">同步到走勢圖</button></div></form>`);
  currentModal.querySelector('#snapshot-form').addEventListener('submit', event => { event.preventDefault(); const user = getUser(), month = viewMonth; const snapshot = ensureMonthSnapshot(user, month); snapshot.assets = { ...assetsForMonth(user, month) }; snapshot.fixedExpenses = cloneFixedExpenses(fixedExpensesForMonth(user, month)); snapshot.total = totalAssets(user, month); user.history.sort((a,b) => a.month.localeCompare(b.month)); persistUser(user); closeModal(); renderDashboard(); showToast(`${monthText(month)}的資產已同步`); });
}

function openIncomeModal() {
  const user = getUser(), month = viewMonth, income = incomeForMonth(user, month);
  openModal(`<header class="modal-header"><div><span class="eyebrow">本月收入</span><h2>更新收入</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="income-form"><div class="form-row"><label for="income-month">月份</label><input id="income-month" name="month" type="month" value="${month}" required></div><div class="form-row"><label for="salary-income">薪資收入（TWD）</label><input id="salary-income" name="salary" type="text" value="${inputAmount(income.salary)}" placeholder="例如：50000" required inputmode="text" data-calculator></div><div class="form-row"><label for="other-income">其他收入（TWD）</label><input id="other-income" name="other" type="text" value="${inputAmount(income.other)}" placeholder="例如：12000+3000" required inputmode="text" data-calculator></div><div class="form-row"><label for="other-income-note">其他收入來源（選填）</label><input id="other-income-note" name="otherNote" value="${escapeHTML(income.otherNote)}" placeholder="例如：接案、年終獎金、紅包" maxlength="40"></div><p class="form-note">金額可直接用 + − × ÷ 計算。收入來源會顯示在其他收入下方。</p><div class="modal-actions"><button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">儲存收入</button></div></form>`);
  const incomeForm = currentModal.querySelector('#income-form'); enableAmountCalculator(incomeForm);
  incomeForm.addEventListener('submit', event => { event.preventDefault(); const form = new FormData(incomeForm), user = getUser(), month = String(form.get('month')), salary = amountFromForm(incomeForm, 'salary'), other = amountFromForm(incomeForm, 'other'); if (salary === null || other === null) return; user.incomes[month] = { salary, other, otherNote: String(form.get('otherNote')).trim() }; viewMonth = month; persistUser(user); closeModal(); renderDashboard(); showToast(`${monthText(month)}的收入已儲存`); });
}

function openHistoryModal() {
  const user = getUser();
  const list = user.history.slice().sort((a, b) => b.month.localeCompare(a.month));
  openModal(`<header class="modal-header"><div><span class="eyebrow">月度紀錄</span><h2>資產歷程</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><ul class="history-list">${list.map(item => `<li><span>${monthText(item.month)}</span><span><strong>NT$ ${money(item.total)}</strong> <button class="text-button" data-remove-history="${item.month}" aria-label="刪除 ${item.month}">刪除</button></span></li>`).join('')}</ul><div class="modal-actions"><button class="button light" data-close-modal>關閉</button><button class="button primary" id="history-add">同步本月資產</button></div>`);
  currentModal.querySelector('#history-add').addEventListener('click', openSnapshotModal);
  currentModal.querySelectorAll('[data-remove-history]').forEach(button => button.addEventListener('click', () => { const user = getUser(); if (user.history.length === 1) { showToast('至少保留一筆月份紀錄'); return; } user.history = user.history.filter(item => item.month !== button.dataset.removeHistory); persistUser(user); openHistoryModal(); renderDashboard(); showToast('月份紀錄已刪除'); }));
}

function openExpenseModal(id) {
  const user = getUser(); const fixedExpenses = fixedExpensesForMonth(user, viewMonth); const expense = id ? fixedExpenses.find(item => item.id === id) : null;
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(viewMonth)}固定開銷</span><h2>${expense ? '編輯固定開銷' : '新增固定開銷'}</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="expense-form"><div class="form-row"><label for="expense-name">項目名稱</label><input id="expense-name" name="name" value="${escapeHTML(expense?.name || '')}" placeholder="例如：房租" required maxlength="40"></div><div class="form-row"><label for="expense-amount">每月金額（TWD）</label><input id="expense-amount" name="amount" type="text" value="${inputAmount(expense?.amount)}" placeholder="例如：30000+1200" required inputmode="text" data-calculator></div><div class="form-row"><label for="expense-day">扣款日</label><select id="expense-day" name="day">${Array.from({length:31},(_,i) => `<option value="${i+1}" ${(expense?.day || 1) === i+1 ? 'selected' : ''}>每月 ${i+1} 日</option>`).join('')}</select></div><div class="form-row"><label for="expense-category">分類（選填）</label><input id="expense-category" name="category" value="${escapeHTML(expense?.category || '')}" placeholder="例如：居住、訂閱、保險" maxlength="30"></div><div class="modal-actions">${expense ? '<button type="button" class="button danger" id="delete-expense">刪除</button>' : ''}<button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">${expense ? '儲存變更' : '新增開銷'}</button></div></form>`);
  const expenseForm = currentModal.querySelector('#expense-form'); enableAmountCalculator(expenseForm);
  expenseForm.addEventListener('submit', event => {
    event.preventDefault();
    const form = new FormData(expenseForm), user = getUser(), amount = amountFromForm(expenseForm, 'amount');
    if (amount === null) return;
    const entry = { id: expense?.id || crypto.randomUUID(), name: String(form.get('name')).trim(), amount, day: Number(form.get('day')), category: String(form.get('category')).trim() };
    if (Number.isFinite(Number(expense?.sortOrder))) entry.sortOrder = Number(expense.sortOrder);
    else if (!expense && hasManualExpenseOrder(fixedExpenses)) entry.sortOrder = Math.max(...fixedExpenses.map(item => Number(item.sortOrder) || 0)) + 1;
    if (viewMonth === todayMonth()) {
      if (expense) user.expenses = user.expenses.map(item => item.id === expense.id ? entry : item);
      else user.expenses.push(entry);
    } else {
      const snapshot = ensureMonthSnapshot(user, viewMonth);
      if (expense) snapshot.fixedExpenses = snapshot.fixedExpenses.map(item => item.id === expense.id ? entry : item);
      else snapshot.fixedExpenses.push(entry);
    }
    refreshMonthSnapshotTotal(user, viewMonth);
    persistUser(user);
    closeModal();
    renderDashboard();
    showToast(expense ? '固定開銷已更新' : '固定開銷已新增');
  });
  currentModal.querySelector('#delete-expense')?.addEventListener('click', () => { const user = getUser(); if (viewMonth === todayMonth()) user.expenses = user.expenses.filter(item => item.id !== expense.id); else { const snapshot = ensureMonthSnapshot(user, viewMonth); snapshot.fixedExpenses = snapshot.fixedExpenses.filter(item => item.id !== expense.id); } refreshMonthSnapshotTotal(user, viewMonth); persistUser(user); closeModal(); renderDashboard(); showToast('固定開銷已刪除'); });
}

function openMonthlyExpenseModal(id) {
  const user = getUser(); const expense = id ? user.monthlyExpenses.find(item => item.id === id) : null;
  const defaultDate = viewMonth === todayMonth() ? todayDate() : `${viewMonth}-05`;
  openModal(`<header class="modal-header"><div><span class="eyebrow">${monthText(viewMonth)}開銷</span><h2>${expense ? '編輯一筆開銷' : '記錄一筆開銷'}</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><form id="monthly-expense-form"><div class="form-row"><label for="monthly-expense-amount">金額（TWD）</label><input id="monthly-expense-amount" name="amount" type="text" value="${inputAmount(expense?.amount)}" placeholder="例如：120+45" required inputmode="text" data-calculator></div><div class="form-row"><label for="monthly-expense-date">日期</label><input id="monthly-expense-date" name="date" type="date" value="${expense?.date || defaultDate}" required></div><div class="form-row"><label for="monthly-expense-payment">付款方式</label><select id="monthly-expense-payment" name="payment"><option value="cash" ${expense?.payment === 'cash' || !expense ? 'selected' : ''}>現金（本月扣除）</option><option value="card" ${expense?.payment === 'card' ? 'selected' : ''}>信用卡（下月 25 日扣除）</option></select></div><p class="form-note">本月開銷只記付款方式與金額；消費明細可保留在你原本的記錄工具。</p><div class="modal-actions">${expense ? '<button type="button" class="button danger" id="delete-monthly-expense">刪除</button>' : ''}<button type="button" class="button light" data-close-modal>取消</button><button class="button primary" type="submit">${expense ? '儲存變更' : '新增開銷'}</button></div></form>`);
  const monthlyExpenseForm = currentModal.querySelector('#monthly-expense-form'); enableAmountCalculator(monthlyExpenseForm);
  monthlyExpenseForm.addEventListener('submit', event => { event.preventDefault(); const form = new FormData(monthlyExpenseForm), user = getUser(), oldMonth = expense ? periodMonthForDate(expense.date) : null, amount = amountFromForm(monthlyExpenseForm, 'amount'), payment = String(form.get('payment')); if (amount === null) return; const entry = { id: expense?.id || crypto.randomUUID(), name: payment === 'card' ? '信用卡消費' : '現金開銷', amount, date: String(form.get('date')), payment, category: '' }; const entryMonth = periodMonthForDate(entry.date); if (expense) user.monthlyExpenses = user.monthlyExpenses.map(item => item.id === expense.id ? entry : item); else user.monthlyExpenses.push(entry); if (oldMonth) { refreshMonthSnapshotTotal(user, oldMonth); refreshMonthSnapshotTotal(user, shiftMonth(oldMonth, 1)); } refreshMonthSnapshotTotal(user, entryMonth); refreshMonthSnapshotTotal(user, shiftMonth(entryMonth, 1)); viewMonth = entryMonth; persistUser(user); closeModal(); renderDashboard(); showToast(expense ? '本月開銷已更新' : '本月開銷已新增'); });
  currentModal.querySelector('#delete-monthly-expense')?.addEventListener('click', () => { const user = getUser(), expenseMonth = periodMonthForDate(expense.date); user.monthlyExpenses = user.monthlyExpenses.filter(item => item.id !== expense.id); refreshMonthSnapshotTotal(user, expenseMonth); refreshMonthSnapshotTotal(user, shiftMonth(expenseMonth, 1)); persistUser(user); closeModal(); renderDashboard(); showToast('本月開銷已刪除'); });
}

function openAccountModal() {
  const user = getUser();
  openModal(`<header class="modal-header"><div><span class="eyebrow">帳號設定</span><h2>${escapeHTML(user.name)}</h2></div><button class="icon-button" data-close-modal aria-label="關閉">×</button></header><p class="subtle">${escapeHTML(user.email)}</p><hr class="divider"><p class="form-note">帳本會安全同步到你的雲端帳號。換手機或電腦後，登入同一個信箱即可繼續使用。</p><div class="modal-actions"><button class="button light" data-close-modal>返回</button><button class="button danger" id="confirm-logout">登出</button></div>`);
  currentModal.querySelector('#confirm-logout').addEventListener('click', async () => {
    window.clearTimeout(cloudSyncTimer);
    await syncBookToCloud({ quiet: true });
    await supabaseClient?.auth.signOut();
    activeUser = null;
    closeModal();
    renderAuth();
    showToast('已登出');
  });
}

if ('serviceWorker' in navigator) window.addEventListener('load', () => {
  navigator.serviceWorker.register('./sw.js?v=23').then(registration => registration.update());
});

async function startApp() {
  if (!supabaseClient) { renderCloudSetupError('無法載入雲端服務。請重新整理後再試。'); return; }
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) { renderAuth(); return; }
  if (data.session?.user) await loadCloudBook(data.session.user);
  else renderAuth();
}

startApp();
