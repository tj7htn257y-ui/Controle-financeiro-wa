
'use strict';

/*
 * Meu Controle Financeiro
 * Versão com planejamento por categorias, pesquisa mensal,
 * edição/exclusão, situação de contas e cofre criptografado.
 *
 * Tabela Supabase: cofres_financeiros
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

const CATEGORIES = [
  'Moradia', 'Alimentação', 'Transporte', 'Saúde', 'Educação',
  'Lazer', 'Contas', 'Salário', 'Investimentos', 'Outros'
];

const $ = id => document.getElementById(id);
const enc = new TextEncoder();
const dec = new TextDecoder();

let supabase = null;
let supabaseLoadPromise = null;
let key = null;
let records = [];
let deletedIds = [];
let currentUser = null;
let cloudEnabled = false;
let syncTimer = null;
let syncInProgress = false;
let syncRequested = false;
let localRevision = 0;
let syncedRevision = 0;
let goal = 15;
let goalUpdatedAt = 0;
let plan = { income: 0, percentages: {}, updatedAt: 0 };
let sessionGeneration = 0;
let editingRecordId = null;

function today() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d;
}

function validGoal(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' +
    crypto.getRandomValues(new Uint32Array(2)).join('-');
}

function sameSalt(a, b) {
  return Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((v, i) => v === b[i]);
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

/* Inicialização do Supabase */

function initSupabase() {
  if (supabase) return true;

  if (
    !window.supabase ||
    typeof window.supabase.createClient !== 'function'
  ) {
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

/*
 * Carrega o Supabase somente quando necessário.
 * Tenta primeiro jsDelivr e depois Unpkg.
 */

async function ensureSupabase() {
  if (initSupabase()) return supabase;

  if (!supabaseLoadPromise) {
    supabaseLoadPromise = (async () => {
      const sources = [
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
        'https://unpkg.com/@supabase/supabase-js@2'
      ];

      let lastError = null;

      for (const src of sources) {
        try {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');

            script.src = src;
            script.async = true;

            script.onload = () => {
              try {
                if (!initSupabase()) {
                  script.remove();

                  reject(
                    new Error(
                      'O arquivo foi carregado, mas window.supabase.createClient não ficou disponível.'
                    )
                  );

                  return;
                }

                resolve();
              } catch (error) {
                script.remove();
                reject(error);
              }
            };

            script.onerror = () => {
              script.remove();

              reject(
                new Error('Falha ao carregar a biblioteca em ' + src)
              );
            };

            document.head.appendChild(script);
          });

          return supabase;

        } catch (error) {
          lastError = error;
        }
      }

      throw new Error(
        'Não foi possível inicializar o Supabase pelas duas fontes. ' +
        (
          lastError && lastError.message
            ? lastError.message
            : 'Verifique a conexão e tente novamente.'
        )
      );

    })().catch(error => {
      supabaseLoadPromise = null;
      throw error;
    });
  }

  return supabaseLoadPromise;
}

/* IndexedDB */

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

async function dbSetMany(values) {
  const db = await openDB();

  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');

      for (const [name, value] of Object.entries(values)) {
        tx.objectStore(STORE).put(value, name);
      }

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(
        tx.error || new Error('Gravação local cancelada.')
      );
    });
  } finally {
    db.close();
  }
}

/* Criptografia */

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
    { name: 'AES-GCM', length: 256 },
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
    { name: 'AES-GCM', iv },
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

/* Normalização e compatibilidade */

function normalizeRecords(list) {
  if (!Array.isArray(list) || list.length > 100000) {
    throw new Error('Lista de lançamentos inválida.');
  }

  const ids = new Set();

  return list.map(item => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item)
    ) {
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
      throw new Error('Identificadores de lançamentos inválidos ou repetidos.');
    }

    ids.add(id);

    const status = item.status ||
      (type === 'in' ? 'received' : 'paid');

    if (!['pending', 'paid', 'received'].includes(status)) {
      throw new Error('Situação de lançamento inválida.');
    }

    return {
      id,
      desc,
      value,
      type,
      category: String(item.category || 'Outros').slice(0, 100),
      date,
      status,
      updatedAt: Number(item.updatedAt || 0)
    };
  });
}

function normalizePlan(value) {
  const source = value && typeof value === 'object' ? value : {};
  const percentages = {};

  for (const category of CATEGORIES) {
    const n = Number(source.percentages?.[category] ?? 0);

    percentages[category] =
      Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0;
  }

  return {
    income: Math.max(0, Number(source.income) || 0),
    percentages,
    updatedAt: Number(source.updatedAt || 0)
  };
}

function normalizeDeletedIds(list) {
  if (!Array.isArray(list)) return [];

  return [
    ...new Set(
      list.map(String).filter(id => id.length > 0 && id.length <= 100)
    )
  ].slice(-100000);
}

function mergeRecords(localList, cloudList, tombstones = []) {
  const deleted = new Set(tombstones);
  const map = new Map();

  for (const item of [...localList, ...cloudList]) {
    if (deleted.has(String(item.id))) continue;

    const previous = map.get(String(item.id));

    if (
      !previous ||
      Number(item.updatedAt || 0) >= Number(previous.updatedAt || 0)
    ) {
      map.set(String(item.id), item);
    }
  }

  return normalizeRecords([...map.values()]);
}

function makeVaultData() {
  return {
    records: normalizeRecords(records),
    deletedIds: normalizeDeletedIds(deletedIds),
    goal,
    goalUpdatedAt,
    plan: normalizePlan(plan)
  };
}

async function persistLocal() {
  if (!key) {
    throw new Error('Cofre bloqueado. Não foi possível salvar.');
  }

  const encrypted = await encrypt(makeVaultData());

  await dbSetMany({ data: encrypted });

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

function applyVaultData(data) {
  records = normalizeRecords(data.records || []);
  deletedIds = normalizeDeletedIds(data.deletedIds || []);

  goal = Number(data.goal ?? 15);

  if (!validGoal(goal)) {
    throw new Error('Meta armazenada inválida.');
  }

  goalUpdatedAt = Number(data.goalUpdatedAt || 0);
  plan = normalizePlan(data.plan);
}

async function localUnlock(pass) {
  const meta = await dbGet('meta');
  const blob = await dbGet('data');

  if (
    !meta ||
    !Array.isArray(meta.salt) ||
    !blob
  ) {
    throw new Error('Cofre local incompleto ou inexistente.');
  }

  const localKey = await derive(
    pass,
    new Uint8Array(meta.salt)
  );

  const data = await decrypt(blob, localKey);

  applyVaultData(data);

  key = localKey;
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
  deletedIds = [];
  goal = 15;
  goalUpdatedAt = Date.now();
  plan = normalizePlan({});

  try {
    await dbSetMany({
      meta: newMeta,
      data: await encrypt(makeVaultData(), newKey)
    });

    localRevision = 0;
    syncedRevision = 0;

  } catch (error) {
    key = oldKey;
    throw error;
  }
}

/* Nuvem */

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

  const data = await decrypt(
    {
      iv: payload.iv,
      data: payload.data
    },
    encryptionKey
  );

  return {
    records: normalizeRecords(data.records || []),
    deletedIds: normalizeDeletedIds(data.deletedIds || []),
    goal: Number(data.goal ?? 15),
    goalUpdatedAt: Number(data.goalUpdatedAt || 0),
    plan: normalizePlan(data.plan)
  };
}

async function cloudRestore(pass, generation, userId) {
  const cloudRow = await cloudGet(userId);

  ensureSession(generation, userId);

  if (!cloudRow) return false;

  validateEncryptedPayload(cloudRow.payload);

  const cloudKey = await derive(
    pass,
    new Uint8Array(cloudRow.payload.salt)
  );

  const cloudData = await decodeCloudPayload(
    cloudRow.payload,
    cloudKey
  );

  ensureSession(generation, userId);

  const localMeta = await dbGet('meta');
  const localBlob = await dbGet('data');

  let localData = {
    records: [],
    deletedIds: [],
    goal: 15,
    goalUpdatedAt: 0,
    plan: normalizePlan({})
  };

  if (localMeta || localBlob) {
    if (
      !localMeta ||
      !localBlob ||
      !Array.isArray(localMeta.salt)
    ) {
      throw new Error(
        'O cofre local está incompleto. Os dados foram preservados.'
      );
    }

    if (localMeta.userId !== userId) {
      throw new Error(
        'O cofre local pertence a outra conta. Não vou misturar os dados.'
      );
    }

    try {
      const localKey = await derive(
        pass,
        new Uint8Array(localMeta.salt)
      );

      localData = await decrypt(localBlob, localKey);

      localData.records = normalizeRecords(localData.records || []);
      localData.deletedIds = normalizeDeletedIds(localData.deletedIds || []);
      localData.plan = normalizePlan(localData.plan);

      if (!validGoal(Number(localData.goal ?? 15))) {
        throw new Error('Meta local inválida.');
      }

    } catch (_) {
      throw new Error(
        'A senha não desbloqueia o cofre local. Os dados locais foram preservados.'
      );
    }
  }

  const tombstones = normalizeDeletedIds([
    ...(localData.deletedIds || []),
    ...cloudData.deletedIds
  ]);

  const mergedRecords = mergeRecords(
    localData.records || [],
    cloudData.records,
    tombstones
  );

  const useLocalGoal =
    Number(localData.goalUpdatedAt || 0) > cloudData.goalUpdatedAt;

  const useLocalPlan =
    Number(localData.plan?.updatedAt || 0) > cloudData.plan.updatedAt;

  const newData = {
    records: mergedRecords,
    deletedIds: tombstones,
    goal: useLocalGoal
      ? Number(localData.goal ?? 15)
      : cloudData.goal,
    goalUpdatedAt: useLocalGoal
      ? Number(localData.goalUpdatedAt || 0)
      : cloudData.goalUpdatedAt,
    plan: useLocalPlan
      ? normalizePlan(localData.plan)
      : cloudData.plan
  };

  key = cloudKey;

  applyVaultData(newData);

  await persistLocalWithMeta(
    {
      salt: cloudRow.payload.salt,
      userId
    },
    newData
  );

  ensureSession(generation, userId);

  return true;
}

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

    let cloudData = {
      records: [],
      deletedIds: [],
      goal: 15,
      goalUpdatedAt: 0,
      plan: normalizePlan({})
    };

    if (cloudRow) {
      validateEncryptedPayload(cloudRow.payload);

      if (!sameSalt(meta.salt, cloudRow.payload.salt)) {
        throw new Error(
          'A chave local é diferente da chave da nuvem. Restaure o cofre correto.'
        );
      }

      cloudData = await decodeCloudPayload(
        cloudRow.payload,
        key
      );
    }

    const tombstones = normalizeDeletedIds([
      ...deletedIds,
      ...cloudData.deletedIds
    ]);

    const merged = mergeRecords(
      records,
      cloudData.records,
      tombstones
    );

    const mergedGoalIsCloudNewer =
      cloudData.goalUpdatedAt > goalUpdatedAt;

    const mergedPlan =
      cloudData.plan.updatedAt > plan.updatedAt
        ? cloudData.plan
        : plan;

    records = merged;
    deletedIds = tombstones;

    if (mergedGoalIsCloudNewer) {
      goal = cloudData.goal;
      goalUpdatedAt = cloudData.goalUpdatedAt;
    }

    plan = normalizePlan(mergedPlan);

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

      if (error.code === '23505') continue;

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
    'Outro aparelho está atualizando os dados. Tente sincronizar novamente.'
  );
}

/* Fila de sincronização */

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
        (error.message || 'erro desconhecido.')
      );
    });
  }, 1200);
}

/* Conta e abertura */

async function openApp() {
  $('lock').classList.add('hidden');
  $('app').classList.remove('hidden');

  $('cloudLabel').textContent = cloudEnabled
    ? 'Conta conectada · sincronização ativada'
    : 'Modo local/offline';

  $('date').value = today();
  $('expenseMonth').value = month();

  render();
}

async function initializeAccount(pass, user) {
  currentUser = user;
  cloudEnabled = true;
  sessionGeneration++;

  const generation = sessionGeneration;

  try {
    const exists = await cloudRestore(
      pass,
      generation,
      user.id
    );

    ensureSession(generation, user.id);

    if (!exists) {
      const meta = await dbGet('meta');
      const blob = await dbGet('data');

      if (meta || blob) {
        if (
          !meta ||
          !blob ||
          !Array.isArray(meta.salt)
        ) {
          throw new Error(
            'O cofre local está incompleto. Os dados foram preservados.'
          );
        }

        if (meta.userId !== user.id) {
          throw new Error(
            'O cofre local pertence a outra conta ou não está vinculado.'
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

async function login() {
  const email = $('email').value.trim();
  const pass = $('pass').value;

  if (!email || !pass) {
    throw new Error('Informe e-mail e senha.');
  }

  if (pass.length < 8) {
    throw new Error('A senha precisa ter pelo menos 8 caracteres.');
  }

  await ensureSupabase();

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

  await ensureSupabase();

  const { data, error } = await supabase.auth.signUp({
    email,
    password: pass
  });

  if (error) throw error;

  if (!data.session || !data.user) {
    showMessage(
      'Cadastro iniciado. Confirme o e-mail recebido e depois entre no aplicativo.'
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

/* Interface e navegação */

function showTab(tab) {
  ['home', 'planning', 'expenses', 'add', 'settings'].forEach(name => {
    $(name).classList.toggle('hidden', name !== tab);
  });

  document.querySelectorAll('[data-tab]').forEach(button => {
    button.classList.toggle(
      'active',
      button.dataset.tab === tab
    );
  });

  if (tab === 'planning') renderPlanning();
  if (tab === 'expenses') renderExpenses();
}

window.showTab = showTab;

function esc(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function statusLabel(item) {
  if (item.type === 'in') {
    return item.status === 'received'
      ? 'Recebido'
      : 'A receber';
  }

  return item.status === 'paid'
    ? 'Pago'
    : 'A pagar';
}

function statusClass(item) {
  return item.status === 'pending'
    ? 'pending'
    : 'completed';
}

function recordHtml(item, actions = true) {
  const sign = item.type === 'in' ? '+' : '−';

  const toggleLabel = item.status === 'pending'
    ? (item.type === 'in' ? 'Marcar recebido' : 'Marcar paga')
    : (item.type === 'in' ? 'Voltar para a receber' : 'Voltar para pendente');

  return `
    <article class="record">
      <div class="record-main">
        <div class="record-title">${esc(item.desc)}</div>
        <small>${item.date.split('-').reverse().join('/')} · ${esc(item.category)}</small>
        <span class="status ${statusClass(item)}">${statusLabel(item)}</span>
      </div>

      <div class="record-side">
        <strong class="amount ${item.type}">
          ${sign} ${money(item.value)}
        </strong>

        ${actions ? `
          <div class="record-actions">
            <button class="mini secondary"
              data-action="toggle"
              data-id="${esc(item.id)}">
              ${toggleLabel}
            </button>

            <button class="mini secondary"
              data-action="edit"
              data-id="${esc(item.id)}">
              Editar
            </button>

            <button class="mini danger"
              data-action="delete"
              data-id="${esc(item.id)}">
              Excluir
            </button>
          </div>
        ` : ''}
      </div>
    </article>
  `;
}

function render() {
  const currentMonth = month();

  const monthly = records.filter(
    item => item.date.slice(0, 7) === currentMonth
  );

  const income = monthly
    .filter(item => item.type === 'in' && item.status === 'received')
    .reduce((s, i) => s + i.value, 0);

  const expense = monthly
    .filter(item => item.type === 'out' && item.status === 'paid')
    .reduce((s, i) => s + i.value, 0);

  const pendingIn = monthly
    .filter(item => item.type === 'in' && item.status === 'pending')
    .reduce((s, i) => s + i.value, 0);

  const pendingOut = monthly
    .filter(item => item.type === 'out' && item.status === 'pending')
    .reduce((s, i) => s + i.value, 0);

  const saved = income - expense;
  const target = income * goal / 100;

  $('monthLabel').textContent = new Date().toLocaleDateString(
    'pt-BR',
    { month: 'long', year: 'numeric' }
  );

  $('balance').textContent = money(saved);
  $('income').textContent = money(income);
  $('expense').textContent = money(expense);

  $('pendingSummary').textContent =
    `Pendente: ${money(pendingOut)} a pagar · ${money(pendingIn)} a receber`;

  $('goalText').textContent =
    `Meta de economia: ${goal}% da renda recebida (${money(target)}). Saldo realizado: ${money(saved)}.`;

  $('goalProgress').value = target > 0
    ? Math.max(0, Math.min(100, saved / target * 100))
    : 0;

  $('goalPercent').value = goal;

  const sorted = [...monthly].sort(
    (a, b) => b.date.localeCompare(a.date)
  );

  $('transactions').innerHTML = sorted.length
    ? sorted.slice(0, 8).map(item => recordHtml(item, false)).join('')
    : '<p class="muted">Nenhum lançamento neste mês.</p>';

  renderPlanning();
  renderExpenses();
}

function renderPlanning() {
  if (!$('planningList')) return;

  const monthRecords = records.filter(
    item => item.date.slice(0, 7) === month()
  );

  const received = monthRecords
    .filter(item => item.type === 'in' && item.status === 'received')
    .reduce((s, i) => s + i.value, 0);

  const plannedIncome = Number(plan.income) > 0
    ? Number(plan.income)
    : received;

  const totalPercent = CATEGORIES.reduce(
    (s, c) => s + Number(plan.percentages[c] || 0),
    0
  );

  $('planIncome').value = plan.income || '';

  $('planPercentTotal').textContent =
    `Total distribuído: ${totalPercent.toLocaleString('pt-BR')}%`;

  $('planPercentTotal').classList.toggle(
    'warning-text',
    totalPercent > 100
  );

  $('planningList').innerHTML = CATEGORIES.map(category => {
    const percent = Number(plan.percentages[category] || 0);
    const budget = plannedIncome * percent / 100;

    const spent = monthRecords
      .filter(
        i => i.type === 'out' &&
          i.category === category &&
          i.status === 'paid'
      )
      .reduce((s, i) => s + i.value, 0);

    const remaining = budget - spent;

    return `
      <div class="plan-row">
        <div class="plan-head">
          <strong>${esc(category)}</strong>
          <span>${money(budget)}</span>
        </div>

        <div class="plan-inputs">
          <label>Percentual
            <input
              type="number"
              min="0"
              max="100"
              step="0.5"
              data-plan-category="${esc(category)}"
              value="${percent}">
          </label>

          <div class="muted plan-detail">
            Gasto realizado: ${money(spent)}<br>
            Disponível:
            <strong class="${remaining < 0 ? 'negative' : ''}">
              ${money(remaining)}
            </strong>
          </div>
        </div>

        <progress
          max="100"
          value="${budget > 0 ? Math.min(100, spent / budget * 100) : 0}">
        </progress>
      </div>
    `;
  }).join('');
}

function renderExpenses() {
  if (!$('expenseList')) return;

  const selectedMonth = $('expenseMonth').value || month();

  const list = records
    .filter(item => item.date.slice(0, 7) === selectedMonth)
    .sort((a, b) => b.date.localeCompare(a.date));

  const query = $('expenseSearch')
    .value.trim()
    .toLocaleLowerCase('pt-BR');

  const filtered = list.filter(item =>
    !query ||
    item.desc.toLocaleLowerCase('pt-BR').includes(query) ||
    item.category.toLocaleLowerCase('pt-BR').includes(query)
  );

  const toPay = filtered
    .filter(i => i.type === 'out' && i.status === 'pending')
    .reduce((s, i) => s + i.value, 0);

  const toReceive = filtered
    .filter(i => i.type === 'in' && i.status === 'pending')
    .reduce((s, i) => s + i.value, 0);

  $('expenseTotals').textContent =
    `A pagar: ${money(toPay)} · A receber: ${money(toReceive)}`;

  $('expenseList').innerHTML = filtered.length
    ? filtered.map(item => recordHtml(item, true)).join('')
    : '<p class="muted">Nenhuma conta encontrada neste mês.</p>';
}

function resetEntryForm() {
  editingRecordId = null;

  $('entryTitle').textContent = 'Novo lançamento';
  $('saveBtn').textContent = 'Salvar lançamento';
  $('desc').value = '';
  $('value').value = '';
  $('date').value = today();
  $('type').value = 'out';
  $('category').value = 'Moradia';
  $('recordStatus').value = 'pending';
}

function editRecord(id) {
  const item = records.find(record => record.id === id);

  if (!item) return;

  editingRecordId = id;

  $('entryTitle').textContent = 'Editar lançamento';
  $('saveBtn').textContent = 'Salvar alterações';
  $('desc').value = item.desc;
  $('value').value = item.value;
  $('date').value = item.date;
  $('type').value = item.type;
  $('category').value = item.category;
  $('recordStatus').value = item.status;

  showTab('add');
}

async function handleRecordAction(event) {
  const button = event.target.closest('button[data-action]');

  if (!button) return;

  const id = button.dataset.id;

  const item = records.find(record => record.id === id);

  if (!item) return;

  if (button.dataset.action === 'edit') {
    editRecord(id);
    return;
  }

  if (button.dataset.action === 'delete') {
    if (!confirm(
      `Excluir "${item.desc}"? Esta ação não poderá ser desfeita.`
    )) return;

    const oldRecords = records;

    records = records.filter(record => record.id !== id);

    deletedIds = normalizeDeletedIds([
      ...deletedIds,
      id
    ]);

    try {
      await persistLocal();
      scheduleSync();
      render();

    } catch (error) {
      records = oldRecords;
      deletedIds = deletedIds.filter(value => value !== id);

      alert('Não foi possível excluir: ' + error.message);
    }

    return;
  }

  if (button.dataset.action === 'toggle') {
    const oldStatus = item.status;

    item.status = item.status === 'pending'
      ? (item.type === 'in' ? 'received' : 'paid')
      : 'pending';

    item.updatedAt = Date.now();

    try {
      await persistLocal();
      scheduleSync();
      render();

    } catch (error) {
      item.status = oldStatus;

      alert('Não foi possível atualizar: ' + error.message);
    }
  }
}

/* Eventos de acesso */

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

/* Novo lançamento / edição */

$('saveBtn').onclick = async () => {
  const desc = $('desc').value.trim();
  const value = Number($('value').value);
  const date = $('date').value || today();
  const type = $('type').value;
  const status = $('recordStatus').value;

  if (!desc || desc.length > 300) {
    return alert('Informe uma descrição válida, com até 300 caracteres.');
  }

  if (!Number.isFinite(value) || value <= 0) {
    return alert('Informe um valor válido.');
  }

  if (!validDate(date)) {
    return alert('Informe uma data válida.');
  }

  if (!['in', 'out'].includes(type)) {
    return alert('Selecione o tipo de lançamento.');
  }

  if (!['pending', 'paid', 'received'].includes(status)) {
    return alert('Selecione uma situação válida.');
  }

  if (
    (type === 'out' && status === 'received') ||
    (type === 'in' && status === 'paid')
  ) {
    return alert('A situação não corresponde ao tipo do lançamento.');
  }

  const oldRecords = records;

  const existing = editingRecordId
    ? records.find(i => i.id === editingRecordId)
    : null;

  const entry = {
    id: existing ? existing.id : randomId(),
    desc,
    value,
    type,
    category: $('category').value || 'Outros',
    date,
    status,
    updatedAt: Date.now()
  };

  records = existing
    ? records.map(i => i.id === existing.id ? entry : i)
    : [...records, entry];

  try {
    await persistLocal();
    scheduleSync();
    resetEntryForm();
    showTab('expenses');

    $('expenseMonth').value = date.slice(0, 7);

    render();

  } catch (error) {
    records = oldRecords;

    alert(
      'Não foi possível salvar: ' +
      (error.message || 'erro no armazenamento local.')
    );
  }
};

/* Planejamento */

$('planSave').onclick = async () => {
  const incomeRaw = $('planIncome').value;

  const income = incomeRaw === '' ? 0 : Number(incomeRaw);

  if (!Number.isFinite(income) || income < 0) {
    return alert('Informe uma renda planejada válida.');
  }

  const percentages = {};
  let total = 0;

  for (const category of CATEGORIES) {
    const field = document.querySelector(
      `[data-plan-category="${CSS.escape(category)}"]`
    );

    const value = Number(field?.value || 0);

    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100
    ) {
      return alert(`Percentual inválido em ${category}.`);
    }

    percentages[category] = value;
    total += value;
  }

  if (total > 100.0001) {
    return alert(
      `A soma das porcentagens é ${total.toLocaleString('pt-BR')}%. O total não pode ultrapassar 100%.`
    );
  }

  const oldPlan = plan;

  plan = {
    income,
    percentages,
    updatedAt: Date.now()
  };

  try {
    await persistLocal();
    scheduleSync();
    renderPlanning();

    alert('Planejamento financeiro salvo.');

  } catch (error) {
    plan = oldPlan;
    renderPlanning();

    alert(
      'Não foi possível salvar o planejamento: ' +
      error.message
    );
  }
};

$('goalSave').onclick = async () => {
  const raw = $('goalPercent').value;
  const value = Number(raw);

  if (raw.trim() === '' || !validGoal(value)) {
    return alert('Informe um percentual entre 0 e 100.');
  }

  const oldGoal = goal;
  const oldUpdatedAt = goalUpdatedAt;

  goal = value;
  goalUpdatedAt = Date.now();

  try {
    await persistLocal();
    scheduleSync();
    render();

    alert('Meta de economia salva.');

  } catch (error) {
    goal = oldGoal;
    goalUpdatedAt = oldUpdatedAt;
    $('goalPercent').value = goal;

    alert('Não foi possível salvar a meta: ' + error.message);
  }
};

/* Eventos da lista mensal */

$('expenseMonth').addEventListener('change', renderExpenses);
$('expenseSearch').addEventListener('input', renderExpenses);

$('expenseList').addEventListener(
  'click',
  handleRecordAction
);

$('transactions').addEventListener(
  'click',
  handleRecordAction
);

$('cancelEditBtn').onclick = () => {
  resetEntryForm();
  showTab('expenses');
};

/* Backup criptografado */

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

    if (
      !meta ||
      !localBlob ||
      !Array.isArray(meta.salt)
    ) {
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

    const backupText = JSON.stringify({
      version: 2,
      salt: meta.salt,
      ...encrypted
    });

    if (new Blob([backupText]).size > BACKUP_MAX_SIZE) {
      throw new Error('O backup ultrapassa o limite de 10 MiB.');
    }

    download(
      backupText,
      `backup-meu-financeiro-${today()}.json`,
      'application/json'
    );

  } catch (error) {
    alert(
      'Não foi possível exportar. Confira a senha. ' +
      (error.message || '')
    );
  }
};

$('importBtn').onclick = async () => {
  const file = $('backupFile').files[0];
  const password = $('backupPass').value;

  if (!file || !password) {
    return alert('Escolha o arquivo e informe a senha do backup.');
  }

  if (file.size > BACKUP_MAX_SIZE) {
    return alert('O arquivo de backup é muito grande.');
  }

  if (!confirm(
    'A restauração substituirá os lançamentos e o planejamento atuais deste aparelho. Deseja continuar?'
  )) return;

  const oldState = {
    records,
    deletedIds,
    key,
    goal,
    goalUpdatedAt,
    plan
  };

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

    const imported = await decrypt(backup, backupKey);

    const importedRecords = normalizeRecords(
      imported.records || []
    );

    const importedGoal = Number(imported.goal ?? 15);

    if (!validGoal(importedGoal)) {
      throw new Error('Meta inválida no backup.');
    }

    if (
      !key ||
      !oldMeta ||
      !oldBlob ||
      !Array.isArray(oldMeta.salt)
    ) {
      throw new Error('Desbloqueie o cofre antes de restaurar.');
    }

    const importedData = {
      records: importedRecords,
      deletedIds: normalizeDeletedIds(imported.deletedIds || []),
      goal: importedGoal,
      goalUpdatedAt: Number(imported.goalUpdatedAt || Date.now()),
      plan: normalizePlan(imported.plan)
    };

    if (
      cloudEnabled &&
      currentUser &&
      oldMeta.userId !== currentUser.id
    ) {
      throw new Error(
        'O cofre local não pertence à conta conectada.'
      );
    }

    applyVaultData(importedData);

    await persistLocalWithMeta(
      oldMeta,
      makeVaultData()
    );

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
    records = oldState.records;
    deletedIds = oldState.deletedIds;
    key = oldState.key;
    goal = oldState.goal;
    goalUpdatedAt = oldState.goalUpdatedAt;
    plan = oldState.plan;

    try {
      if (oldMeta && oldBlob) {
        await dbSetMany({
          meta: oldMeta,
          data: oldBlob
        });
      }

    } catch (_) {
      alert(
        'Atenção: houve falha ao recuperar a cópia local anterior. Não feche o aplicativo.'
      );
    }

    render();

    alert(
      'Não foi possível restaurar: ' +
      (error.message || 'verifique o arquivo e a senha.')
    );
  }
};

/* Sincronização manual */

$('syncBtn').onclick = () => {
  syncNow().catch(error => {
    setStatus(
      'Falha na sincronização: ' +
      (error.message || 'erro desconhecido.')
    );
  });
};

/* Sair / bloquear */

async function logout() {
  sessionGeneration++;

  clearTimeout(syncTimer);
  syncRequested = false;

  try {
    if (supabase) {
      await supabase.auth.signOut({ scope: 'local' });
    }
  } catch (_) {}

  key = null;
  records = [];
  deletedIds = [];
  goal = 15;
  goalUpdatedAt = 0;
  plan = normalizePlan();
  currentUser = null;
  cloudEnabled = false;
  editingRecordId = null;

  $('app').classList.add('hidden');
  $('lock').classList.remove('hidden');
  $('pass').value = '';

  setStatus(
    'Aplicativo bloqueado. Seus dados locais permanecem criptografados.'
  );

  showMessage('Sessão encerrada com segurança.');
}

$('logoutBtn').onclick = logout;
$('homeLogoutBtn').onclick = logout;

/* Reconexão e Service Worker */

window.addEventListener('online', () => {
  if (cloudEnabled && currentUser) {
    syncNow().catch(error => {
      setStatus('Falha ao reconectar: ' + error.message);
    });
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(
      './sw.js',
      { updateViaCache: 'none' }
    )
    .then(registration => registration.update().catch(() => {}))
    .catch(error => console.error('Service Worker:', error));
  });
}

/* Inicialização */

(function boot() {
  try {
    if (!window.isSecureContext) {
      showMessage(
        'O aplicativo precisa ser aberto em uma conexão segura HTTPS.'
      );
    }

    $('date').value = today();
    $('expenseMonth').value = month();

    resetEntryForm();

    if (!window.supabase) {
      console.info(
        'Supabase será carregado somente quando o usuário solicitar acesso pela conta.'
      );
    }

  } catch (error) {
    console.error(
      'Falha na inicialização do aplicativo:',
      error
    );

    showMessage(
      'O aplicativo encontrou um erro ao iniciar: ' +
      (error.message || 'erro desconhecido.')
    );
  }
})();

/* Tratamento de erros */

window.addEventListener('error', event => {
  console.error(
    'Erro JavaScript:',
    event.error || event.message
  );

  if (
    $('lock') &&
    !$('lock').classList.contains('hidden')
  ) {
    showMessage(
      'O aplicativo encontrou um erro. Atualize a página e tente novamente.'
    );
  }
});

window.addEventListener('unhandledrejection', event => {
  console.error(
    'Falha assíncrona:',
    event.reason
  );

  if (
    $('lock') &&
    !$('lock').classList.contains('hidden')
  ) {
    const reason =
      event.reason && event.reason.message
        ? event.reason.message
        : 'Falha inesperada.';

    showMessage(reason);
  }
});
