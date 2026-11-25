
'use strict';

/*
 * Meu Controle Financeiro
 * Cofre criptografado localmente e sincronizado com Supabase.
 *
 * Tabela: cofres_financeiros
 * Colunas: user_id (uuid), payload (jsonb), updated_at (timestamptz)
 */

const SUPABASE_URL = 'https://eornyjvzajqnwghqdhfq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_vzdL2qqoEk9850Ha1ygBU_w_cwShRyXY';
const CLOUD_TABLE = 'cofres_financeiros';

const DB = 'mcf-db';
const STORE = 'vault';
const PBKDF2_ITERATIONS = 250000;
const BACKUP_MAX_SIZE = 10 * 1024 * 1024;
const SYNC_RETRIES = 5;

const $ = id => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

let supabase = null;
let key = null;
let records = [];
let currentUser = null;
let cloudEnabled = false;
let syncTimer = null;
let syncInProgress = false;
let syncRequested = false;
let localRevision = 0;
let syncedRevision = 0;
let goal = 15;
let goalUpdatedAt = 0;
let sessionGeneration = 0;

/* UTILITÁRIOS */

function today() {
  const d = new Date();

  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
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

function setStatus(message) {
  if ($('syncStatus')) $('syncStatus').textContent = message;
  if ($('syncInfo')) $('syncInfo').textContent = message;
}

function showMessage(message) {
  if ($('lockMsg')) $('lockMsg').textContent = message;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return false;
  }

  const [year, monthNumber, day] = value.split('-').map(Number);
  const date = new Date(year, monthNumber - 1, day);

  return (
    date.getFullYear() === year &&
    date.getMonth() === monthNumber - 1 &&
    date.getDate() === day
  );
}

function validGoal(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();

  return (
    Date.now().toString(36) +
    '-' +
    crypto.getRandomValues(new Uint32Array(2)).join('-')
  );
}

function sameSalt(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}

function ensureSession(generation, userId) {
  if (
    generation !== sessionGeneration ||
    !currentUser ||
    currentUser.id !== userId ||
    !cloudEnabled
  ) {
    throw new Error('A sessão mudou. Operação interrompida por segurança.');
  }
}

function initSupabase() {
  if (!window.supabase || !window.supabase.createClient) {
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

/* BANCO LOCAL */

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(name) {
  const db = await openDB();

  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE)
        .objectStore(STORE)
        .get(name);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function dbSet(name, value) {
  const db = await openDB();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');

      transaction.objectStore(STORE).put(value, name);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(
        transaction.error || new Error('Gravação local cancelada.')
      );
    });
  } finally {
    db.close();
  }
}

async function dbSetMany(values) {
  const db = await openDB();

  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      const objectStore = transaction.objectStore(STORE);

      for (const [name, value] of Object.entries(values)) {
        objectStore.put(value, name);
      }

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(
        transaction.error || new Error('Gravação local cancelada.')
      );
    });
  } finally {
    db.close();
  }
}

/* CRIPTOGRAFIA */

async function derive(pass, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(pass),
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

async function encrypt(data, encryptionKey = key) {
  if (!encryptionKey) {
    throw new Error('Aplicativo bloqueado.');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv
    },
    encryptionKey,
    enc.encode(JSON.stringify(data))
  );

  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted))
  };
}

async function decrypt(blob, encryptionKey = key) {
  if (
    !encryptionKey ||
    !blob ||
    !Array.isArray(blob.iv) ||
    !Array.isArray(blob.data)
  ) {
    throw new Error('Dados criptografados inválidos.');
  }

  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(blob.iv)
    },
    encryptionKey,
    new Uint8Array(blob.data)
  );

  return JSON.parse(dec.decode(plain));
}

function validateEncryptedPayload(payload) {
  if (
    !payload ||
    payload.version !== 1 ||
    !Array.isArray(payload.salt) ||
    payload.salt.length !== 16 ||
    !Array.isArray(payload.iv) ||
    payload.iv.length !== 12 ||
    !Array.isArray(payload.data)
  ) {
    throw new Error('Formato do cofre criptografado inválido.');
  }
}

/* VALIDAÇÃO DOS LANÇAMENTOS */

function normalizeRecords(list) {
  if (!Array.isArray(list)) {
    throw new Error('Lista de lançamentos inválida.');
  }

  if (list.length > 100000) {
    throw new Error('Quantidade de lançamentos acima do limite.');
  }

  const ids = new Set();

  return list.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Lançamento inválido.');
    }

    const value = Number(item.value);
    const date = String(item.date || '');
    const desc = String(item.desc || '').trim();
    const type = item.type;

    if (
      !desc ||
      desc.length > 300 ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !['in', 'out'].includes(type) ||
      !validDate(date)
    ) {
      throw new Error('Existe um lançamento com dados inválidos.');
    }

    const id = String(item.id || randomId());

    if (id.length > 100 || ids.has(id)) {
      throw new Error('Existem lançamentos com identificadores inválidos ou repetidos.');
    }

    ids.add(id);

    return {
      id,
      desc,
      value,
      type,
      category: String(item.category || 'Outros').slice(0, 100),
      date
    };
  });
}

/*
 * Não existe exclusão de lançamentos na interface atual.
 * Por isso, a combinação preserva registros existentes e evita
 * que uma sincronização substitua lançamentos de outro aparelho.
 */

function mergeRecords(localList, cloudList) {
  const map = new Map();

  for (const item of localList) {
    map.set(String(item.id), item);
  }

  for (const item of cloudList) {
    map.set(String(item.id), item);
  }

  return normalizeRecords([...map.values()]);
}

/* COFRE LOCAL */

function makeVaultData() {
  return {
    records: normalizeRecords(records),
    goal,
    goalUpdatedAt
  };
}

async function persistLocal() {
  if (!key) {
    throw new Error('Cofre bloqueado. Não foi possível salvar.');
  }

  const encrypted = await encrypt(makeVaultData());

  await dbSet('data', encrypted);

  localRevision++;
}

async function persistLocalWithMeta(meta, data) {
  const encrypted = await encrypt(data);

  await dbSetMany({
    meta,
    data: encrypted
  });

  localRevision++;
}

async function localUnlock(pass) {
  const meta = await dbGet('meta');
  const blob = await dbGet('data');

  if (!meta || !Array.isArray(meta.salt) || !blob) {
    throw new Error('Cofre local incompleto ou inexistente.');
  }

  const localKey = await derive(
    pass,
    new Uint8Array(meta.salt)
  );

  const data = await decrypt(blob, localKey);
  const loadedRecords = normalizeRecords(data.records || []);
  const loadedGoal = Number(data.goal ?? 15);

  if (!validGoal(loadedGoal)) {
    throw new Error('A meta armazenada no cofre é inválida.');
  }

  key = localKey;
  records = loadedRecords;
  goal = loadedGoal;
  goalUpdatedAt = Number(data.goalUpdatedAt || 0);

  localRevision = 0;
  syncedRevision = 0;

  return meta;
}

async function createLocalVault(pass, userId = null) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const newKey = await derive(pass, salt);

  const newMeta = {
    salt: Array.from(salt),
    userId
  };

  const oldKey = key;

  key = newKey;
  records = [];
  goal = 15;
  goalUpdatedAt = Date.now();

  try {
    const encrypted = await encrypt(makeVaultData(), newKey);

    await dbSetMany({
      meta: newMeta,
      data: encrypted
    });

    localRevision = 0;
    syncedRevision = 0;
  } catch (error) {
    key = oldKey;
    throw error;
  }
}

/* NUVEM */

async function cloudGet(userId = currentUser?.id) {
  if (!userId || !supabase) return null;

  const { data, error } = await supabase
    .from(CLOUD_TABLE)
    .select('payload,updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  return data || null;
}

async function decodeCloudPayload(payload, encryptionKey) {
  validateEncryptedPayload(payload);

  const data = await decrypt({
    iv: payload.iv,
    data: payload.data
  }, encryptionKey);

  return {
    records: normalizeRecords(data.records || []),
    goal: Number(data.goal ?? 15),
    goalUpdatedAt: Number(data.goalUpdatedAt || 0)
  };
}

async function cloudRestore(pass, generation, userId) {
  const cloudRow = await cloudGet(userId);

  ensureSession(generation, userId);

  if (!cloudRow) return false;

  const payload = cloudRow.payload;
  validateEncryptedPayload(payload);

  const cloudKey = await derive(
    pass,
    new Uint8Array(payload.salt)
  );

  const cloudData = await decodeCloudPayload(payload, cloudKey);

  ensureSession(generation, userId);

  const localMeta = await dbGet('meta');
  const localBlob = await dbGet('data');

  let localRecords = [];
  let localGoal = 15;
  let localGoalUpdatedAt = 0;

  if (localMeta || localBlob) {
    if (!localMeta || !localBlob || !Array.isArray(localMeta.salt)) {
      throw new Error(
        'O cofre local está incompleto. Os dados foram preservados.'
      );
    }

    if (localMeta.userId !== userId) {
      throw new Error(
        'O cofre local não está vinculado a esta conta. ' +
        'Não vou misturar os dados.'
      );
    }

    try {
      const localKey = await derive(
        pass,
        new Uint8Array(localMeta.salt)
      );

      const localData = await decrypt(localBlob, localKey);

      localRecords = normalizeRecords(localData.records || []);
      localGoal = Number(localData.goal ?? 15);
      localGoalUpdatedAt = Number(localData.goalUpdatedAt || 0);

      if (!validGoal(localGoal)) {
        throw new Error('Meta local inválida.');
      }
    } catch (_) {
      throw new Error(
        'A senha não desbloqueia o cofre local. ' +
        'Os dados locais foram preservados.'
      );
    }
  }

  ensureSession(generation, userId);

  const mergedRecords = mergeRecords(
    localRecords,
    cloudData.records
  );

  const useLocalGoal = localGoalUpdatedAt > cloudData.goalUpdatedAt;

  const mergedGoal = useLocalGoal
    ? localGoal
    : cloudData.goal;

  const mergedGoalUpdatedAt = useLocalGoal
    ? localGoalUpdatedAt
    : cloudData.goalUpdatedAt;

  const newMeta = {
    salt: payload.salt,
    userId
  };

  const newData = {
    records: mergedRecords,
    goal: mergedGoal,
    goalUpdatedAt: mergedGoalUpdatedAt
  };

  key = cloudKey;
  records = mergedRecords;
  goal = mergedGoal;
  goalUpdatedAt = mergedGoalUpdatedAt;

  await persistLocalWithMeta(newMeta, newData);

  ensureSession(generation, userId);

  return true;
}

/*
 * Atualização otimista:
 * - lê a versão atual da nuvem;
 * - combina os lançamentos;
 * - atualiza somente se updated_at ainda for o mesmo;
 * - se outro aparelho gravar antes, tenta novamente.
 *
 * A tabela continua usando as três colunas já definidas.
 */

async function cloudSave() {
  if (!cloudEnabled || !currentUser || !key) {
    throw new Error('Entre na conta para sincronizar.');
  }

  const generation = sessionGeneration;
  const userId = currentUser.id;

  for (let attempt = 0; attempt < SYNC_RETRIES; attempt++) {
    ensureSession(generation, userId);

    const meta = await dbGet('meta');

    if (
      !meta ||
      !Array.isArray(meta.salt) ||
      meta.userId !== userId
    ) {
      throw new Error('Cofre local não pertence à conta conectada.');
    }

    const cloudRow = await cloudGet(userId);

    ensureSession(generation, userId);

    let cloudRecords = [];
    let cloudGoal = 15;
    let cloudGoalUpdatedAt = 0;

    if (cloudRow) {
      validateEncryptedPayload(cloudRow.payload);

      if (!sameSalt(meta.salt, cloudRow.payload.salt)) {
        throw new Error(
          'A chave de proteção local é diferente da chave da nuvem. ' +
          'Entre novamente para restaurar o cofre.'
        );
      }

      const cloudData = await decodeCloudPayload(
        cloudRow.payload,
        key
      );

      cloudRecords = cloudData.records;
      cloudGoal = cloudData.goal;
      cloudGoalUpdatedAt = cloudData.goalUpdatedAt;
    }

    const merged = mergeRecords(records, cloudRecords);

    let mergedGoal = goal;
    let mergedGoalUpdatedAt = goalUpdatedAt;

    if (cloudGoalUpdatedAt > goalUpdatedAt) {
      mergedGoal = cloudGoal;
      mergedGoalUpdatedAt = cloudGoalUpdatedAt;
    }

    ensureSession(generation, userId);

    records = merged;
    goal = mergedGoal;
    goalUpdatedAt = mergedGoalUpdatedAt;

    await persistLocal();

    const encrypted = await encrypt(makeVaultData());

    const payload = {
      version: 1,
      salt: meta.salt,
      ...encrypted
    };

    ensureSession(generation, userId);

    const updatedAt = new Date().toISOString();

    if (!cloudRow) {
      const { error } = await supabase
        .from(CLOUD_TABLE)
        .insert({
          user_id: userId,
          payload,
          updated_at: updatedAt
        });

      if (!error) {
        syncedRevision = localRevision;
        setStatus(
          'Sincronizado com segurança em ' +
          new Date().toLocaleString('pt-BR') + '.'
        );
        return;
      }

      if (error.code === '23505') {
        continue;
      }

      throw error;
    }

    const { data, error } = await supabase
      .from(CLOUD_TABLE)
      .update({
        payload,
        updated_at: updatedAt
      })
      .eq('user_id', userId)
      .eq('updated_at', cloudRow.updated_at)
      .select('user_id')
      .maybeSingle();

    if (error) throw error;

    if (data) {
      syncedRevision = localRevision;

      setStatus(
        'Sincronizado com segurança em ' +
        new Date().toLocaleString('pt-BR') + '.'
      );

      return;
    }
  }

  throw new Error(
    'Outro aparelho está atualizando os dados neste momento. ' +
    'Tente sincronizar novamente.'
  );
}

/* FILA DE SINCRONIZAÇÃO */

async function syncNow() {
  if (!currentUser || !cloudEnabled || !key) {
    setStatus('Entre na conta para sincronizar.');
    return;
  }

  if (syncInProgress) {
    syncRequested = true;
    return;
  }

  syncInProgress = true;

  const generation = sessionGeneration;

  try {
    do {
      syncRequested = false;
      setStatus('Sincronizando...');

      await cloudSave();

      if (generation !== sessionGeneration) return;

      if (localRevision > syncedRevision) {
        syncRequested = true;
      }
    } while (syncRequested);

  } finally {
    syncInProgress = false;
  }

  if (
    cloudEnabled &&
    currentUser &&
    localRevision > syncedRevision
  ) {
    scheduleSync();
  }
}

function scheduleSync() {
  if (!cloudEnabled || !currentUser) return;

  clearTimeout(syncTimer);

  syncTimer = setTimeout(() => {
    syncNow().catch(error => {
      setStatus(
        'Falha na sincronização: ' +
        (error.message || 'erro desconhecido')
      );
    });
  }, 1000);
}

/* ABERTURA DO APLICATIVO */

async function openApp() {
  $('lock').classList.add('hidden');
  $('app').classList.remove('hidden');

  $('cloudLabel').textContent = cloudEnabled
    ? 'Conta conectada · sincronização ativada'
    : 'Modo local/offline';

  $('date').value = today();

  render();
}

async function initializeAccount(pass, user) {
  currentUser = user;
  cloudEnabled = true;

  sessionGeneration++;
  const generation = sessionGeneration;

  try {
    const exists = await cloudRestore(pass, generation, user.id);

    ensureSession(generation, user.id);

    if (!exists) {
      const meta = await dbGet('meta');
      const blob = await dbGet('data');

      if (meta || blob) {
        if (!meta || !blob || !Array.isArray(meta.salt)) {
          throw new Error(
            'O cofre local está incompleto. ' +
            'Os dados foram preservados.'
          );
        }

        if (meta.userId !== user.id) {
          throw new Error(
            'O cofre local pertence a outra conta ou não está vinculado. ' +
            'Não vou enviar esses dados para esta conta.'
          );
        }

        await localUnlock(pass);
      } else {
        await createLocalVault(pass, user.id);
      }

      ensureSession(generation, user.id);

      await cloudSave();
    }

    ensureSession(generation, user.id);

    $('pass').value = '';
    setStatus('Conta conectada e dados sincronizados.');

    await openApp();

  } catch (error) {
    sessionGeneration++;
    currentUser = null;
    cloudEnabled = false;
    key = null;

    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (_) {}

    throw error;
  }
}

/* LOGIN E CADASTRO */

async function login() {
  const email = $('email').value.trim();
  const pass = $('pass').value;

  if (!email || !pass) {
    throw new Error('Informe e-mail e senha.');
  }

  if (pass.length < 8) {
    throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  }

  if (!supabase) {
    throw new Error(
      'Biblioteca do Supabase não carregada. Verifique a internet.'
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: pass
  });

  if (error) throw error;

  await initializeAccount(pass, data.user);
}

async function signup() {
  const email = $('email').value.trim();
  const pass = $('pass').value;

  if (!email || !pass) {
    throw new Error('Informe e-mail e senha.');
  }

  if (pass.length < 8) {
    throw new Error('Use uma senha com pelo menos 8 caracteres.');
  }

  if (!supabase) {
    throw new Error(
      'Biblioteca do Supabase não carregada. Verifique a internet.'
    );
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password: pass
  });

  if (error) throw error;

  if (!data.session || !data.user) {
    showMessage(
      'Cadastro iniciado. Confirme o e-mail recebido. ' +
      'Depois volte e entre no aplicativo.'
    );
    return;
  }

  await initializeAccount(pass, data.user);
}

async function offlineLogin() {
  const pass = $('pass').value;

  if (!pass) {
    throw new Error('Digite sua senha de proteção.');
  }

  await localUnlock(pass);

  sessionGeneration++;
  currentUser = null;
  cloudEnabled = false;

  clearTimeout(syncTimer);

  if (supabase) {
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (_) {}
  }

  $('pass').value = '';

  setStatus(
    'Acesso local. Seus dados permanecem neste aparelho. ' +
    'Entre na conta com internet para sincronizar.'
  );

  await openApp();
}

/* INTERFACE */

function showTab(tab) {
  ['home', 'add', 'goals', 'settings'].forEach(name => {
    $(name).classList.toggle('hidden', name !== tab);
  });

  if (tab === 'goals') {
    $('goalPercent').value = goal;
  }
}

window.showTab = showTab;

function esc(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function render() {
  const currentMonth = month();

  const monthly = records.filter(item =>
    item.date.slice(0, 7) === currentMonth
  );

  const income = monthly
    .filter(item => item.type === 'in')
    .reduce((sum, item) => sum + item.value, 0);

  const expense = monthly
    .filter(item => item.type === 'out')
    .reduce((sum, item) => sum + item.value, 0);

  const target = income * goal / 100;
  const saved = income - expense;

  $('monthLabel').textContent = new Date().toLocaleDateString(
    'pt-BR',
    {
      month: 'long',
      year: 'numeric'
    }
  );

  $('balance').textContent = money(saved);
  $('income').textContent = money(income);
  $('expense').textContent = money(expense);

  $('goalText').textContent =
    `Meta: ${goal}% da renda (${money(target)}). ` +
    `Saldo atual: ${money(saved)}.`;

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
          ${esc(item.desc)}
          <small>
            ${item.date.split('-').reverse().join('/')}
            · ${esc(item.category)}
          </small>
        </div>
        <strong class="amount ${item.type}">
          ${item.type === 'in' ? '+' : '−'} ${money(item.value)}
        </strong>
      </div>
    `).join('')
    : '<p class="muted">Nenhum lançamento neste mês.</p>';
}

/* BOTÕES DE ACESSO */

$('loginBtn').onclick = async () => {
  try {
    showMessage('');
    await login();
  } catch (error) {
    showMessage(
      'Não foi possível entrar: ' +
      (error.message || 'verifique seus dados.')
    );
  }
};

$('createBtn').onclick = async () => {
  try {
    showMessage('');
    await signup();
  } catch (error) {
    showMessage(
      'Não foi possível criar a conta: ' +
      (error.message || 'erro desconhecido')
    );
  }
};

$('offlineBtn').onclick = async () => {
  try {
    showMessage('');
    await offlineLogin();
  } catch (error) {
    showMessage(
      error.message || 'Não foi possível abrir os dados locais.'
    );
  }
};

/* NOVO LANÇAMENTO */

$('date').value = today();

$('saveBtn').onclick = async () => {
  const desc = $('desc').value.trim();
  const value = Number($('value').value);
  const date = $('date').value || today();
  const type = $('type').value;

  if (!desc || desc.length > 300) {
    alert('Informe uma descrição válida, com até 300 caracteres.');
    return;
  }

  if (!Number.isFinite(value) || value <= 0) {
    alert('Informe um valor válido.');
    return;
  }

  if (!validDate(date)) {
    alert('Informe uma data válida.');
    return;
  }

  if (!['in', 'out'].includes(type)) {
    alert('Selecione o tipo de lançamento.');
    return;
  }

  const newRecord = {
    id: randomId(),
    desc,
    value,
    type,
    category: $('category').value || 'Outros',
    date
  };

  records.push(newRecord);

  try {
    await persistLocal();
    scheduleSync();

    $('desc').value = '';
    $('value').value = '';
    $('date').value = today();

    showTab('home');
    render();

  } catch (error) {
    records = records.filter(item => item.id !== newRecord.id);

    alert(
      'Não foi possível salvar o lançamento: ' +
      (error.message || 'erro no armazenamento local.')
    );
  }
};

/* META */

$('goalSave').onclick = async () => {
  const raw = $('goalPercent').value;
  const value = Number(raw);

  if (raw.trim() === '' || !validGoal(value)) {
    alert('Informe um percentual entre 0 e 100.');
    return;
  }

  const oldGoal = goal;
  const oldUpdatedAt = goalUpdatedAt;

  goal = value;
  goalUpdatedAt = Date.now();

  try {
    await persistLocal();
    scheduleSync();
    render();

    alert('Meta salva.');

  } catch (error) {
    goal = oldGoal;
    goalUpdatedAt = oldUpdatedAt;

    $('goalPercent').value = goal;

    alert(
      'Não foi possível salvar a meta: ' +
      (error.message || 'erro no armazenamento local.')
    );
  }
};

/* BACKUP */

function download(data, name, type) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(
    new Blob([data], { type })
  );

  link.href = url;
  link.download = name;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

$('exportBtn').onclick = async () => {
  const password = prompt(
    'Confirme sua senha de proteção para exportar o backup:'
  );

  if (!password) return;

  try {
    const meta = await dbGet('meta');
    const localBlob = await dbGet('data');

    if (!meta || !localBlob || !Array.isArray(meta.salt)) {
      throw new Error('Cofre local incompleto.');
    }

    const backupKey = await derive(
      password,
      new Uint8Array(meta.salt)
    );

    await decrypt(localBlob, backupKey);

    const encrypted = await encrypt(
      makeVaultData(),
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
      'Não foi possível exportar. Confira sua senha e tente novamente.'
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

  if (file.size > BACKUP_MAX_SIZE) {
    alert('O arquivo de backup é muito grande.');
    return;
  }

  if (!confirm(
    'A restauração substituirá os lançamentos atuais deste aparelho. Deseja continuar?'
  )) {
    return;
  }

  const oldRecords = records;
  const oldKey = key;
  const oldGoal = goal;
  const oldGoalUpdatedAt = goalUpdatedAt;

  const oldMeta = await dbGet('meta');
  const oldBlob = await dbGet('data');

  try {
    const backup = JSON.parse(await file.text());

    if (
      !backup ||
      ![1, 2].includes(backup.version) ||
      !Array.isArray(backup.salt) ||
      backup.salt.length !== 16
    ) {
      throw new Error('Formato de backup inválido.');
    }

    const backupKey = await derive(
      password,
      new Uint8Array(backup.salt)
    );

    const importedData = await decrypt(backup, backupKey);
    const importedRecords = normalizeRecords(importedData.records || []);
    const importedGoal = Number(importedData.goal ?? 15);

    if (!validGoal(importedGoal)) {
      throw new Error('Meta inválida no backup.');
    }

    if (!oldKey) {
      throw new Error('Desbloqueie o cofre antes de restaurar o backup.');
    }

    if (!oldMeta || !oldBlob || !Array.isArray(oldMeta.salt)) {
      throw new Error('Cofre local incompleto.');
    }

    /*
     * O backup pode ter outra senha.
     * Os dados importados são descriptografados com a senha do backup
     * e criptografados novamente com a chave atual do cofre.
     * Assim, a senha da conta não é substituída.
     */

    const importedGoalUpdatedAt = Number(
      importedData.goalUpdatedAt || Date.now()
    );

    const newData = {
      records: importedRecords,
      goal: importedGoal,
      goalUpdatedAt: importedGoalUpdatedAt
    };

    const newMeta = {
      ...oldMeta
    };

    if (cloudEnabled && currentUser) {
      if (newMeta.userId !== currentUser.id) {
        throw new Error('O cofre local não pertence à conta conectada.');
      }
    }

    records = importedRecords;
    goal = importedGoal;
    goalUpdatedAt = importedGoalUpdatedAt;

    await persistLocalWithMeta(newMeta, newData);

    if (cloudEnabled && currentUser) {
      await cloudSave();
    } else {
      setStatus('Backup restaurado neste aparelho.');
    }

    $('backupFile').value = '';
    $('backupPass').value = '';

    render();

    alert('Backup restaurado com sucesso.');

  } catch (error) {
    records = oldRecords;
    key = oldKey;
    goal = oldGoal;
    goalUpdatedAt = oldGoalUpdatedAt;

    try {
      if (oldMeta && oldBlob) {
        await dbSetMany({
          meta: oldMeta,
          data: oldBlob
        });
      }
    } catch (_) {
      alert(
        'Atenção: houve falha ao restaurar o backup e também ao recuperar ' +
        'a cópia local anterior. Não feche o aplicativo.'
      );
    }

    render();

    alert(
      'Não foi possível restaurar: ' +
      (error.message || 'verifique o arquivo e a senha.')
    );
  }
};

/* SINCRONIZAÇÃO MANUAL */

$('syncBtn').onclick = () => {
  syncNow().catch(error => {
    setStatus(
      'Falha na sincronização: ' +
      (error.message || 'erro desconhecido')
    );
  });
};

/* BLOQUEIO E SAÍDA */

$('logoutBtn').onclick = async () => {
  sessionGeneration++;

  clearTimeout(syncTimer);

  syncRequested = false;
  syncInProgress = false;

  try {
    if (supabase) {
      await supabase.auth.signOut({ scope: 'local' });
    }
  } catch (_) {}

  key = null;
  records = [];
  goal = 15;
  goalUpdatedAt = 0;
  currentUser = null;
  cloudEnabled = false;

  $('app').classList.add('hidden');
  $('lock').classList.remove('hidden');
  $('pass').value = '';

  setStatus(
    'Aplicativo bloqueado. Seus dados locais permanecem criptografados.'
  );
};

/* RECONEXÃO */

window.addEventListener('online', () => {
  if (cloudEnabled && currentUser) {
    syncNow().catch(error => {
      setStatus('Falha ao reconectar: ' + error.message);
    });
  }
});

/* SERVICE WORKER */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', {
        updateViaCache: 'none'
      })
      .then(registration => {
        registration.update().catch(() => {});
      })
      .catch(error => {
        console.error('Service Worker:', error);
      });
  });
}

/* INICIALIZAÇÃO */

(function boot() {
  if (!window.isSecureContext) {
    showMessage(
      'O aplicativo precisa ser aberto em uma conexão segura HTTPS.'
    );
  }

  if (!initSupabase()) {
    showMessage(
      'Biblioteca de sincronização não carregada. ' +
      'Você ainda pode usar o modo offline se houver dados locais.'
    );
  }

  $('date').value = today();
})();
