'use strict';

/*
 * Meu Controle Financeiro
 * Mantém o cofre criptografado no aparelho e na nuvem.
 * Estrutura da tabela: cofres_financeiros
 * Colunas: user_id, payload, updated_at
 */

const SUPABASE_URL = 'https://eornyjvzajqnwghqdhfq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_vzdL2qqoEk9850Ha1ygBU_w_cwShRyXY';
const CLOUD_TABLE = 'cofres_financeiros';

const DB = 'mcf-db';
const STORE = 'vault';
const PBKDF2_ITERATIONS = 250000;

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
let goalUpdatedAt = 0;

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function month() {
  return today().slice(0,7);
}

function money(n) {
  return Number(n || 0).toLocaleString('pt-BR',{
    style:'currency',
    currency:'BRL'
  });
}

function setStatus(message) {
  if ($('syncStatus')) $('syncStatus').textContent = message;
  if ($('syncInfo')) $('syncInfo').textContent = message;
}

function showMessage(message) {
  if ($('lockMsg')) $('lockMsg').textContent = message;
}

function initSupabase() {
  if (!window.supabase || !window.supabase.createClient) return false;

  supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession:true,
        autoRefreshToken:true,
        detectSessionInUrl:true
      }
    }
  );

  return true;
}

/* BANCO LOCAL */

function openDB() {
  return new Promise((resolve,reject) => {
    const request = indexedDB.open(DB,1);

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
    return await new Promise((resolve,reject) => {
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

async function dbSet(name,value) {
  const db = await openDB();

  try {
    await new Promise((resolve,reject) => {
      const request = db.transaction(STORE,'readwrite')
        .objectStore(STORE)
        .put(value,name);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/* CRIPTOGRAFIA */

async function derive(pass,salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    enc.encode(pass),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name:'PBKDF2',
      salt,
      iterations:PBKDF2_ITERATIONS,
      hash:'SHA-256'
    },
    material,
    {name:'AES-GCM',length:256},
    false,
    ['encrypt','decrypt']
  );
}

async function encrypt(obj,encryptionKey=key) {
  if (!encryptionKey) throw new Error('Aplicativo bloqueado.');

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const data = await crypto.subtle.encrypt(
    {name:'AES-GCM',iv},
    encryptionKey,
    enc.encode(JSON.stringify(obj))
  );

  return {
    iv:Array.from(iv),
    data:Array.from(new Uint8Array(data))
  };
}

async function decrypt(blob,encryptionKey=key) {
  if (
    !encryptionKey ||
    !blob ||
    !Array.isArray(blob.iv) ||
    !Array.isArray(blob.data)
  ) {
    throw new Error('Dados criptografados inválidos.');
  }

  const plain = await crypto.subtle.decrypt(
    {name:'AES-GCM',iv:new Uint8Array(blob.iv)},
    encryptionKey,
    new Uint8Array(blob.data)
  );

  return JSON.parse(dec.decode(plain));
}

/* VALIDAÇÃO DOS LANÇAMENTOS */

function normalizeRecords(list) {
  if (!Array.isArray(list)) {
    throw new Error('Lista de lançamentos inválida.');
  }

  const ids = new Set();

  return list.map(item => {
    if (!item || typeof item !== 'object') {
      throw new Error('Lançamento inválido.');
    }

    const value = Number(item.value);
    const date = String(item.date || '');

    if (
      !item.desc ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !['in','out'].includes(item.type) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      throw new Error('Existe um lançamento com dados inválidos.');
    }

    const id = String(item.id || crypto.randomUUID());

    if (ids.has(id)) {
      throw new Error('Existem lançamentos com identificadores repetidos.');
    }

    ids.add(id);

    return {
      id,
      desc:String(item.desc),
      value,
      type:item.type,
      category:String(item.category || 'Outros'),
      date
    };
  });
}

function mergeRecords(localList,cloudList) {
  const map = new Map();

  for (const item of localList) {
    map.set(String(item.id),item);
  }

  for (const item of cloudList) {
    map.set(String(item.id),item);
  }

  return normalizeRecords([...map.values()]);
}

/* COFRE LOCAL */

async function persistLocal() {
  const goal = Number(localStorage.getItem('goal') || 15);

  await dbSet(
    'data',
    await encrypt({
      records,
      goal,
      goalUpdatedAt
    })
  );

  localRevision++;
}

async function localUnlock(pass) {
  const meta = await dbGet('meta');

  if (!meta || !Array.isArray(meta.salt)) {
    throw new Error('Não há cofre local neste aparelho.');
  }

  const localKey = await derive(
    pass,
    new Uint8Array(meta.salt)
  );

  const blob = await dbGet('data');

  if (!blob) {
    throw new Error('Dados locais não encontrados.');
  }

  const data = await decrypt(blob,localKey);

  key = localKey;
  records = normalizeRecords(data.records || []);

  localStorage.setItem(
    'goal',
    String(data.goal ?? 15)
  );

  goalUpdatedAt = Number(data.goalUpdatedAt || 0);
  localRevision = 0;
  syncedRevision = 0;
}

async function createLocalVault(pass,userId=null) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  key = await derive(pass,salt);

  await dbSet('meta',{
    salt:Array.from(salt),
    userId
  });

  records = [];
  goalUpdatedAt = Date.now();

  localStorage.setItem('goal','15');

  localRevision = 0;
  syncedRevision = 0;

  await persistLocal();
}

/* NUVEM */

async function cloudGet() {
  if (!currentUser) return null;

  const {data,error} = await supabase
    .from(CLOUD_TABLE)
    .select('payload,updated_at')
    .eq('user_id',currentUser.id)
    .maybeSingle();

  if (error) throw error;

  return data ? data.payload : null;
}

async function cloudSave() {
  if (!cloudEnabled || !currentUser || !key) return;

  const meta = await dbGet('meta');

  if (!meta || !Array.isArray(meta.salt)) {
    throw new Error('Cofre local não encontrado.');
  }

  const snapshotRevision = localRevision;
  const snapshotRecords = normalizeRecords(records);
  const snapshotGoal = Number(localStorage.getItem('goal') || 15);
  const snapshotGoalUpdatedAt = goalUpdatedAt;

  const encrypted = await encrypt({
    records:snapshotRecords,
    goal:snapshotGoal,
    goalUpdatedAt:snapshotGoalUpdatedAt
  });

  const payload = {
    version:1,
    salt:meta.salt,
    ...encrypted
  };

  const {error} = await supabase
    .from(CLOUD_TABLE)
    .upsert({
      user_id:currentUser.id,
      payload,
      updated_at:new Date().toISOString()
    },{
      onConflict:'user_id'
    });

  if (error) throw error;

  syncedRevision = Math.max(
    syncedRevision,
    snapshotRevision
  );

  setStatus(
    'Sincronizado com segurança em ' +
    new Date().toLocaleString('pt-BR') + '.'
  );
}

async function cloudRestore(pass) {
  const payload = await cloudGet();

  if (!payload) return false;

  if (
    payload.version !== 1 ||
    !Array.isArray(payload.salt)
  ) {
    throw new Error('Formato de cofre na nuvem não reconhecido.');
  }

  const cloudKey = await derive(
    pass,
    new Uint8Array(payload.salt)
  );

  const cloudData = await decrypt({
    iv:payload.iv,
    data:payload.data
  },cloudKey);

  const cloudRecords = normalizeRecords(
    cloudData.records || []
  );

  const localMeta = await dbGet('meta');
  const localBlob = await dbGet('data');

  let localRecords = [];
  let localGoal = 15;
  let localGoalUpdatedAt = 0;

  if (localMeta && localBlob) {
    if (
      localMeta.userId &&
      localMeta.userId !== currentUser.id
    ) {
      throw new Error(
        'Este aparelho possui um cofre vinculado a outra conta. ' +
        'Não vou misturar os dados.'
      );
    }

    try {
      const localKey = await derive(
        pass,
        new Uint8Array(localMeta.salt)
      );

      const localData = await decrypt(
        localBlob,
        localKey
      );

      localRecords = normalizeRecords(
        localData.records || []
      );

      localGoal = Number(localData.goal ?? 15);
      localGoalUpdatedAt = Number(
        localData.goalUpdatedAt || 0
      );
    } catch (_) {
      throw new Error(
        'A senha não desbloqueia o cofre local. ' +
        'Os dados locais foram preservados.'
      );
    }
  }

  key = cloudKey;
  records = mergeRecords(localRecords,cloudRecords);

  const cloudGoal = Number(cloudData.goal ?? 15);
  const cloudGoalUpdatedAt = Number(
    cloudData.goalUpdatedAt || 0
  );

  if (localGoalUpdatedAt > cloudGoalUpdatedAt) {
    localStorage.setItem('goal',String(localGoal));
    goalUpdatedAt = localGoalUpdatedAt;
  } else {
    localStorage.setItem('goal',String(cloudGoal));
    goalUpdatedAt = cloudGoalUpdatedAt;
  }

  await dbSet('meta',{
    salt:payload.salt,
    userId:currentUser.id
  });

  localRevision = 0;
  syncedRevision = 0;

  await persistLocal();

  return true;
}

/* SINCRONIZAÇÃO COM FILA */

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

  try {
    do {
      syncRequested = false;
      setStatus('Sincronizando...');

      await cloudSave();

      if (localRevision > syncedRevision) {
        syncRequested = true;
      }
    } while (syncRequested);

  } finally {
    syncInProgress = false;
  }

  if (localRevision > syncedRevision) {
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
        (error.message || 'erro')
      );
    });
  },900);
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
    throw new Error('Biblioteca do Supabase não carregada. Verifique a internet.');
  }

  const {data,error} = await supabase.auth.signInWithPassword({
    email,
    password:pass
  });

  if (error) throw error;

  currentUser = data.user;
  cloudEnabled = true;

  try {
    const exists = await cloudRestore(pass);

    if (!exists) {
      const meta = await dbGet('meta');

      if (meta && meta.userId && meta.userId !== currentUser.id) {
        throw new Error(
          'O cofre local pertence a outra conta. ' +
          'Não vou enviar esses dados para esta conta.'
        );
      }

      if (meta) {
        await localUnlock(pass);
        await dbSet('meta',{
          ...meta,
          userId:currentUser.id
        });
      } else {
        await createLocalVault(pass,currentUser.id);
      }

      await cloudSave();
    }

    $('pass').value = '';
    setStatus('Conta conectada e dados sincronizados.');

    await openApp();

  } catch (error) {
    currentUser = null;
    cloudEnabled = false;

    try {
      await supabase.auth.signOut();
    } catch (_) {}

    throw error;
  }
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
    throw new Error('Biblioteca do Supabase não carregada. Verifique a internet.');
  }

  const {data,error} = await supabase.auth.signUp({
    email,
    password:pass
  });

  if (error) throw error;

  if (!data.session) {
    showMessage(
      'Cadastro iniciado. Confirme o e-mail recebido. ' +
      'Depois volte e entre no aplicativo.'
    );
    return;
  }

  currentUser = data.user;
  cloudEnabled = true;

  try {
    const meta = await dbGet('meta');

    if (meta && meta.userId && meta.userId !== currentUser.id) {
      throw new Error('O cofre local pertence a outra conta.');
    }

    if (meta) {
      await localUnlock(pass);
      await dbSet('meta',{
        ...meta,
        userId:currentUser.id
      });
    } else {
      await createLocalVault(pass,currentUser.id);
    }

    await cloudSave();

    $('pass').value = '';
    setStatus('Conta criada e cofre sincronizado.');

    await openApp();

  } catch (error) {
    currentUser = null;
    cloudEnabled = false;

    try {
      await supabase.auth.signOut();
    } catch (_) {}

    throw error;
  }
}

async function offlineLogin() {
  const pass = $('pass').value;

  if (!pass) {
    throw new Error('Digite sua senha de proteção.');
  }

  await localUnlock(pass);

  currentUser = null;
  cloudEnabled = false;

  clearTimeout(syncTimer);

  if (supabase) {
    try {
      await supabase.auth.signOut();
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
  ['home','add','goals','settings'].forEach(name => {
    $(name).classList.toggle('hidden',name !== tab);
  });

  if (tab === 'goals') {
    $('goalPercent').value = Number(
      localStorage.getItem('goal') || 15
    );
  }
}

window.showTab = showTab;

function esc(value) {
  return String(value).replace(/[&<>"']/g,char => ({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  }[char]));
}

function render() {
  const currentMonth = month();

  const monthly = records.filter(item =>
    item.date.slice(0,7) === currentMonth
  );

  const income = monthly
    .filter(item => item.type === 'in')
    .reduce((sum,item) => sum + item.value,0);

  const expense = monthly
    .filter(item => item.type === 'out')
    .reduce((sum,item) => sum + item.value,0);

  const goal = Number(localStorage.getItem('goal') || 15);
  const target = income * goal / 100;
  const saved = income - expense;

  $('monthLabel').textContent = new Date().toLocaleDateString(
    'pt-BR',
    {month:'long',year:'numeric'}
  );

  $('balance').textContent = money(saved);
  $('income').textContent = money(income);
  $('expense').textContent = money(expense);

  $('goalText').textContent =
    `Meta: ${goal}% da renda (${money(target)}). ` +
    `Saldo atual: ${money(saved)}.`;

  $('goalProgress').value = target > 0
    ? Math.max(0,Math.min(100,saved / target * 100))
    : 0;

  $('goalPercent').value = goal;

  const sorted = [...monthly].sort((a,b) =>
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

/* BOTÕES */

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

$('date').value = today();

$('saveBtn').onclick = async () => {
  const desc = $('desc').value.trim();
  const value = Number($('value').value);
  const date = $('date').value || today();

  if (!desc || !Number.isFinite(value) || value <= 0) {
    alert('Informe uma descrição e um valor válido.');
    return;
  }

  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
    alert('Informe uma data válida.');
    return;
  }

  records.push({
    id:crypto.randomUUID(),
    desc,
    value,
    type:$('type').value,
    category:$('category').value,
    date
  });

  try {
    await persistLocal();
    scheduleSync();

    $('desc').value = '';
    $('value').value = '';
    $('date').value = today();

    showTab('home');
    render();

  } catch (_) {
    alert('Não foi possível salvar o lançamento.');
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

  try {
    localStorage.setItem('goal',String(value));
    goalUpdatedAt = Date.now();

    await persistLocal();
    scheduleSync();
    render();

    alert('Meta salva.');

  } catch (_) {
    alert('Não foi possível salvar a meta.');
  }
};

/* BACKUP */

function download(data,name,type) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(
    new Blob([data],{type})
  );

  link.href = url;
  link.download = name;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url),1000);
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

    const backupKey = await derive(
      password,
      new Uint8Array(meta.salt)
    );

    /* Confirma a senha antes de exportar. */
    const localBlob = await dbGet('data');
    await decrypt(localBlob,backupKey);

    const encrypted = await encrypt({
      records,
      goal:Number(localStorage.getItem('goal') || 15),
      goalUpdatedAt
    },backupKey);

    download(
      JSON.stringify({
        version:2,
        salt:meta.salt,
        ...encrypted
      }),
      `backup-meu-financeiro-${today()}.json`,
      'application/json'
    );

  } catch (_) {
    alert('Não foi possível exportar. Confira sua senha.');
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
  )) return;

  try {
    const backup = JSON.parse(await file.text());

    if (
      ![1,2].includes(backup.version) ||
      !Array.isArray(backup.salt)
    ) {
      throw new Error('Formato inválido.');
    }

    const backupKey = await derive(
      password,
      new Uint8Array(backup.salt)
    );

    const data = await decrypt(backup,backupKey);

    const imported = normalizeRecords(data.records || []);
    const goal = Number(data.goal ?? 15);

    if (!Number.isFinite(goal) || goal < 0 || goal > 100) {
      throw new Error('Meta inválida.');
    }

    /*
     * Se estiver conectado, só permite substituir a nuvem
     * quando o backup pertence ao mesmo cofre criptográfico.
     */
    if (cloudEnabled && currentUser) {
      const cloudPayload = await cloudGet();

      if (
        cloudPayload &&
        JSON.stringify(cloudPayload.salt) !==
        JSON.stringify(backup.salt)
      ) {
        throw new Error(
          'Este backup usa outra chave de proteção. ' +
          'A restauração online foi bloqueada para proteger seus dados.'
        );
      }
    }

    const oldRecords = records;
    const oldKey = key;
    const oldGoal = localStorage.getItem('goal');
    const oldGoalUpdatedAt = goalUpdatedAt;

    try {
      records = imported;
      key = backupKey;
      localStorage.setItem('goal',String(goal));
      goalUpdatedAt = Number(data.goalUpdatedAt || Date.now());

      await dbSet('meta',{
        salt:backup.salt,
        userId:currentUser ? currentUser.id : null
      });

      await persistLocal();

      if (cloudEnabled && currentUser) {
        await cloudSave();
      }

    } catch (error) {
      records = oldRecords;
      key = oldKey;
      goalUpdatedAt = oldGoalUpdatedAt;

      if (oldGoal === null) {
        localStorage.removeItem('goal');
      } else {
        localStorage.setItem('goal',oldGoal);
      }

      throw error;
    }

    $('backupFile').value = '';
    $('backupPass').value = '';

    render();

    alert('Backup restaurado com sucesso.');

  } catch (error) {
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
      (error.message || 'erro')
    );
  });
};

/* SAIR */

$('logoutBtn').onclick = async () => {
  clearTimeout(syncTimer);

  try {
    if (supabase) {
      await supabase.auth.signOut();
    }
  } catch (_) {}

  key = null;
  records = [];
  currentUser = null;
  cloudEnabled = false;

  syncInProgress = false;
  syncRequested = false;

  $('app').classList.add('hidden');
  $('lock').classList.remove('hidden');
  $('pass').value = '';

  setStatus(
    'Aplicativo bloqueado. Seus dados locais permanecem criptografados.'
  );
};

/* RECONEXÃO */

window.addEventListener('online',() => {
  if (cloudEnabled) {
    syncNow().catch(error => {
      setStatus('Falha ao reconectar: ' + error.message);
    });
  }
});

/* SERVICE WORKER */

if ('serviceWorker' in navigator) {
  window.addEventListener('load',() => {
    navigator.serviceWorker
      .register('./sw.js',{updateViaCache:'none'})
      .then(reg => reg.update().catch(() => {}))
      .catch(error => console.error('Service Worker:',error));
  });
}

/* INICIALIZAÇÃO */

(function boot() {
  if (!initSupabase()) {
    showMessage(
      'Biblioteca de sincronização não carregada. ' +
      'Você ainda pode usar o modo offline se houver dados locais.'
    );
  }

  $('date').value = today();
})();
