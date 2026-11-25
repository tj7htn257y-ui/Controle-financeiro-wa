'use strict';

/*
 * MEU CONTROLE FINANCEIRO
 * Cofre local criptografado e sincronização Supabase.
 */

const SUPABASE_URL = 'https://eornyjvzajqnwghqdhfq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_vzdL2qqoEk9850Ha1ygBU_w_cwShRyXY';
const CLOUD_TABLE = 'cofres_financeiros';

const DB_NAME = 'mcf-db';
const STORE_NAME = 'vault';
const PBKDF2_ITERATIONS = 250000;

const $ = id => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

let supabase = null;
let encryptionKey = null;
let records = [];
let currentUser = null;
let cloudEnabled = false;
let syncTimer = null;
let syncInProgress = false;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function month() {
  return today().slice(0, 7);
}

function money(value) {
  return Number(value || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function setStatus(text) {
  if ($('syncStatus')) $('syncStatus').textContent = text;
  if ($('syncInfo')) $('syncInfo').textContent = text;
}

function showMessage(text) {
  if ($('lockMsg')) $('lockMsg').textContent = text;
}

function safeError(error) {
  return error && error.message
    ? error.message
    : 'Erro inesperado.';
}

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();

  return `${Date.now()}-${Array.from(
    crypto.getRandomValues(new Uint8Array(16))
  ).map(x => x.toString(16).padStart(2, '0')).join('')}`;
}

/* SUPABASE */

function initSupabase() {
  if (!window.supabase ||
      typeof window.supabase.createClient !== 'function') {
    return false;
  }

  supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  return true;
}

/* INDEXEDDB */

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);

    request.onerror = () => reject(
      request.error || new Error('Não foi possível abrir o armazenamento local.')
    );

    request.onblocked = () => reject(
      new Error('O armazenamento está ocupado por outra aba.')
    );
  });
}

async function dbGet(name) {
  const db = await openDB();

  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(
        STORE_NAME,
        'readonly'
      ).objectStore(STORE_NAME).get(name);

      request.onsuccess = () => resolve(request.result);

      request.onerror = () => reject(
        request.error || new Error('Falha ao ler os dados locais.')
      );
    });
  } finally {
    db.close();
  }
}

async function dbSet(name, value) {
  return dbSetMany([[name, value]]);
}

async function dbSetMany(entries) {
  const db = await openDB();

  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      for (const [name, value] of entries) {
        store.put(value, name);
      }

      tx.oncomplete = () => resolve();

      tx.onerror = () => reject(
        tx.error || new Error('Falha ao gravar os dados locais.')
      );

      tx.onabort = () => reject(
        tx.error || new Error('Gravação local cancelada.')
      );
    });
  } finally {
    db.close();
  }
}

/* CRIPTOGRAFIA */

async function deriveKey(password, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    material,
    {
      name: 'AES-GCM',
      length: 256
    },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptData(value, key = encryptionKey) {
  if (!key) {
    throw new Error('Aplicativo bloqueado. Entre novamente.');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(value))
  );

  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(cipher))
  };
}

async function decryptData(blob, key = encryptionKey) {
  if (
    !key ||
    !blob ||
    !Array.isArray(blob.iv) ||
    !Array.isArray(blob.data)
  ) {
    throw new Error('Dados criptografados inválidos ou incompletos.');
  }

  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(blob.iv)
    },
    key,
    new Uint8Array(blob.data)
  );

  return JSON.parse(dec.decode(plain));
}

/* LANÇAMENTOS */

function normalizeRecords(list) {
  if (!Array.isArray(list)) {
    throw new Error('A lista de lançamentos está inválida.');
  }

  return list.map(item => {
    if (!item || typeof item !== 'object') {
      throw new Error('Foi encontrado um lançamento inválido.');
    }

    const value = Number(item.value);
    const date = String(item.date || '');
    const desc = String(item.desc || '').trim();

    if (
      !desc ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !['in', 'out'].includes(item.type) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      throw new Error(
        'Existe um lançamento com descrição, valor, tipo ou data inválida.'
      );
    }

    return {
      id: String(item.id || makeId()),
      desc,
      value,
      type: item.type,
      category: String(item.category || 'Outros'),
      date
    };
  });
}

function mergeRecords(localList, cloudList) {
  const merged = new Map();

  for (const item of localList) {
    merged.set(String(item.id), item);
  }

  for (const item of cloudList) {
    const id = String(item.id);

    if (!merged.has(id)) {
      merged.set(id, item);
    }
  }

  return normalizeRecords(Array.from(merged.values()));
}

async function persistLocal() {
  const goal = Number(localStorage.getItem('goal') || 15);

  const encrypted = await encryptData({
    records,
    goal
  });

  await dbSet('data', encrypted);
}

async function readLocalWithPassword(password) {
  const meta = await dbGet('meta');

  if (!meta || !Array.isArray(meta.salt)) {
    throw new Error('Não há cofre local neste aparelho.');
  }

  const localKey = await deriveKey(
    password,
    new Uint8Array(meta.salt)
  );

  const blob = await dbGet('data');

  if (!blob) {
    throw new Error('O cofre local não contém dados salvos.');
  }

  const data = await decryptData(blob, localKey);

  return {
    key: localKey,
    records: normalizeRecords(data.records || []),
    goal: Number(data.goal ?? 15),
    salt: meta.salt
  };
}

async function localUnlock(password) {
  const local = await readLocalWithPassword(password);

  encryptionKey = local.key;
  records = local.records;

  localStorage.setItem('goal', String(local.goal));
}

async function createLocalVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const newKey = await deriveKey(password, salt);

  const previousKey = encryptionKey;
  const previousRecords = records;

  encryptionKey = newKey;
  records = [];

  try {
    const encrypted = await encryptData(
      { records, goal: 15 },
      newKey
    );

    await dbSetMany([
      ['data', encrypted],
      ['meta', { salt: Array.from(salt) }]
    ]);

    localStorage.setItem('goal', '15');

  } catch (error) {
    encryptionKey = previousKey;
    records = previousRecords;
    throw error;
  }
}

/* SINCRONIZAÇÃO NA NUVEM */

async function cloudGet() {
  if (!currentUser) return null;

  const { data, error } = await supabase
    .from(CLOUD_TABLE)
    .select('payload,updated_at')
    .eq('user_id', currentUser.id)
    .maybeSingle();

  if (error) throw error;

  return data ? data.payload : null;
}

async function cloudSave() {
  if (!cloudEnabled || !currentUser || !encryptionKey) {
    return;
  }

  const meta = await dbGet('meta');

  if (!meta || !Array.isArray(meta.salt)) {
    throw new Error('A chave local não foi encontrada.');
  }

  const payload = {
    version: 1,
    salt: meta.salt,
    ...await encryptData({
      records,
      goal: Number(localStorage.getItem('goal') || 15)
    })
  };

  const { error } = await supabase
    .from(CLOUD_TABLE)
    .upsert(
      {
        user_id: currentUser.id,
        payload,
        updated_at: new Date().toISOString()
      },
      {
        onConflict: 'user_id'
      }
    );

  if (error) throw error;

  setStatus(
    'Sincronizado com segurança em ' +
    new Date().toLocaleString('pt-BR') + '.'
  );
}

async function restoreCloudPayload(payload, password) {
  if (!payload) return false;

  if (
    payload.version !== 1 ||
    !Array.isArray(payload.salt)
  ) {
    throw new Error('O formato do cofre na nuvem não é reconhecido.');
  }

  const cloudKey = await deriveKey(
    password,
    new Uint8Array(payload.salt)
  );

  const cloudData = await decryptData(
    {
      iv: payload.iv,
      data: payload.data
    },
    cloudKey
  );

  const cloudRecords = normalizeRecords(
    cloudData.records || []
  );

  let mergedRecords = cloudRecords;

  const localMeta = await dbGet('meta');
  const localBlob = await dbGet('data');

  if (localMeta && localBlob) {
    const local = await readLocalWithPassword(password);

    mergedRecords = mergeRecords(
      local.records,
      cloudRecords
    );
  }

  const goal = Number(cloudData.goal ?? 15);

  if (!Number.isFinite(goal) || goal < 0 || goal > 100) {
    throw new Error('A meta salva na nuvem é inválida.');
  }

  const encryptedLocal = await encryptData(
    { records: mergedRecords, goal },
    cloudKey
  );

  await dbSetMany([
    ['meta', { salt: payload.salt }],
    ['data', encryptedLocal]
  ]);

  encryptionKey = cloudKey;
  records = mergedRecords;

  localStorage.setItem('goal', String(goal));

  return true;
}

async function syncNow() {
  if (!currentUser || !cloudEnabled || !encryptionKey) {
    setStatus('Entre na sua conta para sincronizar.');
    return;
  }

  if (syncInProgress) return;

  syncInProgress = true;
  setStatus('Sincronizando...');

  try {
    const payload = await cloudGet();

    if (payload) {
      const cloudData = await decryptData(
        {
          iv: payload.iv,
          data: payload.data
        },
        encryptionKey
      );

      const cloudRecords = normalizeRecords(
        cloudData.records || []
      );

      records = mergeRecords(records, cloudRecords);

      await persistLocal();
    }

    await cloudSave();

  } finally {
    syncInProgress = false;
  }
}

function scheduleSync() {
  if (!cloudEnabled || !currentUser) return;

  clearTimeout(syncTimer);

  syncTimer = setTimeout(() => {
    syncNow().catch(error => {
      setStatus('Falha na sincronização: ' + safeError(error));
    });
  }, 900);
}

/* ACESSO */

async function openApp() {
  $('lock').classList.add('hidden');
  $('app').classList.remove('hidden');

  $('cloudLabel').textContent = cloudEnabled
    ? 'Conta conectada · sincronização ativada'
    : 'Modo local/offline';

  $('date').value = today();

  render();
}

async function login() {
  const email = $('email').value.trim();
  const password = $('pass').value;

  if (!email || !password) {
    throw new Error('Informe e-mail e senha.');
  }

  if (password.length < 8) {
    throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  }

  if (!supabase) {
    throw new Error('A biblioteca do Supabase não carregou. Verifique a conexão.');
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) throw error;

  currentUser = data.user;
  cloudEnabled = true;

  try {
    const payload = await cloudGet();

    const restored = await restoreCloudPayload(
      payload,
      password
    );

    if (!restored) {
      const meta = await dbGet('meta');

      if (meta) {
        await localUnlock(password);
      } else {
        await createLocalVault(password);
      }

      await cloudSave();

    } else {
      await cloudSave();
    }

  } catch (error) {
    await supabase.auth.signOut().catch(() => {});

    currentUser = null;
    cloudEnabled = false;

    throw error;
  }

  $('pass').value = '';

  setStatus('Conta conectada e dados sincronizados.');

  await openApp();
}

async function signup() {
  const email = $('email').value.trim();
  const password = $('pass').value;

  if (!email || !password) {
    throw new Error('Informe e-mail e senha.');
  }

  if (password.length < 8) {
    throw new Error('Use uma senha com pelo menos 8 caracteres.');
  }

  if (!supabase) {
    throw new Error('A biblioteca do Supabase não carregou. Verifique a conexão.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password
  });

  if (error) throw error;

  if (!data.session || !data.user) {
    showMessage(
      'Cadastro iniciado. Confirme o e-mail recebido e depois entre no aplicativo.'
    );
    return;
  }

  currentUser = data.user;
  cloudEnabled = true;

  try {
    const meta = await dbGet('meta');

    if (meta) {
      await localUnlock(password);
    } else {
      await createLocalVault(password);
    }

    await cloudSave();

  } catch (error) {
    await supabase.auth.signOut().catch(() => {});

    currentUser = null;
    cloudEnabled = false;

    throw error;
  }

  $('pass').value = '';

  setStatus('Conta criada e cofre sincronizado.');

  await openApp();
}

async function offlineLogin() {
  const password = $('pass').value;

  if (!password) {
    throw new Error('Digite sua senha de proteção.');
  }

  await localUnlock(password);

  currentUser = null;
  cloudEnabled = false;

  $('pass').value = '';

  setStatus(
    'Acesso local. Entre na conta com internet para sincronizar.'
  );

  await openApp();
}

/* INTERFACE */

function showTab(tab) {
  ['home', 'add', 'goals', 'settings'].forEach(name => {
    $(name).classList.toggle('hidden', name !== tab);
  });

  if (tab === 'goals') {
    $('goalPercent').value = Number(
      localStorage.getItem('goal') || 15
    );
  }
}

window.showTab = showTab;

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function render() {
  const selectedMonth = month();

  const monthly = records.filter(item =>
    item.date.slice(0, 7) === selectedMonth
  );

  const income = monthly
    .filter(item => item.type === 'in')
    .reduce((sum, item) => sum + item.value, 0);

  const expense = monthly
    .filter(item => item.type === 'out')
    .reduce((sum, item) => sum + item.value, 0);

  const goal = Number(localStorage.getItem('goal') || 15);
  const target = income * goal / 100;
  const saved = income - expense;

  $('monthLabel').textContent = new Date().toLocaleDateString(
    'pt-BR',
    { month: 'long', year: 'numeric' }
  );

  $('balance').textContent = money(saved);
  $('income').textContent = money(income);
  $('expense').textContent = money(expense);

  $('goalText').textContent =
    `Meta: ${goal}% da renda (${money(target)}). Saldo atual: ${money(saved)}.`;

  $('goalProgress').value = target > 0
    ? Math.max(0, Math.min(100, saved / target * 100))
    : 0;

  $('goalPercent').value = goal;

  const sorted = [...monthly].sort((a, b) =>
    b.date.localeCompare(a.date)
  );

  $('transactions').innerHTML = sorted.length
    ? sorted.map(item => `
      <div class="item">
        <div>
          <strong>${escapeHTML(item.desc)}</strong>
          <small>
            ${item.date.split('-').reverse().join('/')}
            · ${escapeHTML(item.category)}
          </small>
        </div>

        <strong class="amount ${item.type}">
          ${item.type === 'in' ? '+' : '−'} ${money(item.value)}
        </strong>
      </div>
    `).join('')
    : '<p class="muted">Nenhum lançamento neste mês.</p>';
}

/* EVENTOS */

$('loginBtn').onclick = async () => {
  try {
    showMessage('');
    await login();
  } catch (error) {
    showMessage('Não foi possível entrar: ' + safeError(error));
  }
};

$('createBtn').onclick = async () => {
  try {
    showMessage('');
    await signup();
  } catch (error) {
    showMessage('Não foi possível criar a conta: ' + safeError(error));
  }
};

$('offlineBtn').onclick = async () => {
  try {
    showMessage('');
    await offlineLogin();
  } catch (error) {
    showMessage(safeError(error));
  }
};

$('saveBtn').onclick = async () => {
  const desc = $('desc').value.trim();
  const value = Number($('value').value);
  const date = $('date').value || today();

  if (!desc || !Number.isFinite(value) || value <= 0) {
    alert('Informe uma descrição e um valor válido.');
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    alert('Informe uma data válida.');
    return;
  }

  const item = {
    id: makeId(),
    desc,
    value,
    type: $('type').value,
    category: $('category').value,
    date
  };

  records.push(item);

  try {
    await persistLocal();

    $('desc').value = '';
    $('value').value = '';
    $('date').value = today();

    showTab('home');
    render();

    if (cloudEnabled) {
      scheduleSync();
    } else {
      setStatus('Lançamento salvo com segurança neste aparelho.');
    }

  } catch (error) {
    records = records.filter(record =>
      record.id !== item.id
    );

    alert(
      'Não foi possível salvar. Os dados anteriores foram preservados. ' +
      safeError(error)
    );
  }
};

$('goalSave').onclick = async () => {
  const raw = $('goalPercent').value;
  const value = Number(raw);

  if (
    raw.trim() === '' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    alert('Informe um percentual entre 0 e 100.');
    return;
  }

  const oldGoal = localStorage.getItem('goal');

  try {
    localStorage.setItem('goal', String(value));

    await persistLocal();

    render();

    if (cloudEnabled) scheduleSync();

    alert('Meta salva.');

  } catch (error) {
    if (oldGoal === null) {
      localStorage.removeItem('goal');
    } else {
      localStorage.setItem('goal', oldGoal);
    }

    alert(
      'Não foi possível salvar a meta. ' +
      safeError(error)
    );
  }
};

/* BACKUP */

function download(data, filename, type) {
  const link = document.createElement('a');

  const url = URL.createObjectURL(
    new Blob([data], { type })
  );

  link.href = url;
  link.download = filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('exportBtn').onclick = async () => {
  const password = prompt(
    'Confirme sua senha de proteção para exportar o backup:'
  );

  if (!password) return;

  try {
    const meta = await dbGet('meta');

    if (!meta || !Array.isArray(meta.salt)) {
      throw new Error('Cofre local não encontrado.');
    }

    const backupKey = await deriveKey(
      password,
      new Uint8Array(meta.salt)
    );

    await decryptData(
      await dbGet('data'),
      backupKey
    );

    const encrypted = await encryptData(
      {
        records,
        goal: Number(localStorage.getItem('goal') || 15)
      },
      backupKey
    );

    download(
      JSON.stringify({
        version: 2,
        salt: meta.salt,
        ...encrypted
      }),
      `backup-meu-financeiro-${today()}.json`,
      'application/json'
    );

  } catch (error) {
    alert(
      'Não foi possível exportar. Confira a senha. ' +
      safeError(error)
    );
  }
};

$('importBtn').onclick = async () => {
  const file = $('backupFile').files[0];
  const password = $('backupPass').value;

  if (!file || !password) {
    alert('Escolha o arquivo e informe a senha do backup.');
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    alert('O arquivo de backup é muito grande.');
    return;
  }

  if (!confirm(
    'A restauração substituirá os lançamentos atuais. Deseja continuar?'
  )) {
    return;
  }

  try {
    const backup = JSON.parse(await file.text());

    if (
      ![1, 2].includes(backup.version) ||
      !Array.isArray(backup.salt)
    ) {
      throw new Error('Formato de backup inválido.');
    }

    const backupKey = await deriveKey(
      password,
      new Uint8Array(backup.salt)
    );

    const data = await decryptData(backup, backupKey);

    const importedRecords = normalizeRecords(
      data.records || []
    );

    const goal = Number(data.goal ?? 15);

    if (!Number.isFinite(goal) || goal < 0 || goal > 100) {
      throw new Error('Meta inválida.');
    }

    const encryptedLocal = await encryptData(
      { records: importedRecords, goal },
      backupKey
    );

    await dbSetMany([
      ['meta', { salt: backup.salt }],
      ['data', encryptedLocal]
    ]);

    encryptionKey = backupKey;
    records = importedRecords;

    localStorage.setItem('goal', String(goal));

    $('backupFile').value = '';
    $('backupPass').value = '';

    render();

    if (cloudEnabled) scheduleSync();

    alert('Backup restaurado com sucesso.');

  } catch (error) {
    alert(
      'Não foi possível restaurar. Verifique o arquivo e a senha. ' +
      safeError(error)
    );
  }
};

/* SINCRONIZAR E SAIR */

$('syncBtn').onclick = () => {
  syncNow().catch(error => {
    setStatus('Falha na sincronização: ' + safeError(error));
  });
};

$('logoutBtn').onclick = async () => {
  clearTimeout(syncTimer);

  try {
    if (supabase && currentUser) {
      await supabase.auth.signOut();
    }
  } catch (_) {}

  encryptionKey = null;
  records = [];
  currentUser = null;
  cloudEnabled = false;

  $('app').classList.add('hidden');
  $('lock').classList.remove('hidden');
  $('pass').value = '';

  setStatus(
    'Aplicativo bloqueado. Os dados locais permanecem criptografados.'
  );
};

window.addEventListener('online', () => {
  if (cloudEnabled) {
    syncNow().catch(error => {
      setStatus('Falha ao reconectar: ' + safeError(error));
    });
  }
});

/* SERVICE WORKER */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', {
      updateViaCache: 'none'
    })
    .then(registration => registration.update().catch(() => {}))
    .catch(error => console.error('Service Worker:', error));
  });
}

/* INICIALIZAÇÃO */

(function boot() {
  if (!initSupabase()) {
    showMessage(
      'A biblioteca do Supabase não carregou. ' +
      'Você ainda pode usar o modo offline neste aparelho.'
    );
  }

  $('date').value = today();
})();
