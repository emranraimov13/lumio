'use strict';

/* =========================================================
   Lumio — client
   ========================================================= */

const LS_ACCOUNTS = 'auralis.accounts.v2';
const LS_SESSION = 'auralis.session.v2';
const LS_LEGACY = {
  chats: 'auralis.chats.v1',
  settings: 'auralis.settings.v1',
  last: 'auralis.last.v1',
  library: 'auralis.library.v1',
};

let activeUserId = 'guest';
let activeUser = null;

function dataKey(name) {
  return `auralis.data.${activeUserId}.${name}`;
}

function readAccounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_ACCOUNTS) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (account) =>
        account &&
        typeof account.id === 'string' &&
        typeof account.email === 'string' &&
        typeof account.hash === 'string'
    );
  } catch {
    return [];
  }
}

function saveAccounts(accounts) {
  try {
    localStorage.setItem(LS_ACCOUNTS, JSON.stringify(accounts));
  } catch {
    /* ignore */
  }
}

function loadSession() {
  try {
    const session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    if (session && typeof session.userId === 'string') {
      const account = readAccounts().find((item) => item.id === session.userId);
      if (account) {
        activeUserId = account.id;
        activeUser = account;
        return;
      }
    }
  } catch {
    /* ignore */
  }
  activeUserId = 'guest';
  activeUser = null;
}

function saveSession() {
  try {
    if (activeUser) {
      localStorage.setItem(
        LS_SESSION,
        JSON.stringify({ userId: activeUser.id, at: Date.now() })
      );
    } else {
      localStorage.removeItem(LS_SESSION);
    }
  } catch {
    /* ignore */
  }
}

function migrateLegacyToGuest() {
  const targets = {
    chats: 'auralis.data.guest.chats.v1',
    settings: 'auralis.data.guest.settings.v1',
    last: 'auralis.data.guest.last.v1',
    library: 'auralis.data.guest.library.v1',
  };
  for (const [name, target] of Object.entries(targets)) {
    try {
      if (!localStorage.getItem(target) && localStorage.getItem(LS_LEGACY[name])) {
        localStorage.setItem(target, localStorage.getItem(LS_LEGACY[name]));
      }
    } catch {
      /* ignore */
    }
  }
}

function migrateGuestTo(userId) {
  if (!userId || userId === 'guest') return;
  for (const name of ['chats.v1', 'settings.v1', 'last.v1', 'library.v1']) {
    try {
      const from = `auralis.data.guest.${name}`;
      const to = `auralis.data.${userId}.${name}`;
      if (!localStorage.getItem(to) && localStorage.getItem(from)) {
        localStorage.setItem(to, localStorage.getItem(from));
      }
    } catch {
      /* ignore */
    }
  }
}

loadSession();
migrateLegacyToGuest();

function userNickname() {
  if (activeUser && activeUser.nickname) return activeUser.nickname;
  return 'Гость';
}

function userEmail() {
  return activeUser ? activeUser.email : 'локальный аккаунт';
}

function userInitial() {
  const nick = userNickname().trim();
  return nick ? nick.charAt(0).toUpperCase() : 'A';
}

const AVATAR_COLORS = ['#8b7bff', '#5ad1ff', '#e8b06b', '#ff86dc', '#7ff0d4', '#f3d9a4'];

function pickAvatarColor(seed) {
  const text = String(seed || 'auralis');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function userColor() {
  return (activeUser && activeUser.color) || pickAvatarColor(userNickname());
}

/* ---------- Local accounts ---------- */

let authMode = 'login';
let profileColor = AVATAR_COLORS[0];

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fallbackHash(value) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (Math.imul(h2 ^ code, 2246822519) + 3266489917) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

async function hashPassword(password, saltHex) {
  try {
    if (window.crypto && window.crypto.subtle) {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
      );
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: hexToBytes(saltHex),
          iterations: 120000,
          hash: 'SHA-256',
        },
        key,
        256
      );
      return { hash: bytesToHex(new Uint8Array(bits)), algo: 'pbkdf2' };
    }
  } catch {
    /* fall through to the local hash for non-secure contexts */
  }
  return { hash: fallbackHash(`${saltHex}:${password}`), algo: 'fallback' };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function validateNickname(value) {
  const nick = String(value || '').trim();
  if (nick.length < 2) return 'Ник должен быть не короче 2 символов.';
  if (nick.length > 24) return 'Ник должен быть не длиннее 24 символов.';
  return '';
}

async function registerAccount({ nickname, email, password }) {
  const nick = String(nickname || '').trim();
  const mail = normalizeEmail(email);
  const nickError = validateNickname(nick);
  if (nickError) throw new Error(nickError);
  if (!validEmail(mail)) throw new Error('Введите корректный email.');
  if (String(password || '').length < 6) throw new Error('Пароль должен быть не короче 6 символов.');

  const accounts = readAccounts();
  if (accounts.some((account) => normalizeEmail(account.email) === mail)) {
    throw new Error('Аккаунт с таким email уже есть. Войдите.');
  }

  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const { hash, algo } = await hashPassword(password, salt);
  const account = {
    id: uid(),
    nickname: nick,
    email: mail,
    salt,
    hash,
    algo,
    color: pickAvatarColor(nick),
    createdAt: Date.now(),
  };
  saveAccounts([...accounts, account]);
  migrateGuestTo(account.id);
  activeUser = account;
  activeUserId = account.id;
  saveSession();
  applyUser(account.id, account);
  return account;
}

async function loginAccount({ email, password }) {
  const mail = normalizeEmail(email);
  if (!validEmail(mail)) throw new Error('Введите корректный email.');
  if (!password) throw new Error('Введите пароль.');
  const account = readAccounts().find((item) => normalizeEmail(item.email) === mail);
  if (!account) throw new Error('Аккаунт не найден. Создайте новый или войдите как гость.');

  const { hash } = await hashPassword(password, account.salt);
  if (hash !== account.hash) throw new Error('Неверный пароль. Попробуйте ещё раз.');

  migrateGuestTo(account.id);
  activeUser = account;
  activeUserId = account.id;
  saveSession();
  applyUser(account.id, account);
  return account;
}

function applyUser(userId, account) {
  activeUserId = userId || 'guest';
  activeUser = account || null;
  saveSession();

  state.chats = loadChats();
  state.settings = loadSettings();
  state.library = loadLibrary();
  state.gallery = state.library.images
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((image) => ({ ...image }));
  state.currentId = null;
  state.generating = false;
  state.controller = null;
  state.streamFrame = null;
  state.chatTimer = null;
  state.demoWarned = false;
  state.site = null;
  state.studioGenerating = false;
  state.studioController = null;
  state.studioProgressTimer = null;
  state.imagePending = 0;
  state.imageCooldownUntil = 0;
  state.filter = '';
  state.lightboxItem = null;

  try {
    const lastId = localStorage.getItem(dataKey('last.v1'));
    if (lastId && state.chats.some((chat) => chat.id === lastId)) {
      state.currentId = lastId;
    } else if (state.chats.length) {
      state.currentId = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    }
  } catch {
    /* ignore */
  }

  if (el.chatSearch) el.chatSearch.value = '';
  applyUserNickname();
  renderAll();
  renderSidebar();
  renderRecent();
  updateLibraryBadge();
  renderImageGrid();
  renderLibrary();
  renderStudio();
  updateGalleryUI();
  updateImageButtonState();
  renderProfile();
  if (state.page === 'features') startFeatures();
}

function applyUserNickname() {
  const nick = userNickname();
  const email = userEmail();
  const initial = userInitial();
  const color = userColor();
  const setText = (selector, value) => {
    const node = $(selector);
    if (node) node.textContent = value;
  };
  setText('#userNickname', nick);
  setText('#profileName', nick);
  setText('#profileMenuName', nick);
  setText('#profileMenuEmail', email);
  setText('#profileModalName', nick);
  setText('#profileModalEmail', email);
  setText('#landingUserNick', nick);
  setText('#landingUserEmail', email);
  $$('#profileAvatar, #profileMenuAvatar, #profileModalAvatar, #landingUserAvatar').forEach(
    (node) => {
      node.textContent = initial;
      node.style.background = color;
    }
  );
  const landingUser = $('#landingUser');
  if (landingUser) landingUser.hidden = !activeUser;
}

function updateLandingAuthState() {
  const logged = Boolean(activeUser);
  const nick = userNickname();
  const loginBtn = $('#landingLoginBtn');
  const startBtn = $('#landingStartBtn');
  const heroStart = $('#landingHeroStart');
  const heroGuest = $('#landingHeroGuest');
  if (loginBtn) loginBtn.textContent = logged ? 'Продолжить' : 'Войти';
  if (startBtn) {
    startBtn.innerHTML = logged
      ? `<span class="btn-shine"></span>Продолжить как ${escapeHtml(nick)}`
      : '<span class="btn-shine"></span>Начать бесплатно';
  }
  if (heroStart) {
    heroStart.innerHTML = logged
      ? `<span class="btn-shine"></span><svg class="icon"><use href="#i-hourglass"/></svg> Продолжить как ${escapeHtml(nick)}`
      : '<span class="btn-shine"></span><svg class="icon"><use href="#i-hourglass"/></svg> Войти в пространство';
  }
  if (heroGuest) heroGuest.hidden = logged;
  applyUserNickname();
}

function openAuth(mode = 'login') {
  const modal = $('#authModal');
  if (!modal) return;
  setAuthMode(mode);
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
  const form = $('#authForm');
  if (form) form.reset();
  const error = $('#authError');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }
  setTimeout(() => {
    const focus = mode === 'register' ? $('#authNickname') : $('#authEmail');
    if (focus) focus.focus();
  }, 80);
}

function closeAuth() {
  const modal = $('#authModal');
  if (!modal || modal.hidden) return;
  modal.classList.remove('show');
  setTimeout(() => {
    modal.hidden = true;
  }, 240);
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  $$('[data-auth-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.authTab === authMode);
  });
  $$('[data-auth-only="register"]').forEach((field) => {
    field.hidden = authMode !== 'register';
  });
  const title = $('#authTitle');
  const subtitle = $('#authSubtitle');
  const submit = $('#authSubmit');
  const note = $('#authNote');
  if (title) title.textContent = authMode === 'register' ? 'Создайте аккаунт' : 'С возвращением';
  if (subtitle) {
    subtitle.textContent =
      authMode === 'register'
        ? 'Ник, email и пароль. Всё хранится в этом браузере.'
        : 'Войдите, чтобы вернуться к своим диалогам и проектам.';
  }
  if (submit) submit.textContent = authMode === 'register' ? 'Создать аккаунт' : 'Войти';
  if (note) {
    note.textContent =
      authMode === 'register'
        ? 'Пароль хешируется в браузере. Это локальный аккаунт, а не банковский сервис.'
        : 'Аккаунт хранится в этом браузере. Пароль не отправляется на сервер.';
  }
  const nick = $('#authNickname');
  const confirm = $('#authPassword2');
  if (nick) nick.required = authMode === 'register';
  if (confirm) confirm.required = authMode === 'register';
  const error = $('#authError');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }
}

function showAuthError(message) {
  const error = $('#authError');
  if (!error) return;
  error.textContent = message;
  error.hidden = false;
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const nickname = ($('#authNickname')?.value || '').trim();
  const email = ($('#authEmail')?.value || '').trim();
  const password = $('#authPassword')?.value || '';
  const password2 = $('#authPassword2')?.value || '';
  const submit = $('#authSubmit');
  const original = submit ? submit.textContent : '';

  if (authMode === 'register') {
    const nickError = validateNickname(nickname);
    if (nickError) return showAuthError(nickError);
    if (!validEmail(email)) return showAuthError('Введите корректный email.');
    if (password.length < 6) return showAuthError('Пароль должен быть не короче 6 символов.');
    if (password !== password2) return showAuthError('Пароли не совпадают.');
  } else if (!email || !password) {
    return showAuthError('Введите email и пароль.');
  }

  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Проверяем…';
  }
  try {
    const account =
      authMode === 'register'
        ? await registerAccount({ nickname, email, password })
        : await loginAccount({ email, password });
    closeAuth();
    enterApp();
    toast(
      authMode === 'register' ? 'Аккаунт создан' : 'С возвращением',
      `${account.nickname}, ваши диалоги и проекты на месте.`,
      'success'
    );
  } catch (error) {
    showAuthError(error?.message || 'Не удалось войти. Попробуйте ещё раз.');
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = original || (authMode === 'register' ? 'Создать аккаунт' : 'Войти');
    }
  }
}

function guestLogin() {
  migrateLegacyToGuest();
  activeUser = null;
  activeUserId = 'guest';
  saveSession();
  applyUser('guest', null);
  enterApp();
  toast('Гостевой режим', 'Диалоги сохранятся в этом браузере. Аккаунт можно создать позже.', 'info');
}

function logoutAccount() {
  activeUser = null;
  activeUserId = 'guest';
  saveSession();
  applyUser('guest', null);
  closeProfile();
  showLanding();
  toast('Вы вышли', 'Данные аккаунта остались в браузере — можно войти снова.', 'info');
}

function enterApp() {
  if (document.body.classList.contains('app-open')) return;
  closeAuth();
  closeProfile();
  closeSidebar();
  const overlay = $('#flipOverlay');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const swap = () => {
    document.body.classList.remove('landing-open');
    document.body.classList.add('app-open');
    const landing = $('#landing');
    if (landing) landing.setAttribute('aria-hidden', 'true');
    applyUserNickname();
    renderProfile();
    if (state.page === 'chat') scrollToBottom(false);
  };

  if (reduced) {
    swap();
    return;
  }

  if (overlay) {
    overlay.hidden = false;
    requestAnimationFrame(() => overlay.classList.add('show'));
  }
  document.body.classList.add('flipping');
  setTimeout(() => {
    swap();
    setTimeout(() => {
      if (overlay) {
        overlay.classList.remove('show');
        setTimeout(() => {
          overlay.hidden = true;
        }, 420);
      }
      document.body.classList.remove('flipping');
    }, 520);
  }, 620);
}

function showLanding() {
  document.body.classList.remove('app-open', 'flipping');
  document.body.classList.add('landing-open');
  const landing = $('#landing');
  if (landing) {
    landing.hidden = false;
    landing.setAttribute('aria-hidden', 'false');
    landing.scrollTop = 0;
  }
  updateLandingAuthState();
}

/* ---------- Profile ---------- */

function renderProfile() {
  const btn = $('#profileBtn');
  if (!btn) return;
  applyUserNickname();
  const guest = !activeUser;
  $$('[data-profile-action="profile"]').forEach((node) => {
    node.hidden = guest;
  });
  $$('[data-profile-action="logout"]').forEach((node) => {
    node.hidden = guest;
  });
  $$('[data-profile-action="login"]').forEach((node) => {
    node.hidden = !guest;
  });
  btn.title = guest ? 'Войти в аккаунт' : `${userNickname()} · ${userEmail()}`;
}

function openProfile() {
  if (!activeUser) {
    openAuth('login');
    return;
  }
  const modal = $('#profileModal');
  if (!modal) return;
  const nick = $('#profileNicknameInput');
  if (nick) nick.value = activeUser.nickname || '';
  profileColor = userColor();
  renderAvatarColors();
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
}

function closeProfile() {
  const modal = $('#profileModal');
  if (!modal || modal.hidden) return;
  modal.classList.remove('show');
  setTimeout(() => {
    modal.hidden = true;
  }, 220);
}

function renderAvatarColors() {
  const wrap = $('#avatarColors');
  if (!wrap) return;
  wrap.innerHTML = AVATAR_COLORS.map(
    (color) =>
      `<button class="avatar-color${color === profileColor ? ' active' : ''}" type="button" data-avatar-color="${color}" style="--swatch:${color}" aria-label="Цвет ${color}"></button>`
  ).join('');
}

function saveProfile() {
  if (!activeUser) return;
  const nick = ($('#profileNicknameInput')?.value || '').trim();
  const nickError = validateNickname(nick);
  if (nickError) {
    toast('Ник не сохранён', nickError, 'error');
    return;
  }
  const accounts = readAccounts();
  const index = accounts.findIndex((account) => account.id === activeUser.id);
  if (index < 0) return;
  const updated = { ...accounts[index], nickname: nick, color: profileColor };
  accounts[index] = updated;
  saveAccounts(accounts);
  activeUser = updated;
  saveSession();
  applyUserNickname();
  renderProfile();
  closeProfile();
  toast('Профиль обновлён', `Теперь вас зовут ${nick}.`, 'success');
}

function toggleProfileMenu(force) {
  const menu = $('#profileMenu');
  const btn = $('#profileBtn');
  if (!menu || !btn) return;
  const open = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function bindProfile() {
  const btn = $('#profileBtn');
  if (btn) {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleProfileMenu();
    });
  }
  document.addEventListener('click', (event) => {
    const menu = $('#profileMenu');
    if (!menu || menu.hidden) return;
    if (event.target.closest('#profileMenu') || event.target.closest('#profileBtn')) return;
    toggleProfileMenu(false);
  });
  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-profile-action]');
    if (!action) return;
    toggleProfileMenu(false);
    if (action.dataset.profileAction === 'profile') openProfile();
    if (action.dataset.profileAction === 'logout') logoutAccount();
    if (action.dataset.profileAction === 'login') openAuth('login');
  });
  $('#profileClose')?.addEventListener('click', closeProfile);
  $('#profileSave')?.addEventListener('click', saveProfile);
  $('#profileLogout')?.addEventListener('click', logoutAccount);
  $('#profileModal')?.addEventListener('click', (event) => {
    if (event.target === $('#profileModal')) closeProfile();
  });
  $('#avatarColors')?.addEventListener('click', (event) => {
    const swatch = event.target.closest('[data-avatar-color]');
    if (!swatch) return;
    profileColor = swatch.dataset.avatarColor;
    renderAvatarColors();
  });
}

function bindLanding() {
  const openLogin = () => {
    if (activeUser) enterApp();
    else openAuth('login');
  };
  const openRegister = () => {
    if (activeUser) enterApp();
    else openAuth('register');
  };
  $('#landingLoginBtn')?.addEventListener('click', openLogin);
  $('#landingStartBtn')?.addEventListener('click', openRegister);
  $('#landingHeroStart')?.addEventListener('click', openRegister);
  $('#landingHeroGuest')?.addEventListener('click', guestLogin);
  $('#landingFreeStart')?.addEventListener('click', openRegister);
  $('#landingFinalStart')?.addEventListener('click', openRegister);
  $('#landingFinalGuest')?.addEventListener('click', guestLogin);
  $('#landingUser')?.addEventListener('click', enterApp);

  $('#authClose')?.addEventListener('click', closeAuth);
  $('#authGuest')?.addEventListener('click', () => {
    closeAuth();
    guestLogin();
  });
  $('#authModal')?.addEventListener('click', (event) => {
    if (event.target === $('#authModal')) closeAuth();
  });
  $$('[data-auth-tab]').forEach((tab) => {
    tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab));
  });
  $('#authForm')?.addEventListener('submit', handleAuthSubmit);
  $('#authPasswordToggle')?.addEventListener('click', () => {
    const input = $('#authPassword');
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAuth();
    closeProfile();
    toggleProfileMenu(false);
  });

  updateLandingAuthState();
  renderProfile();
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты — Lumio, умный, дружелюбный и точный ИИ-ассистент. ' +
  'Отвечай на языке пользователя (по умолчанию — на русском). ' +
  'Будь конкретным и полезным: структурируй ответ, используй markdown, списки и короткие абзацы, если это помогает. ' +
  'Не добавляй воду и не повторяй вопрос. Если чего-то не знаешь — честно скажи. ' +
  'Код оформляй в блоки с указанием языка. ' +
  'Ты можешь ошибаться, но не выдумывай факты и источники.';

const FREE_MODEL = 'thinkingmachines/inkling-2-mini';

const PROVIDERS = {
  free: {
    label: 'Lumio Free',
    baseUrl: 'https://blockrun.ai/api/v1',
    model: FREE_MODEL,
    keyPlaceholder: 'ключ не нужен',
    note: 'Бесплатная модель без ключа и регистрации. Обычно отвечает за несколько секунд. Для максимального качества подключите Claude, Gemini, GPT или OpenRouter.',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyPlaceholder: 'sk-or-v1-…',
    note: 'Ключ создаётся на openrouter.ai/keys. У OpenRouter есть бесплатные модели с суффиксом :free — их можно ввести в поле «Модель» вручную.',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-5',
    keyPlaceholder: 'sk-ant-…',
    note: 'Ключ создаётся в консоли console.anthropic.com → API Keys. Поддерживаются модели Claude Sonnet, Opus и Haiku. Ключ хранится только в браузере.',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    keyPlaceholder: 'AIza…',
    note: 'Ключ создаётся бесплатно в Google AI Studio (aistudio.google.com/apikey). Gemini подключается через совместимый API и работает с моделями 2.5 Flash и 2.5 Pro.',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyPlaceholder: 'sk-…',
    note: 'Ключ создаётся в личном кабинете platform.openai.com. Он отправляется напрямую в OpenAI через локальный сервер и не сохраняется на сервере.',
  },
  custom: {
    label: 'Свой API',
    baseUrl: '',
    model: '',
    keyPlaceholder: 'необязательно',
    note: 'Подойдёт любой OpenAI-совместимый API (Ollama, LM Studio, vLLM и другие). Если сервер не требует ключ — оставьте поле пустым.',
  },
};

const MODEL_PRESETS = {
  free: [
    { id: FREE_MODEL, name: 'Lumio Free', desc: 'Inkling 2 mini · быстрый' },
    { id: 'openai/gpt-6.2-astra-pro', name: 'GPT-6.2 Astra Pro', desc: 'Сильная универсальная' },
    { id: 'openai/gpt-6.2-sol-pro', name: 'GPT-6.2 Sol Pro', desc: 'Максимум качества' },
    { id: 'openai/gpt-6.2-astra-pro:batch', name: 'Astra Pro · batch', desc: 'Пакетный режим, медленнее' },
  ],
  openrouter: [
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', desc: 'Быстрый и универсальный' },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', desc: 'Вдумчивые ответы и код' },
    { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Мгновенная реакция' },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3', desc: 'Сильная открытая модель' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', desc: 'Открытая модель Meta' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', desc: 'Лучший баланс скорости и ума' },
    { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', desc: 'Максимальная глубина' },
    { id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet', desc: 'Проверенная модель' },
    { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', desc: 'Самая быстрая' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', desc: 'Быстрая и умная' },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', desc: 'Глубокие ответы' },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', desc: 'Мгновенная реакция' },
  ],
  openai: [
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', desc: 'Быстрый и недорогой' },
    { id: 'gpt-4o', name: 'GPT-4o', desc: 'Максимальное качество' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', desc: 'Новое поколение' },
  ],
  custom: [],
};

const PAGE_META = {
  chat: { title: 'Чат' },
  studio: { title: 'Студия сайтов' },
  images: { title: 'Картинки' },
  library: { title: 'Библиотека' },
  features: { title: 'Возможности' },
};

const SITE_IDEAS = [
  { prompt: 'Сайт для кофейни «Север» — тёмный минимализм, крупные фото, меню, отзывы и кнопка брони', style: 'dark' },
  { prompt: 'Портфолио фотографа в стиле неон: крупная типографика, галерея работ, контакты и дерзкие анимации', style: 'neon' },
  { prompt: 'Лендинг для AI-сервиса: светлый дизайн, стеклянные карточки, тарифы и плавные появления при скролле', style: 'light' },
  { prompt: 'Сайт горного курорта: атмосферные фото, номера, активности и форма бронирования в спокойном стиле', style: 'glass' },
  { prompt: 'Персональный сайт дизайнера: минимализм, много воздуха, проекты сеткой и крупный заголовок', style: 'minimal' },
  { prompt: 'Лендинг для инди-игры: тёмный космос, неоновые акценты, трейлер-блок, фичи и кнопка Wishlist', style: 'dark' },
];

const IMAGE_STYLE_PROMPTS = {
  cinematic: 'cinematic photography, dramatic lighting, film grain, shallow depth of field, epic composition',
  photo: 'professional photography, natural light, realistic details, 50mm lens, sharp focus',
  '3d': 'high quality 3D render, octane render, soft studio lighting, detailed materials',
  anime: 'anime illustration, vibrant colors, detailed line art, studio quality',
  neon: 'neon cyberpunk aesthetic, glowing accents, dark atmosphere, vivid reflections',
  minimal: 'minimalist composition, clean background, soft gradients, lots of negative space',
};

const IMAGE_ASPECTS = {
  '1:1': { width: 1024, height: 1024, css: 1 },
  '16:9': { width: 1280, height: 720, css: 16 / 9 },
  '9:16': { width: 720, height: 1280, css: 9 / 16 },
};

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp',
  h: 'c', php: 'php', sql: 'sql', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml',
  json: 'json', html: 'html', css: 'css', md: 'markdown', csv: 'csv', xml: 'xml',
  swift: 'swift', kt: 'kotlin', toml: 'toml', ini: 'ini', env: 'bash', log: 'text',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const el = {
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  menuBtn: $('#menuBtn'),
  sidebarClose: $('#sidebarClose'),
  brandHome: $('#brandHome'),
  newChatBtn: $('#newChatBtn'),
  chatSearch: $('#chatSearch'),
  chatList: $('#chatList'),
  keyCard: $('#keyCard'),
  settingsBtn: $('#settingsBtn'),
  settingsBtnTop: $('#settingsBtnTop'),
  topbar: $('#topbar'),
  topbarTitle: $('#topbarTitle'),
  modeChip: $('#modeChip'),
  modelBtn: $('#modelBtn'),
  modelLabel: $('#modelLabel'),
  modelMenu: $('#modelMenu'),
  modelMenuList: $('#modelMenuList'),
  modelMenuSettings: $('#modelMenuSettings'),
  exportBtn: $('#exportBtn'),
  stage: $('#stage'),
  welcome: $('#welcome'),
  suggestions: $('#suggestions'),
  messages: $('#messages'),
  input: $('#input'),
  sendBtn: $('#sendBtn'),
  attachBtn: $('#attachBtn'),
  fileInput: $('#fileInput'),
  composerHint: $('#composerHint'),
  composerModel: $('#composerModel'),
  heroStatus: $('#heroStatus'),
  heroStatusText: $('#heroStatusText'),
  settingsModal: $('#settingsModal'),
  settingsClose: $('#settingsClose'),
  settingsCancel: $('#settingsCancel'),
  settingsSave: $('#settingsSave'),
  resetSettingsBtn: $('#resetSettingsBtn'),
  providerSelect: $('#providerSelect'),
  assistantNameInput: $('#assistantNameInput'),
  apiKeyInput: $('#apiKeyInput'),
  toggleKey: $('#toggleKey'),
  modelInput: $('#modelInput'),
  modelOptions: $('#modelOptions'),
  modelNote: $('#modelNote'),
  loadModelsBtn: $('#loadModelsBtn'),
  temperatureInput: $('#temperatureInput'),
  tempValue: $('#tempValue'),
  baseUrlInput: $('#baseUrlInput'),
  systemPromptInput: $('#systemPromptInput'),
  autoCreateInput: $('#autoCreateInput'),
  keyNote: $('#keyNote'),
  toastWrap: $('#toastWrap'),
  cursorGlow: $('#cursorGlow'),
  pages: $$('.page'),
  mainNav: $('.main-nav'),
  chatPane: $('#chatPane'),
  recentPane: $('#recentPane'),
  recentList: $('#recentList'),
  libraryBadge: $('#libraryBadge'),
  sitePrompt: $('#sitePrompt'),
  sitePromptCount: $('#sitePromptCount'),
  siteStyles: $('#siteStyles'),
  generateSiteBtn: $('#generateSiteBtn'),
  siteSurpriseBtn: $('#siteSurpriseBtn'),
  studioWorkspace: $('#studioWorkspace'),
  studioViewToggle: $('#studioViewToggle'),
  studioDeviceToggle: $('#studioDeviceToggle'),
  studioModelTag: $('#studioModelTag'),
  saveSiteBtn: $('#saveSiteBtn'),
  downloadSiteBtn: $('#downloadSiteBtn'),
  openSiteBtn: $('#openSiteBtn'),
  studioCanvas: $('#studioCanvas'),
  studioEmpty: $('#studioEmpty'),
  studioGenerating: $('#studioGenerating'),
  genTitle: $('#genTitle'),
  genProgressBar: $('#genProgressBar'),
  genSteps: $('#genSteps'),
  previewWrap: $('#previewWrap'),
  sitePreview: $('#sitePreview'),
  codeWrap: $('#codeWrap'),
  copySiteCode: $('#copySiteCode'),
  siteCode: $('#siteCode'),
  studioStatus: $('#studioStatus'),
  studioMeta: $('#studioMeta'),
  studioLed: $('#studioLed'),
  imagePrompt: $('#imagePrompt'),
  imageStyles: $('#imageStyles'),
  imageAspect: $('#imageAspect'),
  imageIdeas: $('#imageIdeas'),
  generateImageBtn: $('#generateImageBtn'),
  imageLimitNote: $('#imageLimitNote'),
  imageGrid: $('#imageGrid'),
  galleryEmpty: $('#galleryEmpty'),
  galleryCount: $('#galleryCount'),
  libraryTabs: $('#libraryTabs'),
  libraryContent: $('#libraryContent'),
  sitesCount: $('#sitesCount'),
  imagesCount: $('#imagesCount'),
  chatsCount: $('#chatsCount'),
  imageLightbox: $('#imageLightbox'),
  lightboxImage: $('#lightboxImage'),
  lightboxPrompt: $('#lightboxPrompt'),
  lightboxDownload: $('#lightboxDownload'),
  lightboxSave: $('#lightboxSave'),
  typeWord: $('#typeWord'),
  statsRow: $('#statsRow'),
};

const state = {
  chats: loadChats(),
  settings: loadSettings(),
  library: loadLibrary(),
  currentId: null,
  generating: false,
  controller: null,
  filter: '',
  envKeys: {},
  demoWarned: false,
  streamFrame: null,
  chatTimer: null,
  saveTimer: null,
  page: 'chat',
  site: null,
  siteStyle: 'dark',
  siteSavedId: null,
  studioGenerating: false,
  studioController: null,
  studioProgressTimer: null,
  studioView: 'preview',
  studioDevice: 'desktop',
  gallery: [],
  imageStyle: 'cinematic',
  imageAspect: '1:1',
  imagePending: 0,
  imageCooldownUntil: 0,
  imageCooldownTimer: null,
  libTab: 'sites',
  lightboxItem: null,
  featuresStarted: false,
  typeTimer: null,
  statsObserver: null,
};

/* ---------- Utilities ---------- */

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
    if (char === '&') return '&amp;';
    if (char === '<') return '&lt;';
    if (char === '>') return '&gt;';
    if (char === '"') return '&quot;';
    return '&#39;';
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function shortModel(id) {
  if (!id) return 'Модель не выбрана';
  const known = {
    [FREE_MODEL]: 'Lumio Free',
    'openai/gpt-6.2-astra-pro': 'GPT-6.2 Astra Pro',
    'openai/gpt-6.2-sol-pro': 'GPT-6.2 Sol Pro',
    'openai/gpt-6.2-astra-pro:batch': 'Astra Pro · batch',
    'openai/gpt-4o-mini': 'GPT-4o mini',
    'gpt-4o-mini': 'GPT-4o mini',
    'openai/gpt-4o': 'GPT-4o',
    'gpt-4o': 'GPT-4o',
    'gpt-4.1-mini': 'GPT-4.1 mini',
    'anthropic/claude-3.7-sonnet': 'Claude 3.7',
    'anthropic/claude-sonnet-4.5': 'Claude Sonnet 4.5',
    'claude-sonnet-4-5': 'Claude Sonnet 4.5',
    'claude-opus-4-1': 'Claude Opus 4.1',
    'claude-3-7-sonnet-latest': 'Claude 3.7',
    'claude-3-5-haiku-latest': 'Claude 3.5 Haiku',
    'google/gemini-2.0-flash-001': 'Gemini 2.0',
    'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'gemini-2.0-flash': 'Gemini 2.0',
    'deepseek/deepseek-chat': 'DeepSeek V3',
    'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3',
  };
  if (known[id]) return known[id];
  let name = id.split('/').pop().replace(/[-_]/g, ' ').replace(/:free$/, ' · free');
  if (name.length > 24) name = `${name.slice(0, 24)}…`;
  return name;
}

function loadChats() {
  try {
    const raw = JSON.parse(localStorage.getItem(dataKey('chats.v1')) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((chat) => chat && typeof chat.id === 'string' && Array.isArray(chat.messages))
      .map((chat) => ({
        id: chat.id,
        title: typeof chat.title === 'string' && chat.title.trim() ? chat.title : 'Диалог',
        createdAt: Number(chat.createdAt) || Date.now(),
        updatedAt: Number(chat.updatedAt) || Date.now(),
        messages: chat.messages
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
          .map((m) => ({
            id: typeof m.id === 'string' ? m.id : uid(),
            role: m.role,
            content: typeof m.content === 'string' ? m.content : '',
            ts: Number(m.ts) || Date.now(),
            error: typeof m.error === 'string' ? m.error : undefined,
            stopped: Boolean(m.stopped),
          })),
      }));
  } catch {
    return [];
  }
}

function loadSettings() {
  const base = {
    provider: 'free',
    apiKey: '',
    baseUrl: PROVIDERS.free.baseUrl,
    model: PROVIDERS.free.model,
    assistantName: 'Lumi',
    temperature: 0.7,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    autoCreate: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(dataKey('settings.v1')) || '{}');
    if (!saved || typeof saved !== 'object') return base;
    const provider = PROVIDERS[saved.provider] ? saved.provider : 'free';
    return {
      provider,
      assistantName:
        typeof saved.assistantName === 'string' && saved.assistantName.trim()
          ? saved.assistantName.trim().slice(0, 24)
          : 'Lumi',
      apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '',
      baseUrl:
        typeof saved.baseUrl === 'string' && saved.baseUrl.trim()
          ? saved.baseUrl.trim().replace(/\/+$/, '')
          : PROVIDERS[provider].baseUrl,
      model:
        typeof saved.model === 'string' && saved.model.trim()
          ? saved.model.trim()
          : PROVIDERS[provider].model,
      temperature: Number.isFinite(Number(saved.temperature))
        ? Math.min(1.5, Math.max(0, Number(saved.temperature)))
        : 0.7,
      systemPrompt:
        typeof saved.systemPrompt === 'string' && saved.systemPrompt.trim()
          ? saved.systemPrompt
          : DEFAULT_SYSTEM_PROMPT,
      autoCreate: saved.autoCreate !== false,
    };
  } catch {
    return base;
  }
}

function saveChats() {
  try {
    localStorage.setItem(dataKey('chats.v1'), JSON.stringify(state.chats));
  } catch {
    /* storage is full or unavailable */
  }
}

function saveChatsSoon() {
  if (state.saveTimer) return;
  state.saveTimer = setTimeout(() => {
    state.saveTimer = null;
    saveChats();
  }, 500);
}

function saveSettings() {
  try {
    localStorage.setItem(dataKey('settings.v1'), JSON.stringify(state.settings));
  } catch {
    toast('Не удалось сохранить настройки', 'Хранилище браузера недоступно или переполнено.', 'error');
  }
}

function saveLastChat() {
  try {
    if (state.currentId) localStorage.setItem(dataKey('last.v1'), state.currentId);
    else localStorage.removeItem(dataKey('last.v1'));
  } catch {
    /* ignore */
  }
}

function loadLibrary() {
  try {
    const raw = JSON.parse(localStorage.getItem(dataKey('library.v1')) || '{}');
    const sites = (Array.isArray(raw?.sites) ? raw.sites : [])
      .filter(
        (site) =>
          site &&
          typeof site.id === 'string' &&
          typeof site.html === 'string' &&
          site.html.toLowerCase().includes('<html')
      )
      .map((site) => ({
        id: site.id,
        title: typeof site.title === 'string' && site.title.trim() ? site.title.trim() : 'Сайт Lumio',
        prompt: typeof site.prompt === 'string' ? site.prompt : '',
        style: typeof site.style === 'string' ? site.style : 'dark',
        source: site.source === 'model' ? 'model' : 'demo',
        html: site.html,
        createdAt: Number(site.createdAt) || Date.now(),
      }))
      .slice(0, 12);
    const images = (Array.isArray(raw?.images) ? raw.images : [])
      .filter(
        (image) =>
          image &&
          typeof image.id === 'string' &&
          typeof image.url === 'string' &&
          (image.url.startsWith('/generated/') || image.url.startsWith('/api/image?')) &&
          typeof image.prompt === 'string'
      )
      .map((image) => ({
        id: image.id,
        prompt: image.prompt,
        style: typeof image.style === 'string' ? image.style : 'cinematic',
        aspect: IMAGE_ASPECTS[image.aspect] ? image.aspect : '1:1',
        width: Number(image.width) || 1024,
        height: Number(image.height) || 1024,
        seed: Number(image.seed) || 0,
        url: image.url,
        createdAt: Number(image.createdAt) || Date.now(),
      }))
      .slice(0, 40);
    return { sites, images };
  } catch {
    return { sites: [], images: [] };
  }
}

function saveLibrary() {
  try {
    localStorage.setItem(
      dataKey('library.v1'),
      JSON.stringify({
        sites: state.library.sites.slice(0, 12),
        images: state.library.images.slice(0, 40),
      })
    );
    return true;
  } catch {
    toast(
      'Хранилище переполнено',
      'Удалите несколько сохранённых сайтов или картинок, чтобы освободить место.',
      'error'
    );
    return false;
  }
}

function libraryCount() {
  return state.library.sites.length + state.library.images.length;
}

function currentChat() {
  return state.chats.find((chat) => chat.id === state.currentId) || null;
}

function hasProviderConnection() {
  const provider = state.settings.provider;
  if (provider === 'free') return true;
  if (provider === 'custom') return Boolean(state.settings.baseUrl);
  return Boolean(state.settings.apiKey || state.envKeys[provider]);
}

function isDemoMode() {
  return !hasProviderConnection();
}

function isFreeMode() {
  return state.settings.provider === 'free' || !hasProviderConnection();
}

function assistantName() {
  return state.settings.assistantName || 'Lumi';
}

function activeSystemPrompt() {
  return state.settings.systemPrompt.replace(/\b(?:Lumio|Auralis)\b/g, assistantName());
}

function applyAssistantName() {
  const name = assistantName();
  const welcome = $('#assistantNameWelcome');
  if (welcome) welcome.textContent = name;
  if (el.input) el.input.placeholder = `Спросите ${name} о чём угодно…`;
  const disclaimer = $('#assistantDisclaimer');
  if (disclaimer) disclaimer.textContent = `${name} может ошибаться. Проверяйте важную информацию.`;
}

/* ---------- Markdown ---------- */

const CODE_TOKEN = '@@AURALIS_CODE_';

function inlineMarkdown(text) {
  const codes = [];
  let out = text.replace(/`([^`\n]+)`/g, (match, code) => {
    codes.push(code);
    return `@@AURALIS_INLINE_${codes.length - 1}@@`;
  });

  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
  out = out.replace(
    /@@AURALIS_INLINE_(\d+)@@/g,
    (match, index) => `<code>${codes[Number(index)]}</code>`
  );
  return out;
}

function renderCodeBlock(block) {
  const label = escapeHtml((block.lang || 'code').slice(0, 24));
  return (
    '<div class="code-block">' +
    `<div class="code-head"><span class="code-lang">${label}</span>` +
    '<button class="code-copy" data-code-copy type="button">Копировать</button></div>' +
    `<pre><code>${escapeHtml(block.code)}</code></pre>` +
    '</div>'
  );
}

function splitTableRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) return false;
  const header = lines[index];
  const divider = lines[index + 1];
  if (!header.includes('|') || !divider.includes('|')) return false;
  if (!/^[\s|:-]+$/.test(divider) || !divider.includes('-')) return false;
  return splitTableRow(header).length === splitTableRow(divider).length;
}

function markdownToHtml(source) {
  if (!source) return '';
  const codeBlocks = [];
  let src = String(source).replace(/\r\n?/g, '\n');

  src = src.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({
      lang: (lang || '').trim().split(/\s+/)[0] || '',
      code: code.replace(/\n$/, ''),
    });
    return `\n\n${CODE_TOKEN}${index}@@\n\n`;
  });

  const escaped = escapeHtml(src);
  const lines = escaped.split('\n');
  const out = [];
  const tokenPattern = new RegExp(`^${escapeRegExp(CODE_TOKEN)}(\\d+)@@$`);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const codeMatch = line.match(tokenPattern);
    if (codeMatch) {
      out.push(renderCodeBlock(codeBlocks[Number(codeMatch[1])]));
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(Math.max(heading[1].length, 2), 4);
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      const parts = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        parts.push(lines[i].replace(/^&gt;\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote><p>${inlineMarkdown(parts.join('<br />'))}</p></blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const headerCells = splitTableRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${headerCells
        .map((cell) => `<th>${inlineMarkdown(cell)}</th>`)
        .join('')}</tr></thead>`;
      const tbody = rows.length
        ? `<tbody>${rows
            .map(
              (row) =>
                `<tr>${row
                  .slice(0, headerCells.length)
                  .map((cell) => `<td>${inlineMarkdown(cell)}</td>`)
                  .join('')}</tr>`
            )
            .join('')}</tbody>`
        : '';
      out.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const item = lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '');
        items.push(`<li>${inlineMarkdown(item)}</li>`);
        i += 1;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) break;
      if (/^(#{1,4})\s+/.test(next)) break;
      if (/^&gt;\s?/.test(next)) break;
      if (/^\s*([-*+]|\d+\.)\s+/.test(next)) break;
      if (tokenPattern.test(next)) break;
      if (next.includes('|') || isTableStart(lines, i)) break;
      paragraph.push(next);
      i += 1;
    }
    out.push(`<p>${inlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('\n');
}

/* ---------- Rendering ---------- */

function renderSidebar() {
  const query = state.filter.trim().toLowerCase();
  const chats = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const filtered = query
    ? chats.filter(
        (chat) =>
          chat.title.toLowerCase().includes(query) ||
          chat.messages.some((message) => message.content.toLowerCase().includes(query))
      )
    : chats;

  if (!filtered.length) {
    el.chatList.innerHTML = `<div class="chat-empty">${
      query ? 'Ничего не найдено' : 'Пока пусто.<br />Начните первый диалог — история появится здесь.'
    }</div>`;
    return;
  }

  el.chatList.innerHTML = filtered
    .map((chat) => {
      const active = chat.id === state.currentId ? ' active' : '';
      return `<div class="chat-item${active}" data-chat-id="${escapeHtml(chat.id)}" role="button" tabindex="0">
        <svg class="icon"><use href="#i-chat"/></svg>
        <span class="chat-item-title">${escapeHtml(chat.title)}</span>
        <button class="chat-del" data-del-id="${escapeHtml(chat.id)}" aria-label="Удалить диалог" title="Удалить диалог">
          <svg class="icon"><use href="#i-trash"/></svg>
        </button>
      </div>`;
    })
    .join('');
}

function renderTopbar() {
  const chat = currentChat();
  const isChat = state.page === 'chat';
  el.topbarTitle.textContent = isChat
    ? chat
      ? chat.title
      : 'Новый диалог'
    : PAGE_META[state.page]?.title || 'Lumio';
  el.exportBtn.disabled = !isChat || !chat || !chat.messages.length;
  el.exportBtn.hidden = !isChat;
  const label = shortModel(state.settings.model);
  el.modelLabel.textContent = label;
  el.composerModel.textContent = label;
}

function updateModeUI() {
  const free = isFreeMode();
  const connected = hasProviderConnection();
  el.keyCard.hidden = !free;
  el.modeChip.hidden = !free;
  el.modeChip.textContent = 'Free';
  el.heroStatus.classList.toggle('connected', connected);
  el.heroStatusText.textContent = free
    ? 'Lumio Free · работает без ключа'
    : `Подключено · ${shortModel(state.settings.model)}`;
}

function renderMessages() {
  const chat = currentChat();
  if (!chat || !chat.messages.length) {
    el.messages.innerHTML = '';
    el.messages.hidden = true;
    el.welcome.hidden = false;
    return;
  }

  el.welcome.hidden = true;
  el.messages.hidden = false;

  const lastIndex = chat.messages.length - 1;
  el.messages.innerHTML = chat.messages
    .map((message, index) => buildMessageHtml(message, index === lastIndex, index))
    .join('');
}

function buildImageCardHtml(message) {
  const image = message.image;
  if (!image || !image.url) return '';
  const prompt = escapeHtml(image.prompt || 'Изображение Lumio');
  const source = escapeHtml(image.source || 'Lumio');
  const download = imageDownloadUrl(image.url);
  return `<figure class="msg-image-card">
    <img src="${escapeHtml(image.url)}" alt="${prompt}" loading="lazy" decoding="async" />
    <figcaption class="msg-image-caption"><span>${prompt}</span><span>${source}</span></figcaption>
    <div class="msg-card-actions">
      <button class="msg-card-btn" type="button" data-action="open-image" data-msg-id="${escapeHtml(message.id)}"><svg class="icon"><use href="#i-maximize"/></svg> Открыть</button>
      <a class="msg-card-btn" href="${escapeHtml(download)}" download="auralis-image.jpg" target="_blank" rel="noopener"><svg class="icon"><use href="#i-download"/></svg> Скачать</a>
      <button class="msg-card-btn" type="button" data-action="save-image" data-msg-id="${escapeHtml(message.id)}"><svg class="icon"><use href="#i-bookmark"/></svg> В библиотеку</button>
    </div>
  </figure>`;
}

function buildSiteCardHtml(message) {
  const site = message.site;
  if (!site || !site.html) return '';
  const title = escapeHtml(site.title || 'Сайт Lumio');
  const meta = escapeHtml(
    site.modelLabel || (site.source === 'demo' ? 'резервный шаблон' : 'Lumio Studio')
  );
  const prompt = escapeHtml(String(site.prompt || '').replace(/\s+/g, ' ').slice(0, 180));
  const score = Number(site.adherence) || 0;
  const scoreBadge =
    score > 0 && score < 0.55
      ? '<span class="msg-site-warn">проверьте соответствие</span>'
      : score > 0
        ? `<span class="msg-site-score">${Math.round(score * 100)}% по промпту</span>`
        : '';
  return `<div class="msg-site-card">
    <div class="msg-site-head">
      <span class="msg-site-icon"><svg class="icon"><use href="#i-layout"/></svg></span>
      <div><strong>${title}</strong><small>${meta}</small></div>
      ${scoreBadge}
    </div>
    <p class="msg-site-prompt">${prompt}</p>
    <div class="msg-card-actions">
      <button class="msg-card-btn" type="button" data-action="open-site" data-msg-id="${escapeHtml(message.id)}"><svg class="icon"><use href="#i-external"/></svg> Открыть в студии</button>
      <button class="msg-card-btn" type="button" data-action="download-site" data-msg-id="${escapeHtml(message.id)}"><svg class="icon"><use href="#i-download"/></svg> Скачать HTML</button>
    </div>
  </div>`;
}

function imageDownloadUrl(url) {
  const value = String(url || '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    return `/api/image/download?url=${encodeURIComponent(value)}`;
  }
  return value;
}

function buildMessageHtml(message, isLast, index) {
  if (message.role === 'user') {
    return `<article class="msg msg-user" data-id="${escapeHtml(message.id)}" data-index="${index}">
      <div class="msg-body">
        <div class="msg-content user-content">${escapeHtml(message.content).replace(/\n/g, '<br />')}</div>
        ${message.stopped ? '<div class="msg-note">остановлено</div>' : ''}
      </div>
    </article>`;
  }

  const hasContent = Boolean(message.content && message.content.trim());
  const isStreaming = Boolean(message.streaming);
  const canRegenerate = isLast && !state.generating && !isStreaming;
  const thinkingLabel =
    message.kind === 'image'
      ? 'Рисую картинку'
      : message.kind === 'site'
        ? 'Собираю сайт'
        : 'Думаю над ответом';

  const contentHtml = hasContent
    ? `<div class="markdown">${markdownToHtml(message.content)}</div>`
    : message.error
      ? ''
      : isStreaming
        ? `<div class="thinking"><svg class="icon hourglass-icon" aria-hidden="true"><use href="#i-hourglass"/></svg><span>${thinkingLabel}</span><span class="think-time" data-think-time>0 с</span><span class="dots"><i></i><i></i><i></i></span></div>`
        : '';

  const imageHtml = message.image ? buildImageCardHtml(message) : '';
  const siteHtml = message.site ? buildSiteCardHtml(message) : '';
  const creationHtml = `${imageHtml}${siteHtml}`;

  const errorHtml = message.error
    ? `<div class="msg-error"><svg class="icon"><use href="#i-alert"/></svg><div>${escapeHtml(message.error)}</div></div>`
    : '';

  const actions = [];
  if (!isStreaming) {
    if (hasContent) {
      actions.push(
        `<button class="msg-action" data-action="copy" data-msg-id="${escapeHtml(message.id)}" title="Скопировать" aria-label="Скопировать ответ"><svg class="icon"><use href="#i-copy"/></svg></button>`
      );
    }
    if (canRegenerate) {
      actions.push(
        `<button class="msg-action" data-action="regen" data-msg-id="${escapeHtml(message.id)}" title="Сгенерировать заново" aria-label="Сгенерировать заново"><svg class="icon"><use href="#i-refresh"/></svg></button>`
      );
    }
  }

  return `<article class="msg msg-assistant${isStreaming ? ' streaming' : ''}" data-id="${escapeHtml(message.id)}" data-index="${index}">
    <div class="orb orb-avatar"></div>
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name">${escapeHtml(assistantName())}</span><span class="msg-dot">·</span><span class="msg-time">${formatTime(message.ts)}</span></div>
      ${contentHtml}
      ${creationHtml}
      ${errorHtml}
      ${message.stopped && hasContent ? '<div class="msg-note">остановлено</div>' : ''}
      ${actions.length ? `<div class="msg-actions">${actions.join('')}</div>` : ''}
    </div>
  </article>`;
}

function renderStage() {
  renderMessages();
  renderTopbar();
  requestAnimationFrame(() => scrollToBottom(false));
}

function renderAll() {
  applyAssistantName();
  renderSidebar();
  renderTopbar();
  renderMessages();
  updateModeUI();
  updateSendState();
  updateHero();
}

function updateHero() {
  updateModeUI();
}

function updateSendState() {
  if (state.generating) {
    el.sendBtn.disabled = false;
    el.sendBtn.classList.add('generating');
    el.sendBtn.setAttribute('aria-label', 'Остановить генерацию');
    el.composerHint.textContent = `${assistantName()} печатает… нажмите ■, чтобы остановить`;
  } else {
    el.sendBtn.classList.remove('generating');
    el.sendBtn.disabled = !el.input.value.trim();
    el.sendBtn.setAttribute('aria-label', 'Отправить');
    el.composerHint.textContent = 'Enter — отправить · Shift + Enter — новая строка';
  }
}

function updateModelMenu() {
  const provider = state.settings.provider;
  const current = state.settings.model;
  const presets = [...(MODEL_PRESETS[provider] || [])];

  if (current && !presets.some((item) => item.id === current)) {
    presets.unshift({ id: current, name: shortModel(current), desc: 'Текущая модель' });
  }
  if (!presets.length) {
    presets.push({ id: current || '', name: current || 'Модель не выбрана', desc: 'Укажите модель в настройках' });
  }

  el.modelMenuList.innerHTML = presets
    .map(
      (item) => `<button class="model-item${item.id === current ? ' active' : ''}" data-model="${escapeHtml(
        item.id
      )}" role="menuitem">
        <span class="model-item-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(
          item.desc || ''
        )}</small></span>
        <svg class="icon check"><use href="#i-check"/></svg>
      </button>`
    )
    .join('');
}

/* ---------- Chat actions ---------- */

function openChat(id) {
  if (state.generating) {
    toast('Идёт генерация', 'Остановите ответ или дождитесь завершения, чтобы переключить диалог.');
    return;
  }
  const chat = state.chats.find((item) => item.id === id);
  if (!chat) return;
  if (state.page !== 'chat') navigateToPage('chat');
  state.currentId = id;
  saveLastChat();
  closeSidebar();
  renderSidebar();
  renderTopbar();
  renderMessages();
  updateSendState();
  requestAnimationFrame(() => scrollToBottom(false));
}

function newChat() {
  if (state.generating) {
    toast('Идёт генерация', 'Сначала остановите текущий ответ.');
    return;
  }
  if (state.page !== 'chat') navigateToPage('chat');
  state.currentId = null;
  saveLastChat();
  closeSidebar();
  el.chatSearch.value = '';
  state.filter = '';
  renderSidebar();
  renderTopbar();
  renderMessages();
  updateSendState();
  el.input.focus();
}

function ensureChat(firstMessage) {
  const existing = currentChat();
  if (existing) return existing;

  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 56) || 'Новый диалог';
  const chat = {
    id: uid(),
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  state.chats.unshift(chat);
  state.currentId = chat.id;
  saveLastChat();
  saveChats();
  return chat;
}

function detectCreationIntent(text) {
  const lower = String(text || '').toLowerCase().replace(/ё/g, 'е');
  if (!lower.trim()) return null;

  const site =
    /(сделай|создай|собери|сверстай|сгенерируй|разработай|нужен|нужна)\b[^.!?\n]{0,110}?(сайт|лендинг|страниц|вебсайт|веб-сайт|одностраничник)/i.test(
      lower
    ) || /^(сайт|лендинг)\b/i.test(lower);

  const image =
    /(нарисуй|сгенерируй|создай|сделай|покажи)\b[^.!?\n]{0,110}?(картин|изображен|фото|фотк|рисун|арт|постер|иллюстрац|аватар|обложк|логотип|баннер)/i.test(
      lower
    ) ||
    /^нарисуй\b/i.test(lower) ||
    /^(картинка|изображение|фото)\b/i.test(lower);

  if (site && !image) return 'site';
  if (image && !site) return 'image';
  if (site && image) {
    return /сайт|лендинг|страниц/.test(lower) ? 'site' : 'image';
  }
  return null;
}

function extractImagePrompt(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  out = out.replace(
    /^(пожалуйста[,\s]*)?(нарисуй|сгенерируй|создай|сделай|покажи)(\s+мне)?\s+(картинку|картинка|изображение|фото|фотку|рисунок|арт|постер|иллюстрацию|аватар|обложку|логотип|баннер)\s*(с|со|на|в|про|где|как|для)?\s*/i,
    ''
  );
  out = out.replace(/^(нарисуй|сгенерируй)(\s+мне)?\s*/i, '');
  out = out.replace(/^(пожалуйста[,\s]*)/i, '').trim();
  if (out.length < 3) out = String(text || '').trim();
  return out.slice(0, 600);
}

async function fetchSiteFromServer(prompt, style, signal) {
  const response = await fetch('/api/site', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      style,
      provider: state.settings.provider,
      apiKey: state.settings.apiKey,
      baseUrl: state.settings.baseUrl,
      model: state.settings.model,
      temperature: state.settings.temperature,
    }),
    signal,
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : `Сервер не смог собрать сайт (${response.status}).`
    );
  }
  if (!data.html) throw new Error('Сервер не вернул HTML сайта.');
  return data;
}

function chatTimerLabel(verb) {
  return (startedAt) => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    el.composerHint.textContent = `${verb}… ${seconds} с · ■ остановить`;
    const clock = el.messages.querySelector('[data-think-time]');
    if (clock) clock.textContent = `${seconds} с`;
  };
}

async function requestImageInChat(chat, text) {
  if (state.generating) return;

  const assistant = {
    id: uid(),
    role: 'assistant',
    content: '',
    ts: Date.now(),
    streaming: true,
    kind: 'image',
  };
  chat.messages.push(assistant);
  chat.updatedAt = Date.now();

  state.generating = true;
  const controller = new AbortController();
  state.controller = controller;
  updateSendState();
  renderMessages();
  scrollToBottom(false);
  saveChatsSoon();

  const startedAt = Date.now();
  clearInterval(state.chatTimer);
  const tick = chatTimerLabel('Lumio рисует');
  state.chatTimer = setInterval(() => tick(startedAt), 500);

  const prompt = extractImagePrompt(text);
  const aspect = state.imageAspect || '1:1';
  const dimensions = IMAGE_ASPECTS[aspect] || IMAGE_ASPECTS['1:1'];
  const item = {
    id: uid(),
    prompt,
    style: state.imageStyle,
    aspect,
    width: dimensions.width,
    height: dimensions.height,
    seed: Math.floor(Math.random() * 900000) + 1000,
    url: '',
    status: 'pending',
    errorText: '',
    createdAt: Date.now(),
  };

  state.gallery.unshift(item);
  state.imagePending += 1;
  updateImageButtonState();
  replaceImageCard(item);
  updateGalleryUI();

  try {
    await requestImage(item, controller.signal, (updated) => {
      if (controller.signal.aborted) {
        assistant.stopped = true;
        assistant.streaming = false;
        return;
      }
      if (updated.status === 'ready') {
        assistant.image = {
          url: updated.url,
          prompt: updated.prompt,
          style: updated.style,
          aspect: updated.aspect,
          width: updated.width,
          height: updated.height,
          seed: updated.seed,
          source: updated.source || 'Lumio',
        };
        assistant.content = `Готово — картинка по запросу «${updated.prompt}».`;
      } else {
        assistant.error = updated.errorText || 'Не удалось создать изображение.';
      }
      assistant.streaming = false;
      chat.updatedAt = Date.now();
      saveChats();
      if (state.currentId === chat.id) {
        const shouldStick = nearBottom();
        renderMessages();
        if (shouldStick) scrollToBottom(false);
      }
    });
  } finally {
    clearInterval(state.chatTimer);
    state.chatTimer = null;
    assistant.streaming = false;
    if (controller.signal.aborted) {
      assistant.stopped = true;
      if (!assistant.image) {
        chat.messages = chat.messages.filter((message) => message.id !== assistant.id);
      }
    }
    state.generating = false;
    state.controller = null;
    chat.updatedAt = Date.now();
    saveChats();
    renderSidebar();
    renderTopbar();
    renderMessages();
    updateSendState();
    el.input.focus({ preventScroll: true });
  }
}

async function requestSiteInChat(chat, text) {
  if (state.generating) return;

  const style = state.siteStyle || 'dark';
  const assistant = {
    id: uid(),
    role: 'assistant',
    content: 'Собираю сайт по вашему описанию…',
    ts: Date.now(),
    streaming: true,
    kind: 'site',
  };
  chat.messages.push(assistant);
  chat.updatedAt = Date.now();

  state.generating = true;
  const controller = new AbortController();
  state.controller = controller;
  updateSendState();
  renderMessages();
  scrollToBottom(false);
  saveChatsSoon();

  const startedAt = Date.now();
  clearInterval(state.chatTimer);
  const tick = chatTimerLabel('Lumio собирает сайт');
  state.chatTimer = setInterval(() => tick(startedAt), 500);

  try {
    const data = await fetchSiteFromServer(text, style, controller.signal);
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const html = extractHtml(data.html) || String(data.html || '').trim();
    if (!html) throw new Error('Модель вернула пустой HTML.');

    const site = {
      title: titleFromHtml(html) || titleFromPrompt(text),
      prompt: text,
      style,
      html,
      source: 'model',
      modelLabel: data.model ? shortModel(data.model) : 'Lumio Free',
      model: data.model || '',
      endpoint: data.endpoint || '',
      adherence: Number(data.adherence) || 0,
      seconds: Number(data.seconds) || Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
      createdAt: Date.now(),
    };

    assistant.site = site;
    assistant.content = `Сайт готов: **${site.title}**. Откройте его в студии, чтобы посмотреть превью или скачать HTML.`;
    assistant.streaming = false;
    state.site = site;
    state.studioView = 'preview';
    renderStudio();

    const lowScore = site.adherence > 0 && site.adherence < 0.55;
    toast(
      lowScore ? 'Сайт собран — проверьте детали' : 'Сайт готов',
      lowScore
        ? 'Модель могла не полностью повторить запрос. Откройте превью и при необходимости пересоберите.'
        : 'Смотрите превью, скачивайте HTML или сохраняйте в библиотеку.',
      lowScore ? 'info' : 'success',
      { label: 'Открыть в студии', fn: () => openSiteInStudioFromMessage(assistant.id) }
    );
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      assistant.stopped = true;
      assistant.streaming = false;
      if (!assistant.site) {
        chat.messages = chat.messages.filter((message) => message.id !== assistant.id);
      }
    } else {
      const html = buildDemoSite(text, style);
      const site = {
        title: titleFromHtml(html) || titleFromPrompt(text),
        prompt: text,
        style,
        html,
        source: 'demo',
        modelLabel: 'резервный шаблон',
        adherence: 0,
        seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        createdAt: Date.now(),
      };
      assistant.site = site;
      assistant.content =
        'Модель не ответила, поэтому я собрал резервную страницу по вашему описанию. Её можно открыть в студии, скачать или попробовать ещё раз.';
      assistant.streaming = false;
      state.site = site;
      state.studioView = 'preview';
      renderStudio();
      toast(
        'Резервная страница',
        error?.message
          ? `Модель не ответила: ${error.message}`
          : 'Модель не ответила. Страница собрана по вашему промпту.',
        'info'
      );
    }
  } finally {
    clearInterval(state.chatTimer);
    state.chatTimer = null;
    assistant.streaming = false;
    state.generating = false;
    state.controller = null;
    chat.updatedAt = Date.now();
    saveChats();
    renderSidebar();
    renderTopbar();
    renderMessages();
    updateSendState();
    el.input.focus({ preventScroll: true });
  }
}

function openSiteInStudioFromMessage(messageId) {
  const chat = currentChat();
  const message = chat?.messages.find((item) => item.id === messageId);
  if (!message?.site) return;
  state.site = { ...message.site };
  state.studioView = 'preview';
  state.studioDevice = 'desktop';
  navigateToPage('studio');
  renderStudio();
  requestAnimationFrame(() => {
    el.studioWorkspace?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function downloadSiteFromMessage(messageId) {
  const chat = currentChat();
  const message = chat?.messages.find((item) => item.id === messageId);
  if (!message?.site?.html) return;
  const blob = new Blob([message.site.html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `auralis-site-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
  toast('HTML скачан', 'Файл сохранён на устройство.', 'success');
}

async function sendMessage() {
  if (state.generating) return;
  const text = el.input.value.trim();
  if (!text) return;

  if (!hasProviderConnection() && !state.demoWarned) {
    state.demoWarned = true;
    toast(
      'Lumio Free',
      'Ключ не указан, поэтому отвечает бесплатная модель. Для Claude, Gemini или GPT подключите ключ в настройках.',
      'info',
      { label: 'Настройки', fn: () => openSettings() }
    );
  }

  const chat = ensureChat(text);
  chat.messages.push({
    id: uid(),
    role: 'user',
    content: text,
    ts: Date.now(),
  });
  chat.updatedAt = Date.now();

  el.input.value = '';
  autosizeInput();
  updateSendState();
  renderSidebar();
  renderTopbar();
  scrollToBottom(false);
  saveChatsSoon();

  if (state.settings.autoCreate !== false) {
    const intent = detectCreationIntent(text);
    if (intent === 'image') {
      void requestImageInChat(chat, text);
      return;
    }
    if (intent === 'site') {
      void requestSiteInChat(chat, text);
      return;
    }
  }

  void requestCompletion(chat);
}

async function requestCompletion(chat) {
  if (state.generating) return;

  const assistant = {
    id: uid(),
    role: 'assistant',
    content: '',
    ts: Date.now(),
    streaming: true,
  };
  chat.messages.push(assistant);
  chat.updatedAt = Date.now();

  state.generating = true;
  state.controller = new AbortController();
  updateSendState();
  renderMessages();
  scrollToBottom(false);

  const startedAt = Date.now();
  clearInterval(state.chatTimer);
  state.chatTimer = setInterval(() => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    el.composerHint.textContent = `${assistantName()} думает… ${seconds} с · ■ остановить`;
    const clock = el.messages.querySelector('[data-think-time]');
    if (clock) clock.textContent = `${seconds} с`;
  }, 500);

  const history = chat.messages
    .filter((message) => message.id !== assistant.id)
    .filter((message) => typeof message.content === 'string' && message.content.trim())
    .filter((message) => !message.error)
    .slice(-30)
    .map((message) => ({ role: message.role, content: message.content }));

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: state.settings.provider,
        apiKey: state.settings.apiKey,
        baseUrl: state.settings.baseUrl,
        model: state.settings.model,
        temperature: state.settings.temperature,
        systemPrompt: activeSystemPrompt(),
        messages: history,
      }),
      signal: state.controller.signal,
    });

    if (!response.ok) {
      let message = `Ошибка ${response.status}`;
      try {
        const data = await response.json();
        if (data && typeof data.error === 'string') message = data.error;
      } catch {
        /* ignore */
      }
      if (response.status === 401) message += ' Проверьте API-ключ в настройках.';
      if (response.status === 429) message = `Слишком много запросов. ${message}`;
      throw new Error(message);
    }

    if (!response.body) throw new Error('Сервер вернул пустой ответ');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') continue;

        let data;
        try {
          data = JSON.parse(payload);
        } catch {
          continue;
        }

        if (data && data.error) {
          throw new Error(data.error.message || 'Модель вернула ошибку');
        }

        const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
        const delta = choice && choice.delta ? choice.delta.content : null;
        if (typeof delta === 'string' && delta) {
          assistant.content += delta;
          scheduleStreamUpdate(chat, assistant);
          saveChatsSoon();
        }
      }
    }

    if (!assistant.content.trim()) {
      throw new Error('Модель вернула пустой ответ. Попробуйте выбрать другую модель.');
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      assistant.stopped = true;
      if (!assistant.content.trim()) {
        chat.messages = chat.messages.filter((message) => message.id !== assistant.id);
      }
    } else {
      assistant.error = error && error.message ? error.message : 'Неизвестная ошибка';
    }
  } finally {
    clearInterval(state.chatTimer);
    state.chatTimer = null;
    if (state.streamFrame) {
      cancelAnimationFrame(state.streamFrame);
      state.streamFrame = null;
    }
    assistant.streaming = false;
    state.generating = false;
    state.controller = null;
    chat.updatedAt = Date.now();
    saveChats();

    const shouldStick = nearBottom();
    renderSidebar();
    renderTopbar();
    renderMessages();
    updateSendState();
    if (assistant.error) {
      toast('Не удалось получить ответ', assistant.error, 'error');
    }
    if (shouldStick) scrollToBottom(false);
    el.input.focus({ preventScroll: true });
  }
}

function scheduleStreamUpdate(chat, assistant) {
  if (state.streamFrame) return;
  state.streamFrame = requestAnimationFrame(() => {
    state.streamFrame = null;
    if (state.currentId !== chat.id) return;
    if (!assistant.streaming) return;
    const node = el.messages.querySelector(`.msg[data-id="${assistant.id}"]`);
    if (!node) return;

    const pinned = nearBottom();
    const thinking = node.querySelector('.thinking');
    let markdown = node.querySelector('.markdown');

    if (!markdown) {
      markdown = document.createElement('div');
      markdown.className = 'markdown';
      if (thinking) thinking.replaceWith(markdown);
      else node.querySelector('.msg-body').appendChild(markdown);
    }

    markdown.innerHTML = markdownToHtml(assistant.content);
    node.classList.add('streaming');

    if (pinned) el.stage.scrollTop = el.stage.scrollHeight;
  });
}

function stopGeneration() {
  if (state.controller) {
    state.controller.abort();
    toast('Генерация остановлена');
  }
}

function regenerate() {
  if (state.generating) return;
  const chat = currentChat();
  if (!chat || !chat.messages.length) return;

  const last = chat.messages[chat.messages.length - 1];
  if (!last || last.role !== 'assistant') return;

  chat.messages.pop();
  chat.updatedAt = Date.now();
  saveChats();
  renderMessages();
  void requestCompletion(chat);
}

function deleteChat(id) {
  const index = state.chats.findIndex((chat) => chat.id === id);
  if (index < 0) return;
  if (state.generating && state.currentId === id) {
    toast('Идёт генерация', 'Дождитесь ответа или остановите его перед удалением.');
    return;
  }

  const removed = state.chats[index];
  const wasCurrent = state.currentId === id;
  state.chats.splice(index, 1);

  if (wasCurrent) {
    state.currentId = state.chats[0] ? state.chats[0].id : null;
    saveLastChat();
  }

  saveChats();
  renderAll();

  toast('Диалог удалён', removed.title, 'info', {
    label: 'Отменить',
    fn: () => {
      state.chats.splice(Math.min(index, state.chats.length), 0, removed);
      if (wasCurrent) {
        state.currentId = removed.id;
        saveLastChat();
      }
      saveChats();
      renderAll();
    },
  });
}

function exportChat() {
  const chat = currentChat();
  if (!chat || !chat.messages.length) return;

  const header = `# ${chat.title}\n\n_Экспортировано из Lumio · ${new Date().toLocaleString('ru-RU')}_\n\n`;
  const body = chat.messages
    .filter((message) => message.content && message.content.trim())
    .map(
      (message) =>
        `## ${message.role === 'user' ? 'Вы' : assistantName()}\n\n${message.content}`
    )
    .join('\n\n---\n\n');

  const blob = new Blob([header + body], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `auralis-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
  toast('Диалог экспортирован', 'Markdown-файл сохранён.', 'success');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      return true;
    } catch {
      return false;
    }
  }
}

async function handleMessageClick(event) {
  const codeCopy = event.target.closest('[data-code-copy]');
  if (codeCopy) {
    const block = codeCopy.closest('.code-block');
    const code = block ? block.querySelector('code') : null;
    if (!code) return;
    const ok = await copyText(code.textContent || '');
    if (ok) {
      codeCopy.textContent = 'Скопировано';
      setTimeout(() => {
        codeCopy.textContent = 'Копировать';
      }, 1600);
    } else {
      toast('Не удалось скопировать', 'Выделите код вручную.', 'error');
    }
    return;
  }

  const action = event.target.closest('[data-action]');
  if (!action) return;
  const chat = currentChat();
  if (!chat) return;

  if (action.dataset.action === 'copy') {
    const message = chat.messages.find((item) => item.id === action.dataset.msgId);
    if (!message) return;
    const ok = await copyText(message.content);
    toast(
      ok ? 'Скопировано' : 'Не удалось скопировать',
      ok ? 'Ответ в буфере обмена.' : 'Выделите текст вручную.',
      ok ? 'success' : 'error'
    );
  }

  if (action.dataset.action === 'regen') {
    regenerate();
  }
}

/* ---------- Composer ---------- */

function autosizeInput() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 190)}px`;
}

function scrollToBottom(smooth) {
  requestAnimationFrame(() => {
    el.stage.scrollTo({
      top: el.stage.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  });
}

function nearBottom() {
  return el.stage.scrollHeight - el.stage.scrollTop - el.stage.clientHeight < 140;
}

function insertAtCursor(text) {
  const input = el.input;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
  const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
  input.value = `${before}${prefix}${text}${suffix}${after}`;
  const caret = (before + prefix + text).length;
  input.setSelectionRange(caret, caret);
  autosizeInput();
  updateSendState();
  input.focus();
}

async function handleFile(file) {
  if (!file) return;
  if (file.size > 300 * 1024) {
    toast('Файл слишком большой', 'Максимум 300 КБ. Для больших файлов вставьте нужный фрагмент.', 'error');
    return;
  }
  try {
    const text = await file.text();
    if (!text.trim()) {
      toast('Файл пустой', 'Нечего добавлять.', 'error');
      return;
    }
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    const lang = LANG_BY_EXT[extension] || '';
    const fence = text.includes('```') ? '````' : '```';
    const safeName = file.name.replace(/[\r\n`]/g, ' ').slice(0, 120);
    insertAtCursor(`**Файл: ${safeName}**\n${fence}${lang}\n${text}\n${fence}\n`);
    toast('Файл добавлен', safeName, 'success');
  } catch {
    toast('Не удалось прочитать файл', 'Попробуйте другой файл.', 'error');
  }
}

/* ---------- Sidebar / mobile ---------- */

function openSidebar() {
  el.sidebar.classList.add('open');
  el.scrim.classList.add('show');
}

function closeSidebar() {
  el.sidebar.classList.remove('open');
  el.scrim.classList.remove('show');
}

/* ---------- Model menu ---------- */

function openModelMenu() {
  updateModelMenu();
  el.modelMenu.hidden = false;
  el.modelBtn.setAttribute('aria-expanded', 'true');
}

function closeModelMenu() {
  el.modelMenu.hidden = true;
  el.modelBtn.setAttribute('aria-expanded', 'false');
}

function toggleModelMenu() {
  if (el.modelMenu.hidden) openModelMenu();
  else closeModelMenu();
}

/* ---------- Settings ---------- */

function updateProviderNote() {
  const provider = el.providerSelect.value;
  const meta = PROVIDERS[provider] || PROVIDERS.openrouter;
  el.apiKeyInput.placeholder = meta.keyPlaceholder;
  el.keyNote.textContent = meta.note;

  const modelNotes = {
    free:
      'Lumio Free не требует ключа. Доступны Inkling 2 mini и GPT-6.2 (если канал открыт без оплаты). Если бесплатная модель занята, Lumio автоматически подключит резервный бесплатный канал.',
    openrouter:
      'Можно ввести любое имя модели. У OpenRouter есть бесплатные модели с суффиксом :free — просто добавьте его к имени.',
    anthropic:
      'Например: claude-sonnet-4-5, claude-opus-4-1 или claude-3-5-haiku-latest. Точные имена доступны в документации Anthropic.',
    gemini:
      'Например: gemini-2.5-flash или gemini-2.5-pro. Список моделей можно загрузить по кнопке выше.',
    openai: 'Можно ввести любое имя модели, доступное вашему аккаунту OpenAI.',
    custom:
      'Имя модели должно совпадать с тем, что поддерживает ваш сервер. Например: llama3.2, mistral или local-model.',
  };
  el.modelNote.textContent = modelNotes[provider] || modelNotes.openrouter;
}

function fillSettingsForm(settings) {
  el.providerSelect.value = settings.provider;
  el.assistantNameInput.value = settings.assistantName || 'Lumi';
  el.apiKeyInput.value = settings.apiKey;
  el.modelInput.value = settings.model;
  el.baseUrlInput.value = settings.baseUrl;
  el.temperatureInput.value = String(settings.temperature);
  el.tempValue.textContent = Number(settings.temperature).toFixed(1);
  el.systemPromptInput.value = settings.systemPrompt;
  if (el.autoCreateInput) el.autoCreateInput.checked = settings.autoCreate !== false;
  el.apiKeyInput.type = 'password';
  el.toggleKey.innerHTML = '<svg class="icon"><use href="#i-eye"/></svg>';
  el.toggleKey.setAttribute('aria-label', 'Показать ключ');
  updateProviderNote();
}

function openSettings(focusModel = false) {
  fillSettingsForm(state.settings);
  el.settingsModal.hidden = false;
  closeModelMenu();
  closeSidebar();
  requestAnimationFrame(() => {
    if (focusModel) {
      el.modelInput.focus();
      el.modelInput.select();
    } else {
      el.settingsClose.focus();
    }
  });
}

function closeSettings() {
  el.settingsModal.hidden = true;
  el.apiKeyInput.type = 'password';
}

function saveSettingsFromForm() {
  const provider = el.providerSelect.value;
  const meta = PROVIDERS[provider] || PROVIDERS.openrouter;
  const baseUrl = (el.baseUrlInput.value.trim() || meta.baseUrl).replace(/\/+$/, '');
  const model = el.modelInput.value.trim() || meta.model;

  if (provider === 'custom' && !baseUrl) {
    toast('Укажите Base URL', 'Для своего API нужен адрес, например http://localhost:11434/v1.', 'error');
    const details = $('.advanced');
    if (details) details.open = true;
    el.baseUrlInput.focus();
    return;
  }

  if (!model) {
    toast('Укажите модель', 'Введите имя модели, например openai/gpt-4o-mini.', 'error');
    el.modelInput.focus();
    return;
  }

  state.settings = {
    provider,
    assistantName: el.assistantNameInput.value.trim().slice(0, 24) || 'Lumi',
    apiKey: el.apiKeyInput.value.trim(),
    baseUrl,
    model,
    temperature: Math.min(1.5, Math.max(0, Number(el.temperatureInput.value) || 0)),
    systemPrompt: el.systemPromptInput.value.trim() || DEFAULT_SYSTEM_PROMPT,
    autoCreate: el.autoCreateInput ? el.autoCreateInput.checked : true,
  };

  saveSettings();
  closeSettings();
  applyAssistantName();
  renderTopbar();
  renderMessages();
  updateModeUI();
  updateModelMenu();

  if (isFreeMode()) {
    toast(
      'Настройки сохранены',
      'Будет отвечать Lumio Free — без ключа. Для Claude, Gemini или GPT добавьте ключ и выберите провайдера.',
      'success'
    );
  } else {
    toast('Настройки сохранены', 'Модель подключена. Можно общаться.', 'success');
  }
}

function resetSettingsForm() {
  fillSettingsForm({
    provider: 'free',
    assistantName: 'Lumi',
    apiKey: '',
    baseUrl: PROVIDERS.free.baseUrl,
    model: PROVIDERS.free.model,
    temperature: 0.7,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    autoCreate: true,
  });
  toast('Форма сброшена', 'Нажмите «Сохранить», чтобы применить.', 'info');
}

async function loadModels() {
  const provider = el.providerSelect.value;
  const meta = PROVIDERS[provider] || PROVIDERS.openrouter;
  const baseUrl = (el.baseUrlInput.value.trim() || meta.baseUrl).replace(/\/+$/, '');
  el.loadModelsBtn.disabled = true;
  const original = el.loadModelsBtn.textContent;
  el.loadModelsBtn.textContent = 'Загрузка…';

  try {
    const response = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        apiKey: el.apiKeyInput.value.trim(),
        baseUrl,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);

    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) throw new Error('Провайдер не вернул ни одной модели');

    el.modelOptions.innerHTML = models
      .map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || '')}</option>`)
      .join('');
    toast('Модели загружены', `Доступно моделей: ${models.length}. Начните вводить имя в поле «Модель».`, 'success');
  } catch (error) {
    toast('Не удалось загрузить модели', error.message || 'Проверьте ключ и Base URL.', 'error');
  } finally {
    el.loadModelsBtn.disabled = false;
    el.loadModelsBtn.textContent = original;
  }
}

/* ---------- Space navigation ---------- */

const SITE_STYLE_LABELS = {
  dark: 'Тёмный',
  light: 'Светлый',
  neon: 'Неон',
  glass: 'Стекло',
  minimal: 'Минимализм',
};

const IMAGE_STYLE_LABELS = {
  cinematic: 'Кинематограф',
  photo: 'Фото',
  '3d': '3D',
  anime: 'Аниме',
  neon: 'Неон',
  minimal: 'Минимализм',
};

function formatDate(timestamp) {
  try {
    return new Date(timestamp).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return '';
  }
}

function pluralRu(count, one, few, many) {
  const n = Math.abs(count) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function updateLibraryBadge() {
  if (!el.libraryBadge) return;
  const count = libraryCount();
  el.libraryBadge.textContent = String(count);
  el.libraryBadge.hidden = count === 0;
}

function renderRecent() {
  if (!el.recentList) return;
  const items = [
    ...state.library.sites.map((site) => ({ type: 'site', item: site })),
    ...state.library.images.map((image) => ({ type: 'image', item: image })),
  ]
    .sort((a, b) => b.item.createdAt - a.item.createdAt)
    .slice(0, 7);

  const tip = el.recentPane.querySelector('.recent-tip');
  if (!items.length) {
    el.recentList.innerHTML = '';
    if (tip) tip.hidden = false;
    return;
  }
  if (tip) tip.hidden = true;

  el.recentList.innerHTML = items
    .map(({ type, item }) => {
      const isSite = type === 'site';
      const title = isSite
        ? item.title
        : item.prompt.replace(/\s+/g, ' ').trim().slice(0, 48);
      const meta = isSite
        ? `Сайт · ${SITE_STYLE_LABELS[item.style] || 'Тёмный'}`
        : `Картинка · ${IMAGE_STYLE_LABELS[item.style] || 'Кинематограф'}`;
      const visual = isSite
        ? '<span class="recent-thumb-ph"><svg class="icon"><use href="#i-layout"/></svg></span>'
        : `<img class="recent-thumb" src="${escapeHtml(item.url)}" alt="" loading="lazy" />`;
      return `<button class="recent-item" data-recent-type="${type}" data-recent-id="${escapeHtml(item.id)}" type="button">
        ${visual}
        <span class="recent-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta)}</small></span>
      </button>`;
    })
    .join('');
}

function refreshReveals() {
  if (!('IntersectionObserver' in window)) {
    $$('.reveal').forEach((node) => node.classList.add('in'));
    return;
  }
  if (!state.revealObserver) {
    state.revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            state.revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.06, rootMargin: '0px 0px -24px 0px' }
    );
  }
  $$('.reveal:not(.in)').forEach((node) => {
    state.revealObserver.unobserve(node);
    state.revealObserver.observe(node);
  });
  setTimeout(() => {
    $$('.page.active .reveal:not(.in)').forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.top < window.innerHeight * 1.02 && rect.bottom > 0) {
        node.classList.add('in');
      }
    });
  }, 140);
}

function navigateToPage(page, options = {}) {
  if (!PAGE_META[page]) page = 'chat';
  state.page = page;

  el.pages.forEach((section) => {
    const active = section.dataset.page === page;
    section.hidden = !active;
    section.classList.toggle('active', active);
  });

  $$('.nav-item', el.mainNav).forEach((item) => {
    const active = item.dataset.pageLink === page;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });

  el.chatPane.hidden = page !== 'chat';
  el.recentPane.hidden = page === 'chat';

  if (page !== 'chat') renderRecent();
  renderTopbar();
  updateModeUI();
  closeModelMenu();

  if (page === 'studio') renderStudio();
  if (page === 'images') renderImageGrid();
  if (page === 'library') renderLibrary();
  if (page === 'features') startFeatures();

  document.title =
    page === 'chat'
      ? 'Lumio — AI-студия: чат, сайты, картинки'
      : `${PAGE_META[page].title} · Lumio`;

  if (options.updateHash !== false && location.hash !== `#${page}`) {
    try {
      history.pushState({ page }, '', `#${page}`);
    } catch {
      location.hash = page;
    }
  }

  closeSidebar();
  refreshReveals();

  if (page === 'chat') {
    requestAnimationFrame(() => scrollToBottom(false));
    if (window.matchMedia('(min-width: 901px)').matches) {
      setTimeout(() => {
        if (state.page === 'chat') el.input.focus({ preventScroll: true });
      }, 80);
    }
  }
}

function initNavigation() {
  const raw = location.hash.replace(/^#/, '');
  const initial = PAGE_META[raw] ? raw : 'chat';
  navigateToPage(initial, { updateHash: false });
  if (!location.hash) {
    try {
      history.replaceState({ page: 'chat' }, '', '#chat');
    } catch {
      /* ignore */
    }
  }
  window.addEventListener('popstate', () => {
    const page = location.hash.replace(/^#/, '');
    navigateToPage(PAGE_META[page] ? page : 'chat', { updateHash: false });
  });
}

function initCursorGlow() {
  if (!el.cursorGlow) return;
  if (!window.matchMedia('(pointer: fine)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let raf = null;
  let x = window.innerWidth / 2;
  let y = window.innerHeight / 2;
  window.addEventListener(
    'pointermove',
    (event) => {
      x = event.clientX;
      y = event.clientY;
      el.cursorGlow.classList.add('active');
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        el.cursorGlow.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      });
    },
    { passive: true }
  );
  document.addEventListener('mouseleave', () => el.cursorGlow.classList.remove('active'));
}

/* ---------- Library ---------- */

function renderLibrary() {
  if (!el.libraryContent) return;
  const counts = {
    sites: state.library.sites.length,
    images: state.library.images.length,
    chats: state.chats.length,
  };
  el.sitesCount.textContent = String(counts.sites);
  el.imagesCount.textContent = String(counts.images);
  el.chatsCount.textContent = String(counts.chats);
  el.libraryTabs.querySelectorAll('[data-lib-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.libTab === state.libTab);
  });

  if (state.libTab === 'sites') {
    if (!state.library.sites.length) {
      el.libraryContent.innerHTML = libraryEmptyHtml(
        'sites',
        'Пока ни одного сайта',
        'Соберите первую страницу в студии — она появится здесь и будет доступна после перезагрузки.',
        'Открыть студию',
        'studio'
      );
      return;
    }
    el.libraryContent.innerHTML = `<div class="library-grid">${state.library.sites
      .map(
        (site) => `<article class="library-card" data-site-card="${escapeHtml(site.id)}">
          <div class="site-thumb">
            <div class="site-thumb-bar"><i></i><i></i><i></i></div>
            <span class="site-thumb-title">${escapeHtml(site.title)}</span>
            <span class="site-thumb-style">${escapeHtml(SITE_STYLE_LABELS[site.style] || 'Сайт')}</span>
          </div>
          <div class="library-info">
            <strong>${escapeHtml(site.title)}</strong>
            <span>${site.source === 'model' ? 'Сгенерирован моделью' : 'Демо-шаблон'} · ${formatDate(site.createdAt)}</span>
          </div>
          <div class="library-actions">
            <button class="lib-btn" data-lib-open-site="${escapeHtml(site.id)}" type="button"><svg class="icon"><use href="#i-external"/></svg> Открыть</button>
            <button class="lib-btn danger" data-lib-del-site="${escapeHtml(site.id)}" type="button" aria-label="Удалить сайт"><svg class="icon"><use href="#i-trash"/></svg></button>
          </div>
        </article>`
      )
      .join('')}</div>`;
    return;
  }

  if (state.libTab === 'images') {
    if (!state.library.images.length) {
      el.libraryContent.innerHTML = libraryEmptyHtml(
        'images',
        'Галерея ждёт первую идею',
        'Сгенерируйте изображение и нажмите «В библиотеку» — картинка сохранится в этом браузере.',
        'Открыть галерею',
        'images'
      );
      return;
    }
    el.libraryContent.innerHTML = `<div class="library-image-grid">${state.library.images
      .map(
        (image) => `<article class="library-image">
          <img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.prompt)}" loading="lazy" data-lib-preview-image="${escapeHtml(image.id)}" />
          <div class="library-image-bar">
            <p title="${escapeHtml(image.prompt)}">${escapeHtml(image.prompt)}</p>
            <button class="lib-btn" data-lib-download-image="${escapeHtml(image.id)}" type="button" aria-label="Скачать"><svg class="icon"><use href="#i-download"/></svg></button>
            <button class="lib-btn danger" data-lib-del-image="${escapeHtml(image.id)}" type="button" aria-label="Удалить"><svg class="icon"><use href="#i-trash"/></svg></button>
          </div>
        </article>`
      )
      .join('')}</div>`;
    return;
  }

  if (!state.chats.length) {
    el.libraryContent.innerHTML = libraryEmptyHtml(
      'chats',
      'Диалогов пока нет',
      'Начните разговор с Lumio — история автоматически сохранится и появится в архиве.',
      'Открыть чат',
      'chat'
    );
    return;
  }

  const chats = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  el.libraryContent.innerHTML = `<div class="library-chat-list">${chats
    .map((chat) => {
      const last = [...chat.messages].reverse().find((message) => message.content?.trim());
      const preview = last
        ? last.content
            .replace(/```[\s\S]*?```/g, ' [код] ')
            .replace(/[#*_`>]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 130)
        : 'Пустой диалог';
      const messageLabel = `${chat.messages.length} ${pluralRu(chat.messages.length, 'сообщение', 'сообщения', 'сообщений')}`;
      return `<article class="library-chat" data-lib-chat="${escapeHtml(chat.id)}">
        <span class="library-chat-icon"><svg class="icon"><use href="#i-chat"/></svg></span>
        <div class="library-chat-copy">
          <strong>${escapeHtml(chat.title)}</strong>
          <span>${messageLabel} · ${formatDate(chat.updatedAt)} — ${escapeHtml(preview)}</span>
        </div>
        <button class="lib-btn danger" data-lib-del-chat="${escapeHtml(chat.id)}" type="button" aria-label="Удалить диалог"><svg class="icon"><use href="#i-trash"/></svg></button>
        <button class="lib-btn" data-lib-open-chat="${escapeHtml(chat.id)}" type="button">Открыть</button>
      </article>`;
    })
    .join('')}</div>`;
}

function libraryEmptyHtml(type, title, text, cta, page) {
  const icon = type === 'images' ? 'i-image' : type === 'sites' ? 'i-layout' : 'i-chat';
  return `<div class="library-empty">
    <span class="library-empty-icon"><svg class="icon"><use href="#${icon}"/></svg></span>
    <strong>${escapeHtml(title)}</strong>
    <p>${escapeHtml(text)}</p>
    <button class="btn-outline" data-go="${page}" type="button">${escapeHtml(cta)}</button>
  </div>`;
}

function openLibrarySite(id) {
  const site = state.library.sites.find((item) => item.id === id);
  if (!site) return;
  state.site = { ...site, libraryId: site.id };
  state.siteStyle = site.style || 'dark';
  state.studioView = 'preview';
  el.sitePrompt.value = site.prompt || '';
  updateSitePromptCount();
  setActiveChip(el.siteStyles, 'siteStyle', state.siteStyle);
  navigateToPage('studio');
  if (state.page === 'studio') {
    el.studioStatus.textContent = 'Открыто из библиотеки';
    el.studioMeta.textContent = `${Math.round(site.html.length / 1024)} КБ · ${formatDate(site.createdAt)}`;
  }
}

function deleteLibrarySite(id) {
  const index = state.library.sites.findIndex((item) => item.id === id);
  if (index < 0) return;
  const removed = state.library.sites[index];
  state.library.sites.splice(index, 1);
  saveLibrary();
  renderLibrary();
  renderRecent();
  updateLibraryBadge();
  if (state.site && state.site.libraryId === id) {
    state.site = { ...state.site };
    delete state.site.libraryId;
  }
  toast('Сайт удалён', removed.title, 'info', {
    label: 'Отменить',
    fn: () => {
      state.library.sites.splice(Math.min(index, state.library.sites.length), 0, removed);
      saveLibrary();
      renderLibrary();
      renderRecent();
      updateLibraryBadge();
    },
  });
}

function deleteLibraryImage(id) {
  const index = state.library.images.findIndex((item) => item.id === id);
  if (index < 0) return;
  const removed = state.library.images[index];
  state.library.images.splice(index, 1);
  saveLibrary();
  renderLibrary();
  renderRecent();
  updateLibraryBadge();
  toast('Картинка удалена', 'Изображение убрано из библиотеки.', 'info', {
    label: 'Отменить',
    fn: () => {
      state.library.images.splice(Math.min(index, state.library.images.length), 0, removed);
      saveLibrary();
      renderLibrary();
      renderRecent();
      updateLibraryBadge();
    },
  });
}

function handleLibraryClick(event) {
  const openSite = event.target.closest('[data-lib-open-site]');
  if (openSite) {
    openLibrarySite(openSite.dataset.libOpenSite);
    return;
  }
  const delSite = event.target.closest('[data-lib-del-site]');
  if (delSite) {
    deleteLibrarySite(delSite.dataset.libDelSite);
    return;
  }
  const preview = event.target.closest('[data-lib-preview-image]');
  if (preview) {
    const image = state.library.images.find((item) => item.id === preview.dataset.libPreviewImage);
    if (image) openLightbox(image);
    return;
  }
  const download = event.target.closest('[data-lib-download-image]');
  if (download) {
    const image = state.library.images.find((item) => item.id === download.dataset.libDownloadImage);
    if (image) downloadImageFile(image);
    return;
  }
  const delImage = event.target.closest('[data-lib-del-image]');
  if (delImage) {
    deleteLibraryImage(delImage.dataset.libDelImage);
    return;
  }
  const openChatLink = event.target.closest('[data-lib-open-chat]');
  if (openChatLink) {
    openChat(openChatLink.dataset.libOpenChat);
    return;
  }
  const delChatLink = event.target.closest('[data-lib-del-chat]');
  if (delChatLink) {
    deleteChat(delChatLink.dataset.libDelChat);
    setTimeout(renderLibrary, 20);
    return;
  }
  const row = event.target.closest('[data-lib-chat]');
  if (row) openChat(row.dataset.libChat);
}

function initRecent() {
  if (!el.recentList) return;
  el.recentList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-recent-id]');
    if (!item) return;
    if (item.dataset.recentType === 'site') {
      openLibrarySite(item.dataset.recentId);
      return;
    }
    const image = state.library.images.find((entry) => entry.id === item.dataset.recentId);
    if (image) openLightbox(image);
  });
}

/* ---------- Lightbox ---------- */

function openLightbox(item) {
  if (!item) return;
  state.lightboxItem = item;
  el.lightboxImage.src = item.url;
  el.lightboxImage.alt = item.prompt || 'Сгенерированное изображение';
  el.lightboxPrompt.textContent = item.prompt || '';
  const saved = state.library.images.some((image) => image.url === item.url);
  el.lightboxSave.innerHTML = saved
    ? '<svg class="icon"><use href="#i-check"/></svg> В библиотеке'
    : '<span class="btn-shine"></span><svg class="icon"><use href="#i-bookmark"/></svg> В библиотеку';
  el.imageLightbox.hidden = false;
  closeModelMenu();
  closeSidebar();
}

function closeLightbox() {
  el.imageLightbox.hidden = true;
  state.lightboxItem = null;
}

/* ---------- Image actions ---------- */

async function downloadImageFile(item) {
  if (!item) return;
  try {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error('Не удалось загрузить изображение');
    const blob = await response.blob();
    const mimeSubtype = blob.type.split('/')[1] || 'jpg';
    const extension = mimeSubtype.includes('svg')
      ? 'svg'
      : mimeSubtype.replace('jpeg', 'jpg').replace('+xml', '');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `auralis-${item.seed || Date.now()}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast('Изображение скачано', 'Файл сохранён на устройство.', 'success');
  } catch (error) {
    toast('Не удалось скачать', error.message || 'Попробуйте ещё раз.', 'error');
  }
}

function saveImageToLibrary(item) {
  if (!item) return false;
  if (state.library.images.some((image) => image.url === item.url)) {
    toast('Уже в библиотеке', 'Это изображение уже сохранено.', 'info');
    return true;
  }
  const saved = {
    id: uid(),
    prompt: item.prompt,
    style: item.style,
    aspect: item.aspect,
    width: item.width,
    height: item.height,
    seed: item.seed,
    url: item.url,
    createdAt: Date.now(),
  };
  state.library.images.unshift(saved);
  if (!saveLibrary()) {
    state.library.images.shift();
    return false;
  }
  updateLibraryBadge();
  renderRecent();
  $$('.image-card', el.imageGrid).forEach((card) => {
    if (card.dataset.imageId === item.id) card.classList.add('saved');
  });
  if (state.lightboxItem === item) {
    el.lightboxSave.innerHTML =
      '<svg class="icon"><use href="#i-check"/></svg> В библиотеке';
  }
  toast('Сохранено в библиотеку', 'Картинка доступна в разделе «Библиотека».', 'success');
  return true;
}

function handleImageAction(item, action) {
  if (!item) return;
  if (action === 'download') {
    void downloadImageFile(item);
  } else if (action === 'save') {
    saveImageToLibrary(item);
  } else if (action === 'expand') {
    openLightbox(item);
  }
}



/* ---------- Studio ---------- */

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setActiveChip(container, datasetKey, value) {
  if (!container) return;
  Array.from(container.querySelectorAll('button')).forEach((button) => {
    button.classList.toggle('active', button.dataset[datasetKey] === value);
  });
}

function updateSitePromptCount() {
  const length = el.sitePrompt.value.length;
  el.sitePromptCount.textContent = `${length} / 500`;
}

function titleFromPrompt(prompt) {
  const source = String(prompt || '').replace(/\s+/g, ' ').trim();
  const quoted = source.match(/[«"“]([^»"”]{2,44})[»"”]/);
  if (quoted) return quoted[1].trim().slice(0, 52);
  let cleaned = source
    .replace(/^(сделай|создай|сгенерируй|собери)\s+(сайт|лендинг|страницу)\s*(для|про)?\s*/i, '')
    .replace(/^(сайт|лендинг|страница)\s*(для|про)?\s*/i, '')
    .trim();
  if (!cleaned) cleaned = source || 'Сайт Lumio';
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`.slice(0, 52);
}

function titleFromHtml(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  return match[1].replace(/\s+/g, ' ').trim().slice(0, 70);
}

function extractHtml(text) {
  let source = String(text || '').trim();
  const fence = source.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) source = fence[1].trim();
  const start = source.search(/<!DOCTYPE html|<html[\s>]/i);
  if (start > 0) source = source.slice(start);
  const end = source.toLowerCase().lastIndexOf('</html>');
  if (end >= 0) source = source.slice(0, end + 7);
  if (!/<html[\s>]/i.test(source)) return null;

  // Модель иногда обрывает последние закрывающие теги. Не выбрасываем
  // почти готовый сайт и не заменяем его шаблоном — аккуратно закрываем документ.
  if (!/<\/html>/i.test(source)) {
    if (/<style[\s>]/i.test(source) && !/<\/style>/i.test(source)) source += '\n</style>';
    if (/<script[\s>]/i.test(source) && !/<\/script>/i.test(source)) source += '\n</script>';
    if (!/<\/body>/i.test(source)) source += '\n</body>';
    source += '\n</html>';
  }
  return source.trim();
}

function setStudioButtonBusy(busy) {
  const span = el.generateSiteBtn.querySelector('span:last-of-type');
  if (span) span.textContent = busy ? 'Остановить' : 'Собрать сайт';
  el.generateSiteBtn.classList.toggle('busy', busy);
}

function updateStudioControls() {
  const has = Boolean(state.site) && !state.studioGenerating;
  const saved = Boolean(state.site?.libraryId);
  el.saveSiteBtn.disabled = !has;
  el.downloadSiteBtn.disabled = !has;
  el.openSiteBtn.disabled = !has;
  const saveLabel = el.saveSiteBtn.querySelector('span');
  if (saveLabel) saveLabel.textContent = saved ? 'Сохранено' : 'Сохранить';
  if (has) {
    const label =
      state.site.source === 'model'
        ? state.site.modelLabel || shortModel(state.settings.model)
        : 'резервный шаблон';
    el.studioModelTag.textContent = label;
  } else if (!state.studioGenerating) {
    el.studioModelTag.textContent = isFreeMode()
      ? 'Lumio Free'
      : shortModel(state.settings.model);
  }
}

function renderStudio() {
  if (!el.studioCanvas) return;
  setActiveChip(el.studioViewToggle, 'view', state.studioView);
  setActiveChip(el.studioDeviceToggle, 'device', state.studioDevice);
  el.studioCanvas.dataset.device = state.studioDevice;

  if (state.studioGenerating) {
    el.studioEmpty.hidden = true;
    el.studioGenerating.hidden = false;
    el.previewWrap.hidden = true;
    el.codeWrap.hidden = true;
    updateStudioControls();
    return;
  }

  el.studioGenerating.hidden = true;
  updateStudioControls();

  if (!state.site) {
    el.studioEmpty.hidden = false;
    el.previewWrap.hidden = true;
    el.codeWrap.hidden = true;
    el.studioStatus.textContent = 'Готов к работе';
    el.studioMeta.textContent = isFreeMode()
      ? 'Lumio Free · без ключа'
      : `${shortModel(state.settings.model)} · готов к генерации`;
    el.studioLed.className = 'status-led';
    return;
  }

  const site = state.site;
  el.studioEmpty.hidden = true;
  el.siteCode.textContent = site.html;
  if (state.studioView === 'code') {
    el.previewWrap.hidden = true;
    el.codeWrap.hidden = false;
  } else {
    el.codeWrap.hidden = true;
    el.previewWrap.hidden = false;
    el.sitePreview.srcdoc = site.html;
  }

  el.saveSiteBtn.disabled = false;
  el.downloadSiteBtn.disabled = false;
  el.openSiteBtn.disabled = false;
  el.saveSiteBtn.querySelector('span').textContent = site.libraryId ? 'Сохранено' : 'Сохранить';
  el.studioStatus.textContent =
    el.studioStatus.textContent === 'Открыто из библиотеки'
      ? 'Открыто из библиотеки'
      : site.source === 'model'
        ? 'Сайт готов'
        : 'Демо-шаблон готов';
  if (!el.studioStatus.textContent) el.studioStatus.textContent = 'Сайт готов';
  el.studioMeta.textContent = `${Math.max(1, Math.round(site.html.length / 1024))} КБ · ${formatDate(site.createdAt)}`;
  el.studioLed.className = 'status-led on';
}

const STUDIO_STEPS = [
  'Lumio анализирует идею',
  'Собирает структуру страницы',
  'Подбирает палитру и шрифты',
  'Добавляет анимации',
  'Полирует детали',
];

function paintStudioProgress(step) {
  const labels = el.genSteps.querySelectorAll('[data-step]');
  labels.forEach((label, index) => label.classList.toggle('active', index <= step));
  el.genTitle.textContent = STUDIO_STEPS[Math.min(step, STUDIO_STEPS.length - 1)];
  const widths = [14, 34, 56, 76, 90];
  el.genProgressBar.style.width = `${widths[Math.min(step, widths.length - 1)]}%`;
}

function startStudioProgress() {
  clearInterval(state.studioProgressTimer);
  let step = 0;
  paintStudioProgress(step);
  state.studioProgressTimer = setInterval(() => {
    step = Math.min(step + 1, STUDIO_STEPS.length - 1);
    paintStudioProgress(step);
  }, 950);
}

function stopStudioProgress() {
  clearInterval(state.studioProgressTimer);
  state.studioProgressTimer = null;
  el.genProgressBar.style.width = '100%';
}

function cancelStudioGeneration() {
  if (!state.studioGenerating) return;
  state.studioJob = (state.studioJob || 0) + 1;
  state.studioGenerating = false;
  if (state.studioController) state.studioController.abort();
  state.studioController = null;
  stopStudioProgress();
  setStudioButtonBusy(false);
  renderStudio();
  toast('Сборка остановлена', 'Измените описание и попробуйте снова.', 'info');
}

function buildStudioRequest(prompt, style) {
  const styleLabel = SITE_STYLE_LABELS[style] || 'современный';
  const system = [
    'Ты — Lumio Site Builder, сильный веб-дизайнер и фронтенд-разработчик.',
    'Создай законченный одностраничный сайт на русском языке по описанию пользователя.',
    'Верни ТОЛЬКО полный HTML-документ, начиная с <!DOCTYPE html> и заканчивая </html>.',
    'Без markdown-ограждений, без комментариев и текста до или после документа.',
    'Используй inline <style> и, если нужны интерактив или анимации при скролле, inline <script>.',
    'Никаких внешних JS-библиотек и сборщиков. Можно подключить Google Fonts и изображения Unsplash по прямым https-ссылкам.',
    'Дизайн должен быть современным, дорогим и адаптивным: продуманная типографика, воздух, аккуратная сетка, состояния наведения, плавные анимации и мобильная версия.',
    'Обязательно добавь <meta name="viewport" content="width=device-width, initial-scale=1">, осмысленный <title> и содержательные тексты без lorem ipsum.',
    'Не используй localStorage и не пытайся обращаться к родительской странице.',
  ].join(' ');
  const content = [
    `Собери сайт по описанию: ${prompt}`,
    `Визуальный стиль: ${styleLabel}.`,
    'Сделай несколько полноценных секций: первый экран, преимущества или услуги, галерея/примеры, финальный призыв к действию и футер.',
    'Добавь заметный визуальный акцент на первом экране и 2–4 деликатные анимации. Сайт должен выглядеть как работа топовой студии.',
  ].join('\n');
  return { system, content };
}

async function requestSiteFromModel(prompt, style, signal, override = null) {
  const request = buildStudioRequest(prompt, style);
  const provider = override?.provider || state.settings.provider;
  const meta = PROVIDERS[provider] || PROVIDERS.free;
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      apiKey: override ? '' : state.settings.apiKey,
      baseUrl: override?.baseUrl || state.settings.baseUrl || meta.baseUrl,
      model: override?.model || state.settings.model || meta.model,
      temperature: Math.min(1.4, Math.max(0.5, state.settings.temperature)),
      systemPrompt: request.system,
      messages: [{ role: 'user', content: request.content }],
    }),
    signal,
  });

  if (!response.ok) {
    let message = `Ошибка ${response.status}`;
    try {
      const data = await response.json();
      if (data?.error) message = typeof data.error === 'string' ? data.error : data.error.message;
    } catch {
      /* ignore */
    }
    if (response.status === 401) message += ' Проверьте API-ключ в настройках.';
    throw new Error(message);
  }
  if (!response.body) throw new Error('Сервер вернул пустой ответ');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data?.error) {
        throw new Error(data.error.message || 'Модель вернула ошибку');
      }
      const delta = data?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) text += delta;
    }
  }
  if (!text.trim()) throw new Error('Модель вернула пустой ответ');
  return {
    text,
    fallback: response.headers.get('X-Lumio-Fallback') === 'free',
  };
}

async function generateSite() {
  if (state.studioGenerating) {
    cancelStudioGeneration();
    return;
  }

  const prompt = el.sitePrompt.value.replace(/\s+/g, ' ').trim();
  if (!prompt) {
    toast('Опишите сайт', 'Например: лендинг для кофейни в тёмном минимализме.', 'info');
    el.sitePrompt.focus();
    return;
  }

  const style = state.siteStyle;
  const job = (state.studioJob || 0) + 1;
  state.studioJob = job;
  state.studioGenerating = true;
  state.studioController = new AbortController();
  const started = Date.now();

  setStudioButtonBusy(true);
  el.studioEmpty.hidden = true;
  el.previewWrap.hidden = true;
  el.codeWrap.hidden = true;
  el.studioGenerating.hidden = false;
  el.studioLed.className = 'status-led busy';
  el.studioStatus.textContent = 'Lumio собирает сайт…';
  el.studioMeta.textContent = 'Ключ не нужен · обычно 20–60 секунд';
  startStudioProgress();
  updateStudioControls();
  requestAnimationFrame(() => {
    el.studioWorkspace.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  let fallbackUsed = false;
  let usedFree = state.settings.provider === 'free' || isFreeMode();

  try {
    let raw = '';
    try {
      const result = await requestSiteFromModel(prompt, style, state.studioController.signal);
      raw = result.text;
      if (result.fallback) usedFree = true;
    } catch (error) {
      if (error?.name === 'AbortError' || job !== state.studioJob) return;
      if (state.settings.provider !== 'free') {
        try {
          const result = await requestSiteFromModel(prompt, style, state.studioController.signal, {
            provider: 'free',
            model: FREE_MODEL,
            baseUrl: PROVIDERS.free.baseUrl,
          });
          if (job !== state.studioJob) return;
          raw = result.text;
          usedFree = true;
        } catch (freeError) {
          if (freeError?.name === 'AbortError' || job !== state.studioJob) return;
        }
      }
    }

    if (job !== state.studioJob) return;
    const html = raw ? extractHtml(raw) : null;
    let site;
    if (html) {
      site = {
        title: titleFromHtml(html) || titleFromPrompt(prompt),
        prompt,
        style,
        html,
        source: 'model',
        modelLabel: usedFree ? 'Lumio Free' : shortModel(state.settings.model),
        createdAt: Date.now(),
      };
    } else {
      fallbackUsed = true;
      site = {
        title: titleFromPrompt(prompt),
        prompt,
        style,
        html: buildDemoSite(prompt, style),
        source: 'demo',
        modelLabel: 'резервный шаблон',
        createdAt: Date.now(),
      };
    }

    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    state.site = site;
    state.studioGenerating = false;
    state.studioController = null;
    state.studioView = 'preview';
    stopStudioProgress();
    setStudioButtonBusy(false);
    el.sitePrompt.value = prompt;
    updateSitePromptCount();
    renderStudio();
    el.studioStatus.textContent = fallbackUsed ? 'Резервный шаблон готов' : 'Сайт готов';
    el.studioMeta.textContent = `${Math.max(1, Math.round(site.html.length / 1024))} КБ · ${seconds} с`;
    el.studioLed.className = 'status-led on';
    toast(
      fallbackUsed ? 'Показан резервный шаблон' : 'Сайт готов',
      fallbackUsed
        ? 'Модель не ответила, поэтому включили резервный шаблон. Можно скачать HTML или попробовать снова.'
        : 'Смотрите превью, скачивайте HTML или сохраняйте в библиотеку.',
      fallbackUsed ? 'info' : 'success'
    );
  } catch (error) {
    if (error?.name === 'AbortError' || job !== state.studioJob) return;
    state.studioGenerating = false;
    state.studioController = null;
    stopStudioProgress();
    setStudioButtonBusy(false);
    renderStudio();
    toast('Не удалось собрать сайт', error.message || 'Попробуйте ещё раз.', 'error');
  } finally {
    if (job === state.studioJob) {
      state.studioGenerating = false;
      state.studioController = null;
      setStudioButtonBusy(false);
    }
  }
}

function saveSiteToLibrary() {
  if (!state.site) return;
  if (state.site.html.length > 320000) {
    toast('Сайт слишком большой', 'Не получилось сохранить HTML в браузере. Скачайте файл.', 'error');
    return;
  }

  let index = state.site.libraryId
    ? state.library.sites.findIndex((item) => item.id === state.site.libraryId)
    : state.library.sites.findIndex((item) => item.html === state.site.html);

  const item = {
    id: index >= 0 ? state.library.sites[index].id : uid(),
    title: state.site.title,
    prompt: state.site.prompt,
    style: state.site.style,
    source: state.site.source,
    html: state.site.html,
    createdAt: state.site.createdAt || Date.now(),
  };

  if (index >= 0) state.library.sites.splice(index, 1, item);
  else state.library.sites.unshift(item);
  state.library.sites = state.library.sites.slice(0, 12);
  state.site.libraryId = item.id;

  if (!saveLibrary()) return;
  updateLibraryBadge();
  renderRecent();
  renderStudio();
  toast(
    index >= 0 ? 'Сайт обновлён' : 'Сайт сохранён',
    'Он появился в библиотеке и останется после перезагрузки.',
    'success'
  );
}

function downloadSiteHtml() {
  if (!state.site) return;
  const blob = new Blob([state.site.html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `auralis-site-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
  toast('HTML скачан', 'Откройте файл в браузере или загрузите на хостинг.', 'success');
}

function openSiteInNewTab() {
  if (!state.site) return;
  const blob = new Blob([state.site.html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  if (!win) toast('Всплывающее окно заблокировано', 'Разрешите всплывающие окна или скачайте HTML.', 'info');
}

function fillRandomIdea() {
  let idea = SITE_IDEAS[Math.floor(Math.random() * SITE_IDEAS.length)];
  if (SITE_IDEAS.length > 1 && idea.prompt === el.sitePrompt.value) {
    idea = SITE_IDEAS[(SITE_IDEAS.indexOf(idea) + 1) % SITE_IDEAS.length];
  }
  el.sitePrompt.value = idea.prompt;
  state.siteStyle = idea.style;
  setActiveChip(el.siteStyles, 'siteStyle', state.siteStyle);
  updateSitePromptCount();
  el.sitePrompt.focus();
}


const NICHE_BRANDS = {
  coffee: ['Север', 'Пар', 'Чёрный', 'Ферма', 'Утро'],
  photo: ['Кадр', 'Свет', 'Плёнка', 'Момент', 'Ракурс'],
  game: ['Nova', 'Orbit', 'Void', 'Pixel', 'Echo'],
  ai: ['Nexa', 'Synapse', 'Lumen', 'Axon', 'Orbit'],
  restaurant: ['Соль', 'Огонь', 'Терраса', 'Вкус', 'Тепло'],
  fitness: ['Ритм', 'Импульс', 'Форма', 'Тонус', 'Движение'],
  travel: ['Атлас', 'Маршрут', 'Горизонт', 'Ветер', 'Вершина'],
  beauty: ['Сияние', 'Лотос', 'Атлас', 'Тон', 'Свет'],
  education: ['Орбита', 'Курс', 'Знание', 'Вектор', 'Смысл'],
  finance: ['Капитал', 'Ось', 'Поток', 'Контур', 'Баланс'],
  realestate: ['Квартал', 'Этаж', 'Дом', 'Ось', 'Простор'],
  medical: ['Пульс', 'Забота', 'Клиника', 'Ритм', 'Здоровье'],
  music: ['Волна', 'Сцена', 'Тон', 'Резонанс', 'Нота'],
  shop: ['Полка', 'Маркет', 'Стиль', 'Форма', 'Выбор'],
  design: ['Контур', 'Форма', 'Студия', 'Простор', 'Линия'],
  default: ['Aster', 'Nova', 'Atlas', 'Lumen', 'Orion'],
};

const NICHE_CONTENT = {
  coffee: {
    nav: ['Меню', 'Атмосфера', 'Бронь'],
    cta: 'Забронировать',
    worksNav: 'меню',
    worksKicker: 'Меню',
    worksTitle: 'Напитки, которые<br><em>стоят ритуала</em>',
    worksLead: 'От эспрессо до авторских фильтров. Зерно обжариваем рядом, рецепты проверяем каждый день.',
    works: [
      ['Эспрессо', 'Классика'],
      ['Фильтр', 'Ручная работа'],
      ['Северный латте', 'Авторский'],
    ],
    approachKicker: 'Философия',
    approachTitle: 'Просто.<br><em>Точно. С любовью.</em>',
    features: [
      ['Обжарка рядом', 'Небольшие партии, понятная дата обжарки и вкус, который не нужно объяснять.'],
      ['Ритуал, не спешка', 'Свет, музыка и тишина между глотками. Здесь можно просто быть.'],
      ['Место встречи', 'Большие столы, розетки у окон и люди, к которым хочется вернуться.'],
    ],
    stats: [['12', 'сортов зерна'], ['7:30', 'открываемся'], ['4.9', 'рейтинг гостей']],
    ticker: ['ОБЖАРКА', 'РИТУАЛ', 'ЗЕРНО', 'ВОДА', 'ТЕПЛО'],
    visualTitle: 'Кофе как ритуал',
    visualSub: 'зерно · вода · тепло',
    finalKicker: 'Бронирование',
    finalTitle: 'Утро начинается<br><em>с хорошего кофе.</em>',
    finalText: 'Оставьте заявку — подготовим стол, расскажем о свежей обжарке и сохраним ваше любимое место.',
    finalCta: 'Забронировать стол',
    footerNote: 'Обжарка и кофе ежедневно',
  },
  photo: {
    nav: ['Работы', 'Подход', 'Контакты'],
    cta: 'Обсудить съёмку',
    worksNav: 'работы',
    worksKicker: 'Избранное',
    worksTitle: 'Истории,<br><em>пойманные в кадре</em>',
    worksLead: 'Портреты, бренды и живые моменты. Свет, характер и детали, которые не хочется терять.',
    works: [
      ['Серия «Тишина»', 'Портрет'],
      ['Кампания / Forma', 'Бренд'],
      ['Город после дождя', 'Репортаж'],
    ],
    approachKicker: 'Подход',
    approachTitle: 'Меньше шума.<br><em>Больше характера.</em>',
    features: [
      ['Сначала разговор', 'Понимаю задачу и настроение до первого кадра. Так получается честнее.'],
      ['Свет и ритм', 'Работаю с естественным светом, движением и паузами между ними.'],
      ['Результат без лишнего', 'Аккуратная обработка, понятные сроки и файлы, готовые к публикации.'],
    ],
    stats: [['120+', 'съёмок'], ['8 лет', 'практики'], ['48 ч', 'первый отбор']],
    ticker: ['СВЕТ', 'ХАРАКТЕР', 'МОМЕНТ', 'ДЕТАЛИ', 'ИСТОРИЯ'],
    visualTitle: 'Визуальные истории',
    visualSub: 'свет · движение · смысл',
    finalKicker: 'Следующий кадр',
    finalTitle: 'Давайте поймаем<br><em>что-то настоящее.</em>',
    finalText: 'Расскажите о съёмке — предложу формат, свет и идею, которые подойдут именно вам.',
    finalCta: 'Обсудить съёмку',
    footerNote: 'Портреты · бренды · репортаж',
  },
  game: {
    nav: ['Мир', 'Фичи', 'Wishlist'],
    cta: 'В Wishlist',
    worksNav: 'мир',
    worksKicker: 'Вселенная',
    worksTitle: 'Мир, в который<br><em>хочется вернуться</em>',
    worksLead: 'Исследование, атмосфера и история на стыке жанров. Каждый уголок хранит свою тайну.',
    works: [
      ['Забытая орбита', 'Локация'],
      ['Сигнал из глубины', 'Сюжет'],
      ['Ночной рейд', 'Геймплей'],
    ],
    approachKicker: 'Создание',
    approachTitle: 'Атмосфера.<br><em>Свобода. Смысл.</em>',
    features: [
      ['Мир без указателей', 'Исследуйте в своём ритме — история реагирует на любопытство.'],
      ['Живой звук', 'Динамическая музыка и шум среды, которые меняются вместе с миром.'],
      ['Выбор с последствиями', 'Решения меняют маршрут, союзников и финал.'],
    ],
    stats: [['12', 'локаций'], ['40+', 'часов'], ['2026', 'релиз']],
    ticker: ['КОСМОС', 'ТАЙНА', 'ВЫБОР', 'РИСК', 'СВОБОДА'],
    visualTitle: 'Новая вселенная',
    visualSub: 'исследование · риск · свобода',
    finalKicker: 'Ранний доступ',
    finalTitle: 'Мир уже ждёт.<br><em>Добавьте в Wishlist.</em>',
    finalText: 'Подпишитесь на новости — покажем первые геймплейные кадры и позовём в закрытый тест.',
    finalCta: 'Добавить в Wishlist',
    footerNote: 'Инди-игра · PC · 2026',
  },
  ai: {
    nav: ['Продукт', 'Возможности', 'Тарифы'],
    cta: 'Попробовать',
    worksNav: 'возможности',
    worksKicker: 'Продукт',
    worksTitle: 'Сложное становится<br><em>почти невидимым</em>',
    worksLead: 'Один интерфейс для задач, которые раньше требовали команды, времени и десятка инструментов.',
    works: [
      ['Анализ данных', 'Автоматизация'],
      ['Тексты и код', 'Ассистент'],
      ['Маршруты решений', 'Планирование'],
    ],
    approachKicker: 'Подход',
    approachTitle: 'Технологии<br><em>с человеческим ритмом.</em>',
    features: [
      ['Быстрый старт', 'Без сложной настройки: подключите данные и получите первый результат.'],
      ['Прозрачная логика', 'Показываем, на чём основан вывод, и оставляем решение за вами.'],
      ['Растёт вместе с вами', 'От личной задачи до командного процесса — без смены инструмента.'],
    ],
    stats: [['3 мин', 'до результата'], ['99.9%', 'доступность'], ['24/7', 'поддержка']],
    ticker: ['ДАННЫЕ', 'КОНТЕКСТ', 'РЕШЕНИЕ', 'СКОРОСТЬ', 'ЯСНОСТЬ'],
    visualTitle: 'Новый интеллект',
    visualSub: 'данные · контекст · действие',
    finalKicker: 'Начните сейчас',
    finalTitle: 'Меньше рутины.<br><em>Больше решений.</em>',
    finalText: 'Попробуйте бесплатно — покажем, как Lumio берёт рутину на себя и освобождает время.',
    finalCta: 'Попробовать бесплатно',
    footerNote: 'AI-продукт · без сложной настройки',
  },
  restaurant: {
    nav: ['Меню', 'Атмосфера', 'Бронь'],
    cta: 'Забронировать',
    worksNav: 'меню',
    worksKicker: 'Кухня',
    worksTitle: 'Вкус, который<br><em>остаётся в памяти</em>',
    worksLead: 'Сезонные продукты, честная кухня и тёплый свет. Меню меняется вместе с сезоном.',
    works: [
      ['Ужин «Терраса»', 'Сет'],
      ['Огонь и дым', 'Гриль'],
      ['Сезонный десерт', 'Финал'],
    ],
    approachKicker: 'Философия',
    approachTitle: 'Простота.<br><em>Вкус. Атмосфера.</em>',
    features: [
      ['Продукт в центре', 'Работаем с локальными поставщиками и не прячем вкус за соусами.'],
      ['Свет и музыка', 'Тёплый интерьер, живой свет и музыка, которая не мешает разговору.'],
      ['Повод вернуться', 'Новое меню каждый сезон и любимые блюда, которые остаются.'],
    ],
    stats: [['24', 'места'], ['18:00', 'открываемся'], ['4.8', 'рейтинг гостей']],
    ticker: ['СЕЗОН', 'ОГОНЬ', 'ВКУС', 'ТЕПЛО', 'ВЕЧЕР'],
    visualTitle: 'Гастрономия',
    visualSub: 'продукт · огонь · вечер',
    finalKicker: 'Бронирование',
    finalTitle: 'Вечер, который<br><em>хочется продлить.</em>',
    finalText: 'Забронируйте стол — подготовим место, расскажем о сезонном меню и сохраним ваш вечер.',
    finalCta: 'Забронировать стол',
    footerNote: 'Сезонная кухня · ежедневно',
  },
  fitness: {
    nav: ['Программы', 'Подход', 'Запись'],
    cta: 'Начать',
    worksNav: 'программы',
    worksKicker: 'Программы',
    worksTitle: 'Сила начинается<br><em>с привычки</em>',
    worksLead: 'Тренировки, которые подстраиваются под ваш ритм, тело и цель. Без перегрузки и лишнего шума.',
    works: [
      ['Утро / 20 мин', 'Мобильность'],
      ['Сила / 45 мин', 'База'],
      ['Восстановление', 'Йога'],
    ],
    approachKicker: 'Подход',
    approachTitle: 'Движение<br><em>без насилия над собой.</em>',
    features: [
      ['Сначала тело', 'Смотрим на самочувствие и подбираем нагрузку без универсальных шаблонов.'],
      ['Понятный прогресс', 'Каждые две недели — контрольные точки и корректировка плана.'],
      ['Ритм жизни', 'Короткие и длинные тренировки на выбор, чтобы спорт не вытеснял жизнь.'],
    ],
    stats: [['20', 'минут в день'], ['3', 'формата'], ['4.9', 'рейтинг']],
    ticker: ['СИЛА', 'РИТМ', 'ДЫХАНИЕ', 'ФОКУС', 'ПРИВЫЧКА'],
    visualTitle: 'Новая привычка',
    visualSub: 'сила · ритм · дыхание',
    finalKicker: 'Первый шаг',
    finalTitle: 'Начните с<br><em>одной тренировки.</em>',
    finalText: 'Оставьте заявку — подберём первую программу под ваш ритм и ответим на вопросы.',
    finalCta: 'Записаться',
    footerNote: 'Тренировки · восстановление · онлайн',
  },
  travel: {
    nav: ['Маршруты', 'Места', 'Бронь'],
    cta: 'Выбрать тур',
    worksNav: 'маршруты',
    worksKicker: 'Маршруты',
    worksTitle: 'Места, где время<br><em>замедляется</em>',
    worksLead: 'Горы, вода и тишина. Маршруты, в которых есть место и приключению, и отдыху.',
    works: [
      ['Высокий маршрут', 'Горы'],
      ['Тихая вода', 'Озёра'],
      ['Северный лес', 'Экспедиция'],
    ],
    approachKicker: 'Подход',
    approachTitle: 'Дорога<br><em>без суеты.</em>',
    features: [
      ['Продуманный ритм', 'Достаточно времени на места, а не только на переезды между ними.'],
      ['Маленькие группы', 'Больше воздуха, внимания и свободы для каждого путешественника.'],
      ['Местные детали', 'Гиды, которые знают не только достопримечательности, но и людей.'],
    ],
    stats: [['12', 'маршрутов'], ['7 дней', 'средний тур'], ['4.9', 'оценка гостей']],
    ticker: ['ГОРЫ', 'ВОДА', 'ЛЕС', 'ТИШИНА', 'МАРШРУТ'],
    visualTitle: 'Новые маршруты',
    visualSub: 'горы · вода · тишина',
    finalKicker: 'Бронирование',
    finalTitle: 'Маршрут, о котором<br><em>вы расскажете.</em>',
    finalText: 'Расскажите, какой отдых вам ближе — подберём маршрут, даты и компанию.',
    finalCta: 'Выбрать маршрут',
    footerNote: 'Путешествия · малые группы',
  },
  default: {
    nav: ['Проект', 'Подход', 'Контакты'],
    cta: 'Обсудить',
    worksNav: 'проекты',
    worksKicker: 'Избранное',
    worksTitle: 'Работы, в которых<br><em>есть характер</em>',
    worksLead: 'Идея, форма и детали. Небольшая подборка проектов, в которых есть что запомнить.',
    works: [
      ['Визуальный код', 'Айдентика'],
      ['Digital experience', 'Сайт'],
      ['Кампания «Ритм»', 'Контент'],
    ],
    approachKicker: 'Подход',
    approachTitle: 'Меньше шума.<br><em>Больше смысла.</em>',
    features: [
      ['Скорость без спешки', 'Сначала разбираемся в задаче, затем находим самое точное решение.'],
      ['Характер в деталях', 'Типографика, ритм, микродвижения и паузы создают живой продукт.'],
      ['Результат, который работает', 'Думаем о смысле, структуре и том, что человек унесёт с собой.'],
    ],
    stats: [['01', 'авторский подход'], ['100%', 'внимания к деталям'], ['24/7', 'на связи']],
    ticker: ['ДИЗАЙН', 'ХАРАКТЕР', 'ДВИЖЕНИЕ', 'ДЕТАЛИ', 'ЭМОЦИИ'],
    visualTitle: 'Визуальный опыт',
    visualSub: 'дизайн · движение · смысл',
    finalKicker: 'Следующий шаг',
    finalTitle: 'Давайте сделаем<br><em>что-то заметное.</em>',
    finalText: 'Расскажите идею — Lumio уже собрал эту страницу, чтобы показать, с чего можно начать.',
    finalCta: 'Обсудить проект',
    footerNote: 'Сгенерировано в Lumio Studio',
  },
};

const GENERIC_BRAND_WORDS = new Set([
  'кофейни', 'кофейня', 'кафе', 'ресторана', 'ресторан', 'бара', 'бар', 'кухни',
  'фотографа', 'фотограф', 'портфолио', 'фотостудии', 'студии', 'студия',
  'сервиса', 'сервис', 'ai', 'ии', 'нейросети', 'технологии', 'технологий',
  'игры', 'игра', 'гейма', 'гейм', 'курорта', 'курорт', 'отеля', 'отель',
  'путешествий', 'путешествия', 'туров', 'тура', 'фитнеса', 'фитнес',
  'дизайнера', 'дизайнер', 'магазина', 'магазин', 'школы', 'школа',
  'клиники', 'клиника', 'лендинг', 'лендинга', 'сайт', 'сайта', 'страницы',
  'проекта', 'проект', 'бренда', 'бренд', 'компании', 'компания',
]);

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function pickForPrompt(list, prompt) {
  return list[hashString(prompt) % list.length];
}

function deriveBrand(prompt, nicheKey = 'default') {
  const source = String(prompt || '');
  const quoted = source.match(/[«"“]([^»"”]{2,30})[»"”]/);
  if (quoted) return quoted[1].trim();

  const forMatch = source.match(
    /(?:для|про)\s+([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\- ]{2,40})/i
  );
  if (forMatch) {
    const candidate = forMatch[1].split(/[—–,.;:]/)[0].trim();
    const words = candidate.split(/\s+/).filter(Boolean).slice(0, 2);
    const looksGeneric = words.some((word) =>
      GENERIC_BRAND_WORDS.has(word.toLowerCase().replace(/[«»"“”]/g, ''))
    );
    if (words.length && !looksGeneric && /^[A-ZА-ЯЁ]/.test(candidate)) {
      const phrase = words.join(' ');
      return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
    }
  }

  return pickForPrompt(NICHE_BRANDS[nicheKey] || NICHE_BRANDS.default, source || nicheKey);
}

function detectNiche(prompt) {
  const text = prompt.toLowerCase();
  if (/(кофе|кафе|кофейн|coffee)/.test(text)) {
    return {
      key: 'coffee',
      eyebrow: 'Кофейня · пространство вкуса',
      headline: 'Кофе, который собирает людей.',
      subline: 'Обжарка, ритуалы и место, куда хочется возвращаться.',
    };
  }
  if (/(фотограф|фотографи|фотосесс|фотостуди|снимк|портфолио)/.test(text)) {
    return {
      key: 'photo',
      eyebrow: 'Фотограф · визуальные истории',
      headline: 'Истории, пойманные в кадре.',
      subline: 'Свет, характер и детали, которые не хочется терять.',
    };
  }
  if (/(игр|game|гейм|вселенн)/.test(text)) {
    return {
      key: 'game',
      eyebrow: 'Инди-игра · новая вселенная',
      headline: 'Мир, в который хочется вернуться.',
      subline: 'Атмосфера, исследование и история на стыке жанров.',
    };
  }
  if (/(нейросет|искусственн|\bai\b|ai-|saas|машинн)/i.test(text)) {
    return {
      key: 'ai',
      eyebrow: 'AI-продукт · новый интеллект',
      headline: 'Технологии, которые чувствуют ритм.',
      subline: 'Сложные задачи становятся простыми и почти невидимыми.',
    };
  }
  if (/(ресторан|(?<![а-яё])бар(?![а-яё])|кухн|(?<![а-яё])еда(?![а-яё])|food)/.test(text)) {
    return {
      key: 'restaurant',
      eyebrow: 'Гастрономия · вкус и атмосфера',
      headline: 'Вкус, который остаётся в памяти.',
      subline: 'Сезонные продукты, честная кухня и тёплый свет.',
    };
  }
  if (/(спорт|фитнес|трениров|йог)/.test(text)) {
    return {
      key: 'fitness',
      eyebrow: 'Движение · новая привычка',
      headline: 'Сила начинается с привычки.',
      subline: 'Программа, которая подстраивается под ваш ритм.',
    };
  }
  if (/(путеш|тур|отдых|курорт|отел)/.test(text)) {
    return {
      key: 'travel',
      eyebrow: 'Путешествия · новые маршруты',
      headline: 'Маршруты, о которых вы расскажете.',
      subline: 'Места, где время замедляется, а детали запоминаются.',
    };
  }
  if (/(бьюти|красот|космет|салон|макияж|уход)/.test(text)) {
    return {
      key: 'beauty',
      eyebrow: 'Красота · забота о себе',
      headline: 'Сияние, которое начинается изнутри.',
      subline: 'Спокойный уход, точные детали и время только для себя.',
    };
  }
  if (/(школ|курс|обучен|образован|урок|репетитор)/.test(text)) {
    return {
      key: 'education',
      eyebrow: 'Образование · новый навык',
      headline: 'Знание, которое остаётся с вами.',
      subline: 'Понятные шаги, практика и поддержка на каждом этапе.',
    };
  }
  if (/(финанс|банк|инвест|крипт|бухгалт|деньг)/.test(text)) {
    return {
      key: 'finance',
      eyebrow: 'Финансы · ясные решения',
      headline: 'Спокойствие в каждой цифре.',
      subline: 'Прозрачные инструменты для решений, которые важно принимать вовремя.',
    };
  }
  if (/(недвиж|квартир|дом|жиль|риелтор|застройщик)/.test(text)) {
    return {
      key: 'realestate',
      eyebrow: 'Недвижимость · новое пространство',
      headline: 'Место, где хочется жить.',
      subline: 'Свет, планировка и детали, из которых складывается дом.',
    };
  }
  if (/(клиник|медиц|врач|здоров|стомат|терап)/.test(text)) {
    return {
      key: 'medical',
      eyebrow: 'Здоровье · внимательная помощь',
      headline: 'Забота без лишнего шума.',
      subline: 'Спокойная среда, точная диагностика и внимание к каждому шагу.',
    };
  }
  if (/(музык|групп|концерт|альбом|песн|звук)/.test(text)) {
    return {
      key: 'music',
      eyebrow: 'Музыка · живой звук',
      headline: 'Звук, который остаётся после.',
      subline: 'Новые треки, сцена и ощущение, которое не передать словами.',
    };
  }
  if (/(магазин|shop|товар|одежд|бренд|маркетплейс)/.test(text)) {
    return {
      key: 'shop',
      eyebrow: 'Магазин · вещи с характером',
      headline: 'Выбор, который хочется носить.',
      subline: 'Аккуратный отбор, честные материалы и внимание к деталям.',
    };
  }
  if (/(дизайн|брендинг|портфолио|студи|агентств)/.test(text)) {
    return {
      key: 'design',
      eyebrow: 'Дизайн · форма и смысл',
      headline: 'Идеи, которые можно увидеть.',
      subline: 'Айдентика, интерфейсы и детали, которые делают бренд живым.',
    };
  }
  return {
    key: 'default',
    eyebrow: 'Новый проект · авторский подход',
    headline: 'Идеи, которые хочется запомнить.',
    subline: 'Продуманный дизайн, характер и внимание к деталям.',
  };
}


/* ---------- Разбор промта: бренд, цвета, разделы, тема ---------- */
const PROMPT_COLORS = [
  [/(?<![а-яё])(красн|алый|алая|scarlet|\bred\b|бордов)/i, '#e5262b'],
  [/(?<![а-яё])(оранж|orange)/i, '#ff8a3d'],
  [/(?<![а-яё])(жёлт|желт|yellow|золот|gold)/i, '#f5c542'],
  [/(?<![а-яё])(зел[её]н|green|изумруд|салат)/i, '#2fd07a'],
  [/(?<![а-яё])(бирюз|teal|мятн)/i, '#2dd4bf'],
  [/(?<![а-яё])(голуб|cyan|циан)/i, '#4cc9f0'],
  [/(?<![а-яё])(син|blue|индиго)/i, '#4f7cff'],
  [/(?<![а-яё])(фиолет|пурпур|purple|violet|лилов)/i, '#8b5cf6'],
  [/(?<![а-яё])(розов|pink|малин)/i, '#ff5fa2'],
  [/(?<![а-яё])(корич|brown|беж|кофейн)/i, '#c08a5b'],
  [/(?<![а-яё])(серебр|silver)/i, '#aab2bd'],
];
const PROMPT_STOP = /^(неон|тёпл|тепл|холодн|цвет|палитр|оформлен|фон|шрифт|сайт|лендинг|страниц|дизайн|стиль|тёмн|темн|светл|яркий|красив|современн|минимал|премиальн|анимаци|чёрн|черн|бел)/i;

function hexLuma(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function parsePromptSpec(prompt) {
  const text = String(prompt || '').replace(/\s+/g, ' ').trim();
  const found = [];
  PROMPT_COLORS.forEach(([re, hex]) => {
    const m = re.exec(text);
    if (m) found.push({ idx: m.index, hex });
  });
  found.sort((a, b) => a.idx - b.idx);
  const colors = [...new Set(found.map((c) => c.hex))];

  let brand = '';
  const named = text.match(/(?:называется|название|под названием|бренд)\s*[:—-]?\s*[«"“]?([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 \-]{1,28})/i);
  if (named) brand = named[1].split(/[,.;:—]/)[0].trim().split(' ').slice(0, 3).join(' ');
  if (!brand) {
    const latin = text.match(/(?<![A-Za-z])([A-Z][A-Za-z0-9]{2,}(?:\s[A-Z][A-Za-z0-9]{2,})?)/);
    if (latin) brand = latin[1];
  }

  if (!brand) {
    const re = /(?<![А-Яа-яЁё])[А-ЯЁ][а-яё]{2,}/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index).trim().split(' ').pop().toLowerCase();
      if (m.index === 0 || /^(в|на|из|по|для|от|до|у|к|во|об|про)$/.test(before)) continue;
      brand = m[0];
      break;
    }
  }

  let sections = [];
  const marker = text.match(/(?:разделы|разделами|раздел|страницы|секции|блоки|включая|включи|где есть|с блоками|меню)\s*[:—-]?\s*(.+)$/i);
  const pool = marker ? marker[1] : text.split(',').slice(1).join(',');
  sections = pool
    .split(/[,;]|\sи\s|\+/)
    .map((x) => x.replace(/^(и|а также|ещё|еще|с|со)\s+/i, '').replace(/[.!]+$/, '').trim())
    .filter((x) => x.length >= 3 && x.length <= 40 && !PROMPT_STOP.test(x) && !PROMPT_COLORS.some(([re]) => re.test(x)))
    .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
    .slice(0, 6);

  let subject = text
    .replace(/^(пожалуйста[,\s]*)?(сделай|создай|сгенерируй|собери|нужен|нужна|хочу|напиши)\s+(мне\s+)?/i, '')
    .replace(/^(сайт|лендинг|веб-?сайт|страницу|страница|landing)\s*(для|про|о|об)?\s*/i, '')
    .split(/[,.;:—]/)[0]
    .trim()
    .slice(0, 70);
  if (subject) subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  return { text, colors, brand, sections, subject };
}

function buildDemoSite(prompt, style) {
  const palettes = {
    dark: {
      bg: '#080910',
      surface: '#10121b',
      surface2: '#0b0d15',
      text: '#f4f4fb',
      muted: '#9a9eb3',
      line: 'rgba(255,255,255,0.1)',
      accent: '#9b8cff',
      accent2: '#5ad1ff',
      ink: '#080910',
      soft: 'rgba(139,123,255,0.14)',
      shadow: '0 30px 80px rgba(0,0,0,0.45)',
    },
    light: {
      bg: '#f7f4ec',
      surface: '#ffffff',
      surface2: '#efece3',
      text: '#16171c',
      muted: '#686c78',
      line: 'rgba(22,23,28,0.13)',
      accent: '#5b4bff',
      accent2: '#ff7a59',
      ink: '#ffffff',
      soft: 'rgba(91,75,255,0.09)',
      shadow: '0 28px 70px rgba(28,24,20,0.13)',
    },
    neon: {
      bg: '#06030c',
      surface: '#12081f',
      surface2: '#0b0515',
      text: '#fbf5ff',
      muted: '#b099c8',
      line: 'rgba(255,255,255,0.12)',
      accent: '#ff4df0',
      accent2: '#3ef8ff',
      ink: '#0a0212',
      soft: 'rgba(255,77,240,0.14)',
      shadow: '0 30px 80px rgba(0,0,0,0.5)',
    },
    glass: {
      bg: '#061019',
      surface: 'rgba(255,255,255,0.065)',
      surface2: 'rgba(255,255,255,0.035)',
      text: '#f2f7ff',
      muted: '#a5b0c0',
      line: 'rgba(255,255,255,0.15)',
      accent: '#7de9ff',
      accent2: '#b79dff',
      ink: '#061019',
      soft: 'rgba(125,233,255,0.11)',
      shadow: '0 30px 80px rgba(0,0,0,0.42)',
    },
    minimal: {
      bg: '#fbfbf8',
      surface: '#ffffff',
      surface2: '#f1f0eb',
      text: '#111216',
      muted: '#686b73',
      line: 'rgba(17,18,22,0.13)',
      accent: '#111216',
      accent2: '#6f5cff',
      ink: '#ffffff',
      soft: 'rgba(17,18,22,0.05)',
      shadow: '0 28px 70px rgba(20,20,26,0.12)',
    },
  };

  const niche = detectNiche(prompt);
  const baseContent = NICHE_CONTENT[niche.key] || NICHE_CONTENT.default;
  const base = palettes[style] || palettes.dark;
  const accentPairs = {
    dark: [
      ['#9b8cff', '#5ad1ff'],
      ['#ff8a5b', '#ffd166'],
      ['#66e3b4', '#7aa7ff'],
      ['#f56ea9', '#ffd36e'],
    ],
    light: [
      ['#5b4bff', '#ff7a59'],
      ['#0f766e', '#f59e0b'],
      ['#9a3412', '#2563eb'],
    ],
    neon: [
      ['#ff4df0', '#3ef8ff'],
      ['#a3ff4d', '#ff4d8d'],
      ['#ffb347', '#8a5cff'],
    ],
    glass: [
      ['#7de9ff', '#b79dff'],
      ['#8dffcf', '#7aa7ff'],
      ['#ffc48d', '#ff8db3'],
    ],
    minimal: [
      ['#111216', '#6f5cff'],
      ['#1f2937', '#e11d48'],
      ['#334155', '#0ea5e9'],
    ],
  };
  const accentPair = pickForPrompt(accentPairs[style] || accentPairs.dark, `${prompt}|${style}`);
  const spec = parsePromptSpec(prompt);
  const darkBase = hexLuma(String(base.bg || '#000').startsWith('#') ? base.bg : '#000000') < 0.5;
  const usableColors = spec.colors.filter((hex) => (darkBase ? hexLuma(hex) > 0.18 : hexLuma(hex) < 0.85));
  const p = {
    ...base,
    accent: usableColors[0] || accentPair[0],
    accent2: usableColors[1] || (usableColors[0] ? accentPair[1] : accentPair[1]),
  };
  if (usableColors[0]) p.soft = `${usableColors[0]}26`;
  const brand = escapeHtml(spec.brand || deriveBrand(prompt, niche.key));
  const userSections = spec.sections;
  const content = { ...baseContent };
  if (userSections.length >= 2) {
    const secs = userSections;
    content.nav = [secs[0], secs[1], secs[2] || baseContent.nav[2]];
    content.ticker = secs.map((x) => x.toUpperCase());
    content.worksNav = secs[0].toLowerCase();
    content.worksTitle = escapeHtml(secs[0]);
    content.worksLead = `${spec.brand || deriveBrand(prompt, niche.key)}: ${secs.slice(0, 4).join(', ').toLowerCase()}.`;
    const extra = secs.slice(3, 6);
    const pad = ['Подробности', 'Контакты', 'Заказать'];
    const works = [];
    for (let i = 0; i < 3; i += 1) works.push([extra[i] || secs[i % secs.length], extra[i] ? 'Раздел' : 'Главное']);
    content.works = works;
    content.features = secs.slice(0, 3).map((title, i) => [
      title,
      `Отдельный раздел сайта «${title}» — собран по вашему описанию, его легко расширить.`,
    ]);
    while (content.features.length < 3) content.features.push([pad[content.features.length], 'Связаться и уточнить детали.']);
    content.approachTitle = escapeHtml(spec.subject || baseContent.approachTitle);
  }
  const userDriven = Boolean(spec.subject) && (niche.key === 'default' || spec.sections.length >= 2 || Boolean(spec.brand));
  const headlineSource = userDriven ? `${spec.subject}.` : niche.headline;
  const sublineSource = userDriven && spec.text ? spec.text.slice(0, 160) : niche.subline;
  const brief = escapeHtml(prompt.slice(0, 260));
  const words = headlineSource.split(' ');
  const headlineLead = escapeHtml(words.slice(0, Math.max(1, words.length - 2)).join(' '));
  const headlineTail = escapeHtml(words.slice(-2).join(' '));
  const styleLabel = SITE_STYLE_LABELS[style] || 'Современный';
  const year = new Date().getFullYear();
  const subline = escapeHtml(sublineSource);
  const layout = pickForPrompt(['split', 'editorial', 'center'], `${prompt}|${style}|layout`);

  const navLinks = content.nav
    .map((label, index) => `<a href="#${['work', 'about', 'contact'][index]}">${escapeHtml(label)}</a>`)
    .join('\n    ');
  const tickerHtml = content.ticker
    .map((word) => `<span>${escapeHtml(word)}</span><i>✦</i>`)
    .join('');
  const worksHtml = content.works
    .map(
      ([title, tag], index) => `<article class="work rise d${index + 1}">
        <div class="work-art art${index + 1}"><span>0${index + 1}</span></div>
        <div class="work-cap"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(tag)}</span></div>
      </article>`
    )
    .join('\n      ');
  const featuresHtml = content.features
    .map(
      ([title, text], index) => `<article class="feature rise d${index + 1}"><span>0${index + 1}</span><div><h3>${escapeHtml(
        title
      )}</h3><p>${escapeHtml(text)}</p></div></article>`
    )
    .join('\n      ');
  const statsHtml = content.stats
    .map(
      ([value, label]) =>
        `<div class="mini-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(
          label
        )}</span></div>`
    )
    .join('\n        ');

  const layoutCss =
    layout === 'center'
      ? `body.layout-center .hero{grid-template-columns:1fr;text-align:center;padding-top:76px}
body.layout-center .hero-copy{max-width:820px;margin:0 auto}
body.layout-center .lead{margin-left:auto;margin-right:auto}
body.layout-center .actions,body.layout-center .mini-stats{justify-content:center}
body.layout-center .hero-visual{display:none}`
      : layout === 'editorial'
        ? `body.layout-editorial .hero{grid-template-columns:.78fr 1.22fr;gap:36px}
body.layout-editorial h1{font-size:clamp(46px,7vw,88px)}
body.layout-editorial .visual-card{width:min(430px,100%);aspect-ratio:3/4}`
        : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${brand} — ${escapeHtml(headlineSource)}</title>
<meta name="description" content="${brief}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Unbounded:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:${p.bg};
  --surface:${p.surface};
  --surface-2:${p.surface2};
  --text:${p.text};
  --muted:${p.muted};
  --line:${p.line};
  --accent:${p.accent};
  --accent-2:${p.accent2};
  --ink:${p.ink};
  --soft:${p.soft};
  --shadow:${p.shadow};
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;
  background:var(--bg);
  color:var(--text);
  font-family:'Manrope',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  line-height:1.55;
  overflow-x:hidden;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none}
h1,h2,h3,p{margin:0}
button{font:inherit}
::selection{background:var(--accent);color:var(--ink)}
::-webkit-scrollbar{width:9px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px;border:2px solid var(--bg)}
.bg{position:fixed;inset:0;z-index:-2;overflow:hidden;background:
  radial-gradient(950px 640px at 78% -12%,var(--soft),transparent 62%),
  radial-gradient(720px 520px at 2% 100%,rgba(90,209,255,0.06),transparent 60%),
  var(--bg);}
.blob{position:absolute;border-radius:50%;filter:blur(110px);opacity:.55;animation:blobFloat 18s ease-in-out infinite alternate}
.blob.b1{width:520px;height:520px;left:-160px;top:-180px;background:var(--soft)}
.blob.b2{width:420px;height:420px;right:-120px;top:30%;background:rgba(90,209,255,0.09);animation-delay:-7s}
.blob.b3{width:380px;height:380px;left:35%;bottom:-220px;background:rgba(255,134,220,0.07);animation-delay:-12s}
@keyframes blobFloat{to{transform:translate3d(45px,35px,0) scale(1.1)}}
.wrap{width:min(1180px,92vw);margin:0 auto}
.nav{
  position:sticky;top:0;z-index:20;
  display:flex;align-items:center;justify-content:space-between;gap:22px;
  width:min(1180px,92vw);margin:0 auto;padding:18px 0;
  background:${p.bg}d9;backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);
  border-bottom:1px solid var(--line);
}
.brand{display:inline-flex;align-items:center;gap:9px;font-family:'Unbounded',sans-serif;font-size:14px;font-weight:500;letter-spacing:-.02em}
.brand-dot{width:12px;height:12px;border-radius:50%;background:radial-gradient(circle at 32% 26%,#fff,var(--accent) 42%,var(--accent-2));box-shadow:0 0 18px var(--accent)}
.nav-links{display:flex;gap:24px;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.nav-links a{transition:color .2s}
.nav-links a:hover{color:var(--text)}
.nav-cta{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 13px;border-radius:999px;border:1px solid var(--line);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;transition:background .2s,border-color .2s}
.nav-cta:hover{background:var(--soft);border-color:var(--accent)}
.hero{display:grid;grid-template-columns:1.06fr .94fr;gap:54px;align-items:center;padding:88px 0 74px}
.hero-copy{position:relative;z-index:2}
.pill{display:inline-flex;align-items:center;gap:8px;padding:6px 11px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2);color:var(--muted);font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.pill i{width:5px;height:5px;border-radius:50%;background:var(--accent-2);box-shadow:0 0 9px var(--accent-2);animation:dotPulse 2s ease-in-out infinite}
@keyframes dotPulse{50%{opacity:.35;transform:scale(.7)}}
h1{font-family:'Unbounded',sans-serif;font-size:clamp(42px,6.2vw,74px);line-height:1.01;letter-spacing:-.055em;font-weight:500;margin-top:20px}
h1 em{font-style:normal;background:linear-gradient(115deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{max-width:490px;margin-top:20px;color:var(--muted);font-size:14px;line-height:1.7}
.lead strong{color:var(--text);font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:27px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:44px;padding:0 19px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.02em;transition:transform .2s,filter .2s,background .2s}
.btn:hover{transform:translateY(-2px)}
.btn-primary{background:linear-gradient(120deg,var(--accent),var(--accent-2));color:var(--ink);box-shadow:0 12px 32px var(--soft)}
.btn-primary:hover{filter:brightness(1.06)}
.btn-ghost{border:1px solid var(--line);background:var(--surface-2);color:var(--text)}
.btn-ghost:hover{background:var(--surface)}
.mini-stats{display:flex;flex-wrap:wrap;gap:26px;margin-top:40px;padding-top:22px;border-top:1px solid var(--line)}
.mini-stat strong{display:block;font-family:'Unbounded',sans-serif;font-size:17px;font-weight:500;letter-spacing:-.03em}
.mini-stat span{display:block;margin-top:2px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.hero-visual{position:relative;min-height:470px;display:flex;align-items:center;justify-content:center}
.visual-card{
  position:relative;width:min(390px,92%);aspect-ratio:4/5;border-radius:28px;
  border:1px solid var(--line);background:
    radial-gradient(130% 110% at 80% 0%,var(--soft),transparent 58%),
    linear-gradient(155deg,var(--surface),var(--surface-2));
  box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;justify-content:space-between;padding:20px;
}
.visual-card::before{content:'';position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:34px 34px;opacity:.24;mask-image:radial-gradient(circle at 50% 45%,#000,transparent 78%)}
.vc-head{position:relative;z-index:2;display:flex;align-items:center;justify-content:space-between;font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.live{display:inline-flex;align-items:center;gap:5px;color:var(--accent-2)}
.live::before{content:'';width:4px;height:4px;border-radius:50%;background:var(--accent-2);box-shadow:0 0 8px var(--accent-2)}
.vc-center{position:relative;z-index:1;display:grid;place-items:center;flex:1}
.vc-orb{position:relative;width:180px;height:180px;border-radius:50%;background:conic-gradient(from 210deg,var(--accent),var(--accent-2),var(--accent));box-shadow:0 0 60px var(--soft),inset 0 0 50px rgba(0,0,0,.28);animation:orbSpin 16s linear infinite}
.vc-orb::before{content:'';position:absolute;inset:22px;border-radius:50%;background:radial-gradient(circle at 32% 26%,#fff,var(--accent) 32%,var(--surface-2) 78%);box-shadow:inset 0 -16px 30px rgba(0,0,0,.35);animation:orbSpin 22s linear infinite reverse}
.vc-orb::after{content:'';position:absolute;inset:-18px;border-radius:50%;border:1px dashed var(--line);animation:orbSpin 26s linear infinite}
@keyframes orbSpin{to{transform:rotate(360deg)}}
.vc-foot{position:relative;z-index:2;display:flex;align-items:flex-end;justify-content:space-between;gap:10px}
.vc-foot strong{display:block;font-family:'Unbounded',sans-serif;font-size:12px;font-weight:500}
.vc-foot span{display:block;margin-top:3px;font-size:9px;color:var(--muted);letter-spacing:.04em}
.vc-arrow{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:var(--surface-2);font-size:13px}
.note{position:absolute;z-index:3;display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border-radius:999px;border:1px solid var(--line);background:${p.bg}cf;backdrop-filter:blur(12px);box-shadow:var(--shadow);font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);animation:noteFloat 6s ease-in-out infinite}
.note i{width:5px;height:5px;border-radius:50%;background:var(--accent)}
.note.n1{left:-12px;top:20%;animation-delay:-1.5s}
.note.n2{right:-8px;bottom:17%;animation-delay:-3.6s}
@keyframes noteFloat{50%{transform:translateY(-9px)}}
.ticker{margin-top:12px;padding:13px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);overflow:hidden;mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}
.ticker-track{display:flex;gap:30px;width:max-content;font-family:'Unbounded',sans-serif;font-size:9px;letter-spacing:.2em;color:var(--muted);animation:tickerMove 26s linear infinite}
.ticker-track i{font-style:normal;color:var(--accent)}
@keyframes tickerMove{to{transform:translateX(-50%)}}
.section{padding:82px 0}
.sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:30px;margin-bottom:30px}
.kicker{font-size:9.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.sec-head h2,.split h2,.cta h2{font-family:'Unbounded',sans-serif;font-size:clamp(28px,4vw,44px);line-height:1.08;letter-spacing:-.045em;font-weight:500;margin-top:9px}
.sec-head h2 em,.split h2 em{font-style:normal;color:var(--muted)}
.sec-head p{max-width:290px;font-size:11px;line-height:1.6;color:var(--muted);text-align:right}
.works{display:grid;grid-template-columns:1.3fr .7fr .7fr;gap:12px}
.work{border:1px solid var(--line);border-radius:20px;overflow:hidden;background:var(--surface-2);transition:transform .3s cubic-bezier(.2,.8,.2,1),border-color .3s,box-shadow .3s}
.work:hover{transform:translateY(-5px);border-color:var(--accent);box-shadow:var(--shadow)}
.work-art{position:relative;aspect-ratio:1.35;overflow:hidden}
.work:first-child .work-art{aspect-ratio:1.62}
.work-art::after{content:'';position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:30px 30px;opacity:.22}
.art1{background:radial-gradient(circle at 70% 25%,var(--accent),transparent 46%),conic-gradient(from 200deg at 30% 80%,var(--accent-2),transparent 45%,var(--accent))}
.art2{background:linear-gradient(145deg,var(--accent-2),var(--surface-2) 62%),radial-gradient(circle at 30% 20%,var(--accent),transparent 55%)}
.art3{background:conic-gradient(from 40deg,var(--soft),var(--accent) 25%,var(--surface-2) 55%,var(--accent-2))}
.work-art span{position:absolute;left:13px;top:13px;z-index:2;display:grid;place-items:center;width:27px;height:27px;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(0,0,0,.22);backdrop-filter:blur(8px);color:#fff;font-size:9px;letter-spacing:.03em}
.work-cap{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 14px}
.work-cap strong{font-size:11px;font-weight:600}
.work-cap span{font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.split{display:grid;grid-template-columns:.85fr 1.15fr;gap:60px;border-top:1px solid var(--line)}
.feature-list{display:flex;flex-direction:column}
.feature{display:grid;grid-template-columns:42px 1fr;gap:16px;padding:20px 0;border-bottom:1px solid var(--line)}
.feature:first-child{padding-top:0}
.feature:last-child{border-bottom:0}
.feature>span{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;border:1px solid var(--line);background:var(--surface-2);color:var(--muted);font-family:'Unbounded',sans-serif;font-size:9px}
.feature h3{font-size:13px;font-weight:700;margin-bottom:5px}
.feature p{max-width:480px;font-size:11.5px;line-height:1.65;color:var(--muted)}
.cta{
  position:relative;margin:20px 0 30px;padding:58px 36px;border-radius:28px;border:1px solid var(--line);
  background:
    radial-gradient(90% 150% at 100% 0%,var(--soft),transparent 58%),
    radial-gradient(90% 140% at 0% 100%,rgba(90,209,255,0.07),transparent 60%),
    var(--surface-2);
  overflow:hidden;text-align:center;
}
.cta::before{content:'';position:absolute;width:250px;height:250px;right:-60px;top:-100px;border-radius:50%;background:var(--accent);filter:blur(80px);opacity:.2}
.cta h2{max-width:700px;margin:10px auto 0}
.cta p{max-width:470px;margin:14px auto 0;color:var(--muted);font-size:12px;line-height:1.65}
.cta .actions{justify-content:center;margin-top:25px}
footer{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;padding:22px 0 34px;border-top:1px solid var(--line);color:var(--muted);font-size:9.5px;letter-spacing:.04em}
.footer-brand{display:inline-flex;align-items:center;gap:7px;color:var(--text);font-family:'Unbounded',sans-serif;font-size:11px}
.rise{animation:rise .95s cubic-bezier(.2,.8,.2,1) both}
.d1{animation-delay:.08s}.d2{animation-delay:.16s}.d3{animation-delay:.24s}.d4{animation-delay:.32s}
@keyframes rise{from{opacity:0;transform:translateY(26px)}to{opacity:1;transform:none}}
${layoutCss}
@media (max-width:980px){
  .hero{grid-template-columns:1fr;gap:20px;padding:56px 0 50px}
  .hero-visual{min-height:390px;margin-top:10px}
  .works{grid-template-columns:1fr 1fr}
  .work:first-child{grid-column:1/-1}
  .split{grid-template-columns:1fr;gap:26px}
  .sec-head{align-items:flex-start;flex-direction:column;gap:10px}
  .sec-head p{text-align:left}
  .nav-links{display:none}
}
@media (max-width:620px){
  .wrap,.nav{width:min(100% - 32px,1180px)}
  .nav{padding:13px 0}
  .nav-cta{height:30px;font-size:9px}
  .hero{padding:38px 0 36px}
  h1{font-size:clamp(36px,10vw,51px)}
  .lead{font-size:13px}
  .mini-stats{gap:18px}
  .hero-visual{min-height:330px}
  .visual-card{width:min(310px,100%);padding:16px;border-radius:22px}
  .vc-orb{width:140px;height:140px}
  .note{display:none}
  .section{padding:52px 0}
  .works{grid-template-columns:1fr}
  .work:first-child{grid-column:auto}
  .work:first-child .work-art{aspect-ratio:1.35}
  .sec-head h2,.split h2,.cta h2{font-size:clamp(26px,8vw,34px)}
  .cta{padding:38px 20px;border-radius:22px}
  footer{align-items:flex-start;flex-direction:column;gap:9px}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
}
</style>
</head>
<body class="layout-${layout}">
<div class="bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span></div>

<header class="nav">
  <a class="brand" href="#top"><span class="brand-dot"></span> ${brand}</a>
  <nav class="nav-links" aria-label="Навигация">
    ${navLinks}
  </nav>
  <a class="nav-cta" href="#contact">${escapeHtml(content.cta)} <span>↗</span></a>
</header>

<main class="wrap" id="top">
  <section class="hero">
    <div class="hero-copy rise">
      <span class="pill"><i></i>${escapeHtml(userDriven ? `${spec.brand || deriveBrand(prompt, niche.key)} · по вашему описанию` : niche.eyebrow)}</span>
      <h1>${headlineLead}<br><em>${headlineTail}</em></h1>
      <p class="lead"><strong>${brief}</strong><br>${subline}</p>
      <div class="actions">
        <a class="btn btn-primary" href="#contact">${escapeHtml(content.cta)} <span>↗</span></a>
        <a class="btn btn-ghost" href="#work">Смотреть ${escapeHtml(content.worksNav)}</a>
      </div>
      <div class="mini-stats">
        ${statsHtml}
      </div>
    </div>
    <div class="hero-visual rise d2">
      <span class="note n1"><i></i>${escapeHtml(styleLabel)}</span>
      <span class="note n2"><i></i>анимации</span>
      <div class="visual-card">
        <div class="vc-head"><span>${brand} / ${year}</span><span class="live">live</span></div>
        <div class="vc-center"><div class="vc-orb"></div></div>
        <div class="vc-foot">
          <div><strong>${escapeHtml(content.visualTitle)}</strong><span>${escapeHtml(
            content.visualSub
          )}</span></div>
          <span class="vc-arrow">↗</span>
        </div>
      </div>
    </div>
  </section>

  <div class="ticker" aria-hidden="true">
    <div class="ticker-track">
      ${tickerHtml}${tickerHtml}
    </div>
  </div>

  <section class="section" id="work">
    <div class="sec-head rise">
      <div><p class="kicker">${escapeHtml(content.worksKicker)}</p><h2>${content.worksTitle}</h2></div>
      <p>${escapeHtml(content.worksLead)}</p>
    </div>
    <div class="works">
      ${worksHtml}
    </div>
  </section>

  <section class="section split" id="about">
    <div class="rise">
      <p class="kicker">${escapeHtml(content.approachKicker)}</p>
      <h2>${content.approachTitle}</h2>
    </div>
    <div class="feature-list">
      ${featuresHtml}
    </div>
  </section>

  <section class="cta rise" id="contact">
    <p class="kicker">${escapeHtml(content.finalKicker)}</p>
    <h2>${content.finalTitle}</h2>
    <p>${escapeHtml(content.finalText)}</p>
    <div class="actions">
      <a class="btn btn-primary" href="mailto:hello@example.com">${escapeHtml(
        content.finalCta
      )} <span>↗</span></a>
      <a class="btn btn-ghost" href="#top">Наверх</a>
    </div>
  </section>

  <footer>
    <span class="footer-brand"><span class="brand-dot"></span> ${brand}</span>
    <span>© ${year} · ${escapeHtml(content.footerNote)}</span>
    <span>Стиль «${escapeHtml(styleLabel)}» · Lumio Studio</span>
  </footer>
</main>
</body>
</html>`;
}


/* ---------- Image gallery ---------- */

const IMAGE_LIMIT_MESSAGE = 'Бесплатно и без ключей. Иногда сервис делает короткую паузу.';

function imageCooldownRemaining() {
  return Math.max(0, Math.ceil((state.imageCooldownUntil - Date.now()) / 1000));
}

function updateImageButtonState() {
  if (!el.generateImageBtn) return;
  const label = el.generateImageBtn.querySelector('span:last-of-type');
  const noteText = el.imageLimitNote?.querySelector('span');
  const remaining = imageCooldownRemaining();

  if (state.imagePending > 0) {
    el.generateImageBtn.disabled = true;
    if (label) label.textContent = 'Создаю…';
    if (noteText) noteText.textContent = 'Генерирую изображение…';
    el.imageLimitNote?.classList.remove('cooling');
    return;
  }

  if (remaining > 0) {
    el.generateImageBtn.disabled = true;
    if (label) label.textContent = `Через ${remaining} с`;
    if (noteText) noteText.textContent = `Следующая картинка через ${remaining} с.`;
    el.imageLimitNote?.classList.add('cooling');
    return;
  }

  el.generateImageBtn.disabled = false;
  if (label) label.textContent = 'Создать';
  if (noteText) noteText.textContent = IMAGE_LIMIT_MESSAGE;
  el.imageLimitNote?.classList.remove('cooling');
}

function startImageCooldown(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  state.imageCooldownUntil = value ? Date.now() + value * 1000 : 0;
  if (state.imageCooldownTimer) {
    clearInterval(state.imageCooldownTimer);
    state.imageCooldownTimer = null;
  }
  updateImageButtonState();
  if (!value) return;

  state.imageCooldownTimer = setInterval(() => {
    if (imageCooldownRemaining() <= 0) {
      state.imageCooldownUntil = 0;
      clearInterval(state.imageCooldownTimer);
      state.imageCooldownTimer = null;
    }
    updateImageButtonState();
  }, 250);
}

function buildImageCard(item, onSettle) {
  const ar = IMAGE_ASPECTS[item.aspect] || IMAGE_ASPECTS['1:1'];
  const card = document.createElement('article');
  card.className = 'image-card';
  card.dataset.imageId = item.id;
  card.style.setProperty('--ar', String(ar.css));
  if (item.url && state.library.images.some((image) => image.url === item.url)) {
    card.classList.add('saved');
  }

  const prompt = escapeHtml(item.prompt);
  const hasImage = Boolean(item.url);
  const isError = item.status === 'error';
  if (isError) card.classList.add('error');

  const errorText = escapeHtml(
    item.errorText || 'Не удалось создать изображение. Попробуйте ещё раз.'
  );

  card.innerHTML = `
    <div class="image-shell">
      <div class="image-skeleton"></div>
      ${
        hasImage
          ? `<img src="${escapeHtml(item.url)}" alt="${prompt}" loading="eager" decoding="async" />`
          : ''
      }
      ${
        !hasImage && !isError
          ? `<div class="image-loading-label"><svg class="icon"><use href="#i-sparkles"/></svg><span>Рисую…</span></div>`
          : ''
      }
      <div class="image-error" data-img-action="retry" role="button" tabindex="0">
        <svg class="icon"><use href="#i-alert"/></svg>
        <span>${hasImage ? 'Не удалось загрузить.<br>Нажмите, чтобы повторить.' : `${errorText}<br>Нажмите, чтобы повторить.`}</span>
      </div>
      <span class="img-saved"><svg class="icon"><use href="#i-check"/></svg> В библиотеке</span>
      ${
        hasImage
          ? `<div class="image-actions">
              <button class="img-action" type="button" data-img-action="download" title="Скачать" aria-label="Скачать"><svg class="icon"><use href="#i-download"/></svg></button>
              <button class="img-action" type="button" data-img-action="save" title="В библиотеку" aria-label="В библиотеку"><svg class="icon"><use href="#i-bookmark"/></svg></button>
              <button class="img-action" type="button" data-img-action="expand" title="Открыть" aria-label="Открыть"><svg class="icon"><use href="#i-maximize"/></svg></button>
            </div>`
          : ''
      }
    </div>
    <div class="image-meta">
      <p>${prompt}</p>
      <span class="image-tag">${escapeHtml(IMAGE_STYLE_LABELS[item.style] || 'Кинематограф')}</span>
    </div>`;

  if (hasImage) {
    const img = card.querySelector('img');
    let settled = false;
    const settle = (success) => {
      if (settled) return;
      settled = true;
      card.classList.toggle('loaded', success);
      card.classList.toggle('error', !success);
      if (!success) {
        item.status = 'error';
        item.errorText = 'Не удалось загрузить изображение.';
      }
      if (typeof onSettle === 'function') onSettle(success);
    };
    img.addEventListener('load', () => settle(true), { once: true });
    img.addEventListener('error', () => settle(false), { once: true });
    if (img.complete) {
      if (img.naturalWidth > 0) settle(true);
      else settle(false);
    }
  } else if (isError && typeof onSettle === 'function') {
    onSettle(false);
  }

  requestAnimationFrame(() => card.classList.add('in'));
  return card;
}

function replaceImageCard(item, onSettle) {
  if (!el.imageGrid) return;
  const card = buildImageCard(item, onSettle);
  const old = Array.from(el.imageGrid.querySelectorAll('.image-card')).find(
    (node) => node.dataset.imageId === item.id
  );
  if (old) old.replaceWith(card);
  else el.imageGrid.prepend(card);
}

function updateGalleryUI() {
  const count = state.gallery.length;
  el.galleryCount.textContent = count
    ? `${count} ${pluralRu(count, 'изображение', 'изображения', 'изображений')}`
    : 'Пока пусто';
  el.galleryEmpty.hidden = count > 0;
}

function renderImageGrid() {
  if (!el.imageGrid) return;
  el.imageGrid.innerHTML = '';
  state.gallery.forEach((item) => {
    el.imageGrid.appendChild(buildImageCard(item));
  });
  updateGalleryUI();
}

async function requestImage(item, externalSignal = null, onUpdate = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  }
  const notify = () => {
    if (typeof onUpdate !== 'function') return;
    try {
      onUpdate(item);
    } catch {
      /* ignore */
    }
  };

  try {
    const response = await fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        prompt: item.prompt,
        style: IMAGE_STYLE_PROMPTS[item.style] || '',
        width: item.width,
        height: item.height,
        seed: item.seed,
      }),
    });

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      /* ignore */
    }

    if (!response.ok) {
      const retryAfter = Math.max(
        0,
        Math.ceil(
          Number(data.retryAfter) ||
            Number(response.headers.get('retry-after')) ||
            0
        )
      );
      const error = new Error(
        typeof data.error === 'string'
          ? data.error
          : 'Генератор изображений не смог создать картинку.'
      );
      error.retryAfter = retryAfter;
      throw error;
    }

    if (!data.url) throw new Error('Генератор не вернул изображение.');

    item.url = data.url;
    item.status = 'ready';
    item.errorText = '';
    item.width = Number(data.width) || item.width;
    item.height = Number(data.height) || item.height;
    item.source = typeof data.source === 'string' ? data.source : '';
    item.createdAt = Date.now();
    state.imagePending = Math.max(0, state.imagePending - 1);
    replaceImageCard(item);
    updateGalleryUI();
    startImageCooldown(Number(data.cooldown) || 0);
    notify();
    if (data.fallback || data.source === 'Lumio Vision') {
      toast(
        'Локальная иллюстрация',
        data.note ||
          'Внешние генераторы заняты, поэтому картинка собрана локально по вашему описанию.',
        'info'
      );
    } else {
      toast('Картинка готова', 'Можно скачать или сохранить в библиотеку.', 'success');
    }
  } catch (error) {
    state.imagePending = Math.max(0, state.imagePending - 1);
    item.url = '';
    item.status = 'error';
    const retryAfter = Number(error.retryAfter) || 0;
    item.errorText = retryAfter
      ? `Лимит: следующая через ${retryAfter} с.`
      : externalSignal?.aborted || controller.signal.aborted
        ? 'Генерация остановлена.'
        : error?.name === 'AbortError'
          ? 'Генератор не ответил вовремя.'
          : error?.message || 'Не удалось создать изображение.';
    replaceImageCard(item);
    updateGalleryUI();
    notify();

    if (retryAfter > 0) {
      startImageCooldown(retryAfter);
      toast(
        'Нужна короткая пауза',
        `Следующее изображение можно создать через ${retryAfter} с.`,
        'info'
      );
    } else {
      startImageCooldown(0);
      toast('Не удалось создать картинку', item.errorText, 'error');
    }
  } finally {
    clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', forwardAbort);
  }
  return item;
}

function generateImage() {
  if (state.imagePending > 0) return;

  const cooldown = imageCooldownRemaining();
  if (cooldown > 0) {
    toast(
      'Ещё рано',
      `Следующее изображение можно создать через ${cooldown} с.`,
      'info'
    );
    return;
  }

  const prompt = el.imagePrompt.value.replace(/\s+/g, ' ').trim();
  if (!prompt) {
    toast('Опишите картинку', 'Например: неоновый Токио под дождём.', 'info');
    el.imagePrompt.focus();
    return;
  }

  const style = state.imageStyle;
  const aspect = state.imageAspect;
  const dimensions = IMAGE_ASPECTS[aspect] || IMAGE_ASPECTS['1:1'];
  const item = {
    id: uid(),
    prompt,
    style,
    aspect,
    width: dimensions.width,
    height: dimensions.height,
    seed: Math.floor(Math.random() * 900000) + 1000,
    url: '',
    status: 'pending',
    errorText: '',
    createdAt: Date.now(),
  };

  state.imagePending += 1;
  updateImageButtonState();
  state.gallery.unshift(item);
  replaceImageCard(item);
  updateGalleryUI();
  void requestImage(item);
}

function retryImage(item) {
  if (!item || state.imagePending > 0) return;
  const cooldown = imageCooldownRemaining();
  if (cooldown > 0) {
    toast(
      'Ещё рано',
      `Следующее изображение можно создать через ${cooldown} с.`,
      'info'
    );
    return;
  }

  item.seed = Math.floor(Math.random() * 900000) + 1000;
  item.createdAt = Date.now();
  item.url = '';
  item.status = 'pending';
  item.errorText = '';

  state.imagePending += 1;
  updateImageButtonState();
  replaceImageCard(item);
  updateGalleryUI();
  void requestImage(item);
}

function handleImageGridClick(event) {
  const card = event.target.closest('.image-card');
  if (!card) return;
  const item = state.gallery.find((image) => image.id === card.dataset.imageId);
  if (!item) return;

  const action = event.target.closest('[data-img-action]');
  if (action) {
    const type = action.dataset.imgAction;
    if (type === 'retry') {
      retryImage(item);
      return;
    }
    if (!card.classList.contains('loaded')) {
      toast('Картинка ещё не готова', 'Дождитесь загрузки или попробуйте ещё раз.', 'info');
      return;
    }
    handleImageAction(item, type);
    return;
  }

  if (!card.classList.contains('loaded')) return;
  if (event.target.closest('img') || event.target.closest('.image-shell')) openLightbox(item);
}

/* ---------- Features landing ---------- */

const TYPE_WORDS = [
  'писать код',
  'собирать сайты',
  'рисовать миры',
  'объяснять сложное',
  'генерировать идеи',
];

function startTypewriter() {
  if (state.typeTimer) return;
  let index = 0;
  state.typeTimer = setInterval(() => {
    if (!el.typeWord) return;
    index = (index + 1) % TYPE_WORDS.length;
    el.typeWord.classList.add('swap');
    setTimeout(() => {
      el.typeWord.textContent = TYPE_WORDS[index];
      el.typeWord.classList.remove('swap');
    }, 230);
  }, 2800);
}

function animateStats() {
  if (state.statsDone || !el.statsRow) return;
  state.statsDone = true;
  el.statsRow.querySelectorAll('[data-count]').forEach((node) => {
    const target = Number(node.dataset.count) || 0;
    const suffix = node.dataset.suffix || '';
    const duration = 1300;
    const start = performance.now();
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      node.textContent = `${Math.round(target * eased)}${suffix}`;
      if (progress < 1) requestAnimationFrame(tick);
      else node.textContent = `${target}${suffix}`;
    };
    requestAnimationFrame(tick);
  });
}

function startFeatures() {
  startTypewriter();
  if (state.statsDone) return;
  if (!('IntersectionObserver' in window)) {
    animateStats();
    return;
  }
  if (!state.statsObserver) {
    state.statsObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          animateStats();
          state.statsObserver.disconnect();
          state.statsObserver = null;
        }
      },
      { threshold: 0.25 }
    );
    state.statsObserver.observe(el.statsRow);
  }
}

function initAppShell() {
  if (!state.gallery.length && state.library.images.length) {
    state.gallery = state.library.images
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((image) => ({ ...image }));
  }

  initNavigation();
  initCursorGlow();
  initRecent();
  updateLibraryBadge();
  renderRecent();
  updateGalleryUI();
  updateImageButtonState();
  updateSitePromptCount();

  refreshReveals();
  if (state.page === 'features') startFeatures();
  if (state.page === 'studio') renderStudio();
  if (state.page === 'images') renderImageGrid();
  if (state.page === 'library') renderLibrary();
}

function toast(title, description = '', type = 'info', action = null) {
  const iconId = type === 'error' ? 'i-alert' : type === 'success' ? 'i-check' : 'i-sparkles';
  const node = document.createElement('div');
  node.className = `toast toast-${type}`;
  node.innerHTML = `<div class="toast-icon"><svg class="icon"><use href="#${iconId}"/></svg></div>
    <div class="toast-copy"><strong>${escapeHtml(title)}</strong>${
      description ? `<span>${escapeHtml(description)}</span>` : ''
    }</div>
    ${action ? `<button class="toast-action" type="button">${escapeHtml(action.label)}</button>` : ''}
    <button class="toast-close" type="button" aria-label="Закрыть">×</button>`;

  let timer = null;
  const remove = () => {
    if (timer) clearTimeout(timer);
    node.classList.remove('show');
    setTimeout(() => node.remove(), 250);
  };

  node.querySelector('.toast-close').addEventListener('click', remove);
  if (action) {
    node.querySelector('.toast-action').addEventListener('click', () => {
      action.fn();
      remove();
    });
  }

  el.toastWrap.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  timer = setTimeout(remove, action ? 6500 : 4500);
}

/* ---------- Events ---------- */

function bindEvents() {
  el.newChatBtn.addEventListener('click', newChat);
  el.brandHome.addEventListener('click', newChat);
  el.menuBtn.addEventListener('click', openSidebar);
  el.sidebarClose.addEventListener('click', closeSidebar);
  el.scrim.addEventListener('click', closeSidebar);

  el.chatSearch.addEventListener('input', () => {
    state.filter = el.chatSearch.value;
    renderSidebar();
  });

  el.chatList.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-del-id]');
    if (remove) {
      event.stopPropagation();
      deleteChat(remove.dataset.delId);
      return;
    }
    const item = event.target.closest('[data-chat-id]');
    if (item) openChat(item.dataset.chatId);
  });

  el.chatList.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('[data-del-id]')) return;
    const item = event.target.closest('[data-chat-id]');
    if (item) {
      event.preventDefault();
      openChat(item.dataset.chatId);
    }
  });

  el.stage.addEventListener('scroll', () => {
    el.topbar.classList.toggle('scrolled', el.stage.scrollTop > 6);
  }, { passive: true });

  el.suggestions.addEventListener('click', (event) => {
    const card = event.target.closest('[data-prompt]');
    if (!card) return;
    el.input.value = card.dataset.prompt;
    autosizeInput();
    updateSendState();
    el.input.focus();
  });

  el.input.addEventListener('input', () => {
    autosizeInput();
    updateSendState();
  });

  el.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !state.generating) {
      event.preventDefault();
      void sendMessage();
    }
  });

  el.sendBtn.addEventListener('click', () => {
    if (state.generating) stopGeneration();
    else void sendMessage();
  });

  el.attachBtn.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', async () => {
    const file = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    await handleFile(file);
  });

  el.exportBtn.addEventListener('click', exportChat);

  el.messages.addEventListener('click', handleMessageClick);

  el.modelBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleModelMenu();
  });

  el.modelMenu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-model]');
    if (!item) return;
    const model = item.dataset.model;
    if (!model) return;
    state.settings.model = model;
    saveSettings();
    closeModelMenu();
    renderTopbar();
    updateModeUI();
    toast('Модель выбрана', shortModel(model), 'success');
  });

  el.modelMenuSettings.addEventListener('click', () => openSettings(true));

  document.addEventListener('click', (event) => {
    if (el.modelMenu.hidden) return;
    if (event.target.closest('#modelMenu') || event.target.closest('#modelBtn')) return;
    closeModelMenu();
  });

  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-open-settings]');
    if (opener) openSettings();
  });

  el.settingsBtn.addEventListener('click', () => openSettings());
  el.settingsBtnTop.addEventListener('click', () => openSettings());
  el.settingsClose.addEventListener('click', closeSettings);
  el.settingsCancel.addEventListener('click', closeSettings);
  el.settingsSave.addEventListener('click', saveSettingsFromForm);
  el.resetSettingsBtn.addEventListener('click', resetSettingsForm);

  el.settingsModal.addEventListener('click', (event) => {
    if (event.target === el.settingsModal) closeSettings();
  });

  el.providerSelect.addEventListener('change', () => {
    const provider = el.providerSelect.value;
    const meta = PROVIDERS[provider] || PROVIDERS.openrouter;
    el.baseUrlInput.value = meta.baseUrl;
    el.modelInput.value = meta.model;
    updateProviderNote();
  });

  el.toggleKey.addEventListener('click', () => {
    const hidden = el.apiKeyInput.type === 'password';
    el.apiKeyInput.type = hidden ? 'text' : 'password';
    el.toggleKey.innerHTML = `<svg class="icon"><use href="#${hidden ? 'i-eye-off' : 'i-eye'}"/></svg>`;
    el.toggleKey.setAttribute('aria-label', hidden ? 'Скрыть ключ' : 'Показать ключ');
  });

  el.loadModelsBtn.addEventListener('click', loadModels);

  el.temperatureInput.addEventListener('input', () => {
    el.tempValue.textContent = Number(el.temperatureInput.value).toFixed(1);
  });

  document.addEventListener('click', (event) => {
    const pageLink = event.target.closest('[data-page-link]');
    if (pageLink) {
      event.preventDefault();
      navigateToPage(pageLink.dataset.pageLink);
      return;
    }
    const go = event.target.closest('[data-go]');
    if (go) {
      event.preventDefault();
      navigateToPage(go.dataset.go);
    }
  });

  /* Studio */
  el.sitePrompt.addEventListener('input', updateSitePromptCount);
  el.sitePrompt.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void generateSite();
    }
  });
  el.siteStyles.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-site-style]');
    if (!chip) return;
    state.siteStyle = chip.dataset.siteStyle;
    setActiveChip(el.siteStyles, 'siteStyle', state.siteStyle);
  });
  el.siteSurpriseBtn.addEventListener('click', fillRandomIdea);
  el.generateSiteBtn.addEventListener('click', () => void generateSite());
  el.studioViewToggle.addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    state.studioView = button.dataset.view;
    renderStudio();
  });
  el.studioDeviceToggle.addEventListener('click', (event) => {
    const button = event.target.closest('[data-device]');
    if (!button) return;
    state.studioDevice = button.dataset.device;
    renderStudio();
  });
  el.saveSiteBtn.addEventListener('click', saveSiteToLibrary);
  el.downloadSiteBtn.addEventListener('click', downloadSiteHtml);
  el.openSiteBtn.addEventListener('click', openSiteInNewTab);
  el.copySiteCode.addEventListener('click', async () => {
    if (!state.site) return;
    const ok = await copyText(state.site.html);
    toast(
      ok ? 'Код скопирован' : 'Не удалось скопировать',
      ok ? 'HTML целиком в буфере обмена.' : 'Выделите код вручную.',
      ok ? 'success' : 'error'
    );
  });

  /* Images */
  el.imagePrompt.addEventListener('input', () => {
    el.imagePrompt.style.height = 'auto';
    el.imagePrompt.style.height = `${Math.min(el.imagePrompt.scrollHeight, 150)}px`;
  });
  el.imagePrompt.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      generateImage();
    }
  });
  el.imageStyles.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-image-style]');
    if (!chip) return;
    state.imageStyle = chip.dataset.imageStyle;
    setActiveChip(el.imageStyles, 'imageStyle', state.imageStyle);
  });
  el.imageAspect.addEventListener('click', (event) => {
    const button = event.target.closest('[data-aspect]');
    if (!button) return;
    state.imageAspect = button.dataset.aspect;
    setActiveChip(el.imageAspect, 'aspect', state.imageAspect);
  });
  el.imageIdeas.addEventListener('click', (event) => {
    const idea = event.target.closest('[data-idea]');
    if (!idea) return;
    el.imagePrompt.value = idea.dataset.idea;
    el.imagePrompt.dispatchEvent(new Event('input'));
    el.imagePrompt.focus();
  });
  el.generateImageBtn.addEventListener('click', generateImage);
  el.imageGrid.addEventListener('click', handleImageGridClick);

  /* Lightbox */
  el.imageLightbox.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-lightbox]')) closeLightbox();
  });
  el.lightboxDownload.addEventListener('click', () => {
    if (state.lightboxItem) void downloadImageFile(state.lightboxItem);
  });
  el.lightboxSave.addEventListener('click', () => {
    if (state.lightboxItem) saveImageToLibrary(state.lightboxItem);
  });

  /* Library */
  el.libraryTabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-lib-tab]');
    if (!tab) return;
    state.libTab = tab.dataset.libTab;
    renderLibrary();
  });
  el.libraryContent.addEventListener('click', handleLibraryClick);

  document.addEventListener('keydown', (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      newChat();
      return;
    }
    if (modifier && event.key === ',') {
      event.preventDefault();
      openSettings();
      return;
    }
    if (event.key === 'Escape') {
      if (!el.imageLightbox.hidden) {
        closeLightbox();
      } else if (!el.settingsModal.hidden) {
        closeSettings();
      } else if (!el.modelMenu.hidden) {
        closeModelMenu();
      } else {
        closeSidebar();
      }
    }
  });
}

/* ---------- Init ---------- */

async function initStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) return;
    const data = await response.json();
    state.envKeys = (data && data.providers) || {};
    if (data && Number(data.imageCooldown) > 0) {
      startImageCooldown(Number(data.imageCooldown));
    }
    updateModeUI();
  } catch {
    /* ignore */
  }
}

function init() {
  [bindLanding, bindProfile].forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error('[Lumio] ошибка привязки', fn.name, error);
    }
  });
  bindEvents();

  if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
    $$('.kbd').forEach((node) => {
      node.textContent = 'Ctrl K';
    });
    const hint = $('.side-btn-hint');
    if (hint) hint.textContent = 'Ctrl ,';
  }

  const lastId = localStorage.getItem(dataKey('last.v1'));
  if (lastId && state.chats.some((chat) => chat.id === lastId)) {
    state.currentId = lastId;
  } else if (state.chats.length) {
    const latest = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    state.currentId = latest.id;
  }

  renderAll();
  initAppShell();
  setTimeout(() => {
    if (state.page === 'chat') scrollToBottom(false);
  }, 60);
  initStatus();

  if (window.matchMedia('(min-width: 901px)').matches) {
    setTimeout(() => {
      if (state.page === 'chat') el.input.focus();
    }, 120);
  }
}

init();
