'use strict';

/*
 * Meu Controle Financeiro
 * Dados locais criptografados com AES-GCM.
 * A senha da conta também deriva a chave do cofre.
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
  if ($('syncStatus')) {
    $('syncStatus').textContent = message;
  }

  if ($('syncInfo')) {
    $('syncInfo').textContent = message;
  }
}

function showMessage(message) {
  if ($('lockMsg')) {
    $('lockMsg').textContent = message;
  }
}

function initSupabase() {
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
      const request = db
        .transaction(STORE)
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
      const request = db
        .transaction(STORE, 'readwrite')
        .objectStore(STORE)
        .put(value, name);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function derive(password, salt) {
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

async function encrypt(object, encryptionKey = key) {
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
    enc.encode(JSON.stringify(object))
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

function normalizeRecords(list) {
  if (!Array.isArray(list)) {
    throw new Error('Lista de lançamentos inválida.');
  }

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
      !['in', 'out'].includes(item.type) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {
      throw new Error('Existe um lançamento com dados inválidos.');
    }

    return {
      id: String(item.id || crypto.randomUUID()),
      desc: String(item.desc),
      value,
      type: item.type,
      category: String(item.category || 'Outros'),
      date
    };
  });
}

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

function currentGoal() {
  const value = Number(localStorage.getItem('goal') || 15);

  if (!Number.isFinite(value) || value < 0 || value > 100) {
    return 15;
  }

  return value;
}

async function persistLocal() {
  if (!key) {
    throw new Error('Cofre bloqueado.');
  }

  await dbSet(
    'data',
    await encrypt({
      records,
      goal: currentGoal()
    })
  );
}

async function localUnlock(password) {
  const meta = await dbGet('meta');

  if (
    !meta ||
    !Array.isArray(meta.salt)
  ) {
    throw new Error('Não há cofre local neste aparelho.');
  }

  const localKey = await derive(
    password,
    new Uint8Array(meta.salt)
  );

  const blob = await dbGet('data');

  if (!blob) {
    throw new Error('Dados locais não encontrados.');
  }

  const data = await decrypt(blob, localKey);

  const localRecords = normalizeRecords(
    data.records || []
  );

  const goal = Number(data.goal ?? 15);

  if (
    !Number.isFinite(goal) ||
    goal < 0 ||
    goal > 100
  ) {
    throw new Error('Meta local inválida.');
  }

  key = localKey;
  records = localRecords;

  localStorage.setItem('goal', String(goal));
}

async function createLocalVault(password) {
  const salt = crypto.getRandomValues(
    new Uint8Array(16)
  );

  const newKey = await derive(password, salt);

  key = newKey;
  records = [];

  await dbSet('meta', {
    salt: Array.from(salt)
  });

  localStorage.setItem('goal', '15');

  await persistLocal();
}

async function cloudGet() {
  if (!currentUser || !supabase) {
    return null;
  }

  const { data, error } = await supabase
    .from(CLOUD_TABLE)
    .select('payload,updated_at')
    .eq('user_id', currentUser.id)
    .maybeSingle();

  if (error) throw error;

  return data ? data.payload : null;
}

async function cloudSave() {
  if (!cloudEnabled || !currentUser || !key) {
    return;
  }

  const meta = await dbGet('meta');

  if (!meta || !Array.isArray(meta.salt)) {
    throw new Error('Chave local do cofre não encontrada.');
  }

  const payload = {
    version: 1,
    salt: meta.salt,
    ...await encrypt({
      records,
      goal: currentGoal()
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

async function cloudRestore(password) {
  const payload = await cloudGet();

  if (!payload) {
    return false;
  }

  if (
    payload.version !== 1 ||
    !Array.isArray(payload.salt)
  ) {
    throw new Error('Formato de cofre na nuvem não reconhecido.');
  }

  const cloudKey = await derive(
    password,
    new Uint8Array(payload.salt)
  );

  const cloudData = await decrypt(
    {
      iv: payload.iv,
      data: payload.data
    },
    cloudKey
  );

  const cloudRecords = normalizeRecords(
    cloudData.records || []
  );

  const cloudGoal = Number(cloudData.goal ?? 15);

  if (
    !Number.isFinite(cloudGoal) ||
    cloudGoal < 0 ||
    cloudGoal > 100
  ) {
    throw new Error('Meta armazenada na nuvem é inválida.');
  }

  const localMeta = await dbGet('meta');
  const localBlob = await dbGet('data');

  if (
    (localMeta && !localBlob) ||
    (!localMeta && localBlob)
  ) {
    throw new Error(
      'O cofre local está incompleto. Nenhum dado foi substituído. Restaure um backup antes de continuar.'
    );
  }

  let localRecords = [];
  let goalToKeep = cloudGoal;

  if (localMeta && localBlob) {
    try {
      const localKey = await derive(
        password,
        new Uint8Array(localMeta.salt)
      );

      const localData = await decrypt(
        localBlob,
        localKey
      );

      localRecords = normalizeRecords(
        localData.records || []
      );

      const localGoal = Number(localData.goal ?? 15);

      if (
        Number.isFinite(localGoal) &&
        localGoal >= 0 &&
        localGoal <= 100
      ) {
        goalToKeep = localGoal;
      }
    } catch (_) {
      throw new Error(
        'Há um cofre local protegido por outra senha. Nenhum dado local foi substituído. Use a senha correta ou restaure um backup antes de continuar.'
      );
    }
  }

  key = cloudKey;
  records = mergeRecords(localRecords, cloudRecords);

  localStorage.setItem('goal', String(goalToKeep));

  await dbSet('meta', {
    salt: payload.salt
  });

  await persistLocal();

  return true;
}

async function syncNow() {
  if (!currentUser || !cloudEnabled || !key) {
    setStatus('Entre na conta para sincronizar.');
    return;
  }

  if (syncInProgress) {
    setStatus('Sincronização já está em andamento.');
    return;
  }

  syncInProgress = true;

  try {
    setStatus('Verificando dados da nuvem...');

    const payload = await cloudGet();

    if (payload) {
      if (
        payload.version !== 1 ||
        !Array.isArray(payload.salt)
      ) {
        throw new Error(
          'O cofre da nuvem está em formato não reconhecido. Nenhum dado foi alterado.'
        );
      }

      const localMeta = await dbGet('meta');

      if (
        !localMeta ||
        JSON.stringify(localMeta.salt) !==
        JSON.stringify(payload.salt)
      ) {
        throw new Error(
          'A chave de criptografia da nuvem é diferente da chave deste aparelho. Entre novamente antes de sincronizar.'
        );
      }

      const cloudData = await decrypt(
        {
          iv: payload.iv,
          data: payload.data
        },
        key
      );

      const cloudRecords = normalizeRecords(
        cloudData.records || []
      );

      records = mergeRecords(records, cloudRecords);

      /*
       * A meta local é mantida como referência nesta sincronização.
       * Isso evita que uma alteração local recém-salva seja substituída
       * por uma meta antiga que ainda esteja na nuvem.
       */

      await persistLocal();
    }

    await cloudSave();
  } finally {
    syncInProgress = false;
  }
}

function scheduleSync() {
  if (!cloudEnabled || !currentUser) {
    return;
  }

  clearTimeout(syncTimer);

  syncTimer = setTimeout(() => {
    syncNow().catch(error => {
      setStatus(
        'Falha na sincronização: ' +
        (error.message || 'erro')
      );
    });
  }, 1200);
}

async function openApp() {
  $('lock').classList.add('hidden');
  $('app').classList.remove('hidden');

  $('cloudLabel').textContent = cloudEnabled
    ? 'Conta conectada · sincronização ativada'
    : 'Modo local/offline';

  $('date').value = today();

  render();
}

function clearCloudSession() {
  clearTimeout(syncTimer);

  currentUser = null;
  cloudEnabled = false;
  key = null;
  records = [];
  syncInProgress = false;
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
    throw new Error(
      'Biblioteca do Supabase não carregada. Verifique a conexão com a internet.'
    );
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) throw error;

  currentUser = data.user;
  cloudEnabled = true;

  try {
    const restored = await cloudRestore(password);

    if (!restored) {
      const meta = await dbGet('meta');

      if (meta) {
        await localUnlock(password);
      } else {
        await createLocalVault(password);
      }
    }

    await cloudSave();

    $('pass').value = '';

    setStatus('Conta conectada e dados sincronizados.');

    await openApp();
  } catch (error) {
    try {
      await supabase.auth.signOut();
    } catch (_) {}

    clearCloudSession();

    throw error;
  }
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
    throw new Error(
      'Biblioteca do Supabase não carregada. Verifique a conexão com a internet.'
    );
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

    $('pass').value = '';

    setStatus('Conta criada e cofre sincronizado.');

    await openApp();
  } catch (error) {
    try {
      await supabase.auth.signOut();
    } catch (_) {}

    clearCloudSession();

    throw error;
  }
}

async function offlineLogin() {
  const password = $('pass').value;

  if (!password) {
    throw new Error('Digite sua senha de proteção.');
  }

  clearTimeout(syncTimer);

  await localUnlock(password);

  currentUser = null;
  cloudEnabled = false;

  $('pass').value = '';

  setStatus(
    'Acesso local. A sincronização será retomada quando entrar na conta com internet.'
  );

  await openApp();
}

function showTab(tab) {
  ['home', 'add', 'goals', 'settings'].forEach(name => {
    $(name).classList.toggle('hidden', name !== tab);
  });

  if (tab === 'goals') {
    $('goalPercent').value = currentGoal();
  }
}

window.showTab = showTab;

function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char])
  );
}

function render() {
  const currentMonth = month();

  const monthly = records.filter(
    item => item.date.slice(0, 7) === currentMonth
  );

  const income = monthly
    .filter(item => item.type === 'in')
    .reduce((sum, item) => sum + item.value, 0);

  const expense = monthly
    .filter(item => item.type === 'out')
    .reduce((sum, item) => sum + item.value, 0);

  const goal = currentGoal();
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
    `Meta: ${goal}% da renda (${money(target)}). Saldo atual: ${money(saved)}.`;

  $('goalProgress').value = target > 0
    ? Math.max(0, Math.min(100, saved / target * 100))
    : 0;

  $('goalPercent').value = goal;

  const sorted = [...monthly].sort(
    (a, b) => b.date.localeCompare(a.date)
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
      (error.message || 'erro desconhecido.')
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

$('saveBtn').onclick = async () => {
  const desc = $('desc').value.trim();
  const value = Number($('value').value);
  const date = $('date').value || today();
  const type = $('type').value;

  if (
    !desc ||
    !Number.isFinite(value) ||
    value <= 0
  ) {
    alert('Informe uma descrição e um valor válido.');
    return;
  }

  if (
    !['in', 'out'].includes(type) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    alert('Confira o tipo e a data do lançamento.');
    return;
  }

  const previousRecords = records;

  records = [
    ...records,
    {
      id: crypto.randomUUID(),
      desc,
      value,
      type,
      category: $('category').value,
      date
    }
  ];

  try {
    await persistLocal();

    $('desc').value = '';
    $('value').value = '';
    $('date').value = today();

    showTab('home');
    render();
    scheduleSync();
  } catch (error) {
    records = previousRecords;

    alert(
      'Não foi possível salvar o lançamento. ' +
      (error.message || '')
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

  const previousGoal = currentGoal();

  try {
    localStorage.setItem('goal', String(value));

    await persistLocal();

    render();
    scheduleSync();

    alert('Meta salva.');
  } catch (error) {
    localStorage.setItem('goal', String(previousGoal));

    alert('Não foi possível salvar a meta.');
  }
};

function download(data, name, type) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = name;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('exportBtn').onclick = async () => {
  const password = prompt(
    'Digite a senha que protege seu cofre para exportar o backup:'
  );

  if (!password) return;

  try {
    const meta = await dbGet('meta');
    const localBlob = await dbGet('data');

    if (
      !meta ||
      !Array.isArray(meta.salt) ||
      !localBlob
    ) {
      throw new Error('Cofre local incompleto.');
    }

    const backupKey = await derive(
      password,
      new Uint8Array(meta.salt)
    );

    /*
     * Confirma a senha tentando abrir o cofre atual.
     * Uma senha incorreta não gera um backup enganoso.
     */
    await decrypt(localBlob, backupKey);

    const encrypted = await encrypt(
      {
        records,
        goal: currentGoal()
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
      'Não foi possível exportar. Confira a senha e os dados do cofre.'
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

    const backupKey = await derive(
      password,
      new Uint8Array(backup.salt)
    );

    const data = await decrypt(backup, backupKey);

    const importedRecords = normalizeRecords(
      data.records || []
    );

    const goal = Number(data.goal ?? 15);

    if (
      !Number.isFinite(goal) ||
      goal < 0 ||
      goal > 100
    ) {
      throw new Error('Meta inválida.');
    }

    /*
     * Se estiver conectado à nuvem, só aceita um backup
     * protegido pela mesma chave do cofre conectado.
     */
    if (cloudEnabled && currentUser) {
      const meta = await dbGet('meta');
      const localBlob = await dbGet('data');

      if (
        !meta ||
        !localBlob ||
        JSON.stringify(meta.salt) !==
        JSON.stringify(backup.salt)
      ) {
        throw new Error(
          'Este backup não pertence à chave do cofre conectado. Desconecte-se e restaure o backup no modo local.'
        );
      }

      await decrypt(localBlob, backupKey);
    }

    records = importedRecords;
    key = backupKey;

    localStorage.setItem('goal', String(goal));

    await dbSet('meta', {
      salt: backup.salt
    });

    await persistLocal();

    $('backupFile').value = '';
    $('backupPass').value = '';

    render();
    scheduleSync();

    alert('Backup restaurado com sucesso.');
  } catch (error) {
    alert(
      'Não foi possível restaurar: ' +
      (error.message || 'verifique o arquivo e a senha.')
    );
  }
};

$('syncBtn').onclick = () => {
  syncNow().catch(error => {
    setStatus(
      'Falha na sincronização: ' +
      (error.message || 'erro')
    );
  });
};

$('logoutBtn').onclick = async () => {
  clearTimeout(syncTimer);

  try {
    if (supabase && currentUser) {
      await supabase.auth.signOut();
    }
  } catch (_) {}

  clearCloudSession();

  $('app').classList.add('hidden');
  $('lock').classList.remove('hidden');
  $('pass').value = '';

  setStatus(
    'Aplicativo bloqueado. Seus dados locais permanecem criptografados.'
  );

  showMessage('');
};

window.addEventListener('online', () => {
  if (cloudEnabled && currentUser) {
    syncNow().catch(error => {
      setStatus(
        'Falha ao reconectar: ' +
        (error.message || 'erro')
      );
    });
  }
});

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

(function boot() {
  if (!initSupabase()) {
    showMessage(
      'Biblioteca do Supabase indisponível. Você ainda pode entrar no modo local se houver um cofre neste aparelho.'
    );
  }

  $('date').value = today();
})();
