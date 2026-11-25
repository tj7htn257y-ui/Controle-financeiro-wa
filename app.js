'use strict';

/*
 * Meu Controle Financeiro
 * A nuvem armazena somente o cofre criptografado (AES-GCM).
 * A senha usada no login do Supabase também deriva a chave de criptografia.
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

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function month() {
  return today().slice(0,7);
}

function money(n) {
  return Number(n||0).toLocaleString('pt-BR',{
    style:'currency',
    currency:'BRL'
  });
}

function setStatus(message) {
  $('syncStatus').textContent = message;
  if ($('syncInfo')) $('syncInfo').textContent = message;
}

function showMessage(message) {
  $('lockMsg').textContent = message;
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
    {
      name:'AES-GCM',
      length:256
    },
    false,
    ['encrypt','decrypt']
  );
}

async function encrypt(obj,encryptionKey=key) {
  if (!encryptionKey) {
    throw new Error('Aplicativo bloqueado.');
  }

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
    {
      name:'AES-GCM',
      iv:new Uint8Array(blob.iv)
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

    if (
      !item.desc ||
      !Number.isFinite(value) ||
      value <= 0 ||
      !['in','out'].includes(item.type) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.date)
    ) {
      throw new Error('Existe um lançamento com dados inválidos.');
    }

    return {
      id:String(item.id || crypto.randomUUID()),
      desc:String(item.desc),
      value,
      type:item.type,
      category:String(item.category||'Outros'),
      date:item.date
    };
  });
}

function mergeRecords(localList,cloudList) {
  const map = new Map();

  for (const item of [...localList,...cloudList]) {
    map.set(String(item.id),item);
  }

  return normalizeRecords([...map.values()]);
}

async function persistLocal() {
  const goal = Number(localStorage.getItem('goal') || 15);

  await dbSet(
    'data',
    await encrypt({records,goal})
  );
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
}

async function createLocalVault(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  key = await derive(pass,salt);

  await dbSet('meta',{
    salt:Array.from(salt)
  });

  records = [];

  localStorage.setItem('goal','15');

  await persistLocal();
}

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

  const saltMeta = await dbGet('meta');

  if (!saltMeta || !Array.isArray(saltMeta.salt)) {
    throw new Error(
      'Chave local do cofre não encontrada. Entre novamente para restaurar o acesso.'
    );
  }

  const payload = {
    version:1,
    salt:saltMeta.salt,
    ...await encrypt({
      records,
      goal:Number(localStorage.getItem('goal')||15)
    })
  };

  const {error} = await supabase
    .from(CLOUD_TABLE)
    .upsert(
      {
        user_id:currentUser.id,
        payload,
        updated_at:new Date().toISOString()
      },
      {onConflict:'user_id'}
    );

  if (error) throw error;

  setStatus(
    'Sincronizado com segurança em '+
    new Date().toLocaleString('pt-BR')+'.'
  );
}

async function cloudRestore(pass) {
  const payload = await cloudGet();

  if (!payload) return false;

  if (
    payload.version !== 1 ||
    !Array.isArray(payload.salt)
  ) {
    throw new Error(
      'Formato de cofre na nuvem não reconhecido.'
    );
  }

  const cloudKey = await derive(
    pass,
    new Uint8Array(payload.salt)
  );

  const cloudData = await decrypt(
    {
      iv:payload.iv,
      data:payload.data
    },
    cloudKey
  );

  const cloudRecords = normalizeRecords(
    cloudData.records || []
  );

  let localRecords = [];

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

  if (localMeta && localBlob) {
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
    } catch (_) {
      throw new Error(
        'Há um cofre local protegido por outra senha. Por segurança, nenhum dado local foi substituído. Entre com a senha usada nesse aparelho ou faça um backup antes de continuar.'
      );
    }
  }

  key = cloudKey;

  records = mergeRecords(
    localRecords,
    cloudRecords
  );

  localStorage.setItem(
    'goal',
    String(cloudData.goal ?? 15)
  );

  await dbSet('meta',{
    salt:payload.salt
  });

  await persistLocal();

  return true;
}

async function syncNow() {
  if (!currentUser || !cloudEnabled || !key) {
    setStatus('Entre na conta para sincronizar.');
    return;
  }

  setStatus('Verificando dados da nuvem...');

  const payload = await cloudGet();

  if (payload) {
    if (
      payload.version !== 1 ||
      !Array.isArray(payload.salt)
    ) {
      throw new Error(
        'O cofre da nuvem está em um formato não reconhecido. Nenhum dado foi alterado.'
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
        iv:payload.iv,
        data:payload.data
      },
      key
    );

    const cloudRecords = normalizeRecords(
      cloudData.records || []
    );

    records = mergeRecords(
      records,
      cloudRecords
    );

    if (cloudData.goal !== undefined) {
      const cloudGoal = Number(cloudData.goal);

      if (
        Number.isFinite(cloudGoal) &&
        cloudGoal >= 0 &&
        cloudGoal <= 100
      ) {
        localStorage.setItem(
          'goal',
          String(cloudGoal)
        );
      }
    }

    await persistLocal();
  }

  await cloudSave();
}

function scheduleSync() {
  if (!cloudEnabled || !currentUser) return;

  clearTimeout(syncTimer);

  syncTimer = setTimeout(() => {
    syncNow().catch(error => {
      setStatus(
        'Falha na sincronização: '+
        (error.message||'erro')
      );
    });
  },900);
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

async function login() {
  const email = $('email').value.trim();
  const pass = $('pass').value;

  if (!email || !pass) {
    throw new Error('Informe e-mail e senha.');
  }

  if (pass.length < 8) {
    throw new Error(
      'A senha precisa ter pelo menos 8 caracteres.'
    );
  }

  if (!supabase) {
    throw new Error(
      'Não foi possível carregar a biblioteca do Supabase. Verifique a internet.'
    );
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
      const localMeta = await dbGet('meta');

      if (localMeta) {
        await localUnlock(pass);
      } else {
        await createLocalVault(pass);
      }

      await cloudSave();
    } else {
      await cloudSave();
    }

    $('pass').value = '';

    setStatus(
      'Conta conectada e dados sincronizados.'
    );

    await openApp();
  } catch (error) {
    try {
      await supabase.auth.signOut();
    } catch (_) {}

    currentUser = null;
    cloudEnabled = false;
    key = null;

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
    throw new Error(
      'Use uma senha com pelo menos 8 caracteres.'
    );
  }

  if (!supabase) {
    throw new Error(
      'Não foi possível carregar a biblioteca do Supabase. Verifique a internet.'
    );
  }

  const {data,error} = await supabase.auth.signUp({
    email,
    password:pass
  });

  if (error) throw error;

  if (!data.session) {
    showMessage(
      'Cadastro iniciado. Confirme o e-mail recebido e depois entre no aplicativo.'
    );
    return;
  }

  currentUser = data.user;
  cloudEnabled = true;

  try {
    const localMeta = await dbGet('meta');

    if (localMeta) {
      await localUnlock(pass);
    } else {
      await createLocalVault(pass);
    }

    await cloudSave();

    $('pass').value = '';

    setStatus(
      'Conta criada e cofre sincronizado.'
    );

    await openApp();
  } catch (error) {
    try {
      await supabase.auth.signOut();
    } catch (_) {}

    currentUser = null;
    cloudEnabled = false;
    key = null;

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

  $('pass').value = '';

  setStatus(
    'Acesso local. A sincronização será retomada quando entrar na conta com internet.'
  );

  await openApp();
}

function showTab(tab) {
  ['home','add','goals','settings'].forEach(name => {
    $(name).classList.toggle('hidden',name!==tab);
  });

  if (tab==='goals') {
    $('goalPercent').value =
      Number(localStorage.getItem('goal')||15);
  }
}

window.showTab = showTab;

function esc(value) {
  return String(value).replace(
    /[&<>"']/g,
    char => ({
      '&':'&amp;',
      '<':'&lt;',
      '>':'&gt;',
      '"':'&quot;',
      "'":'&#39;'
    }[char])
  );
}

function render() {
  const currentMonth = month();

  const monthly = records.filter(
    item => item.date.slice(0,7)===currentMonth
  );

  const income = monthly
    .filter(item=>item.type==='in')
    .reduce((s,x)=>s+x.value,0);

  const expense = monthly
    .filter(item=>item.type==='out')
    .reduce((s,x)=>s+x.value,0);

  const goal = Number(
    localStorage.getItem('goal')||15
  );

  const target = income*goal/100;
  const saved = income-expense;

  $('monthLabel').textContent =
    new Date().toLocaleDateString(
      'pt-BR',
      {month:'long',year:'numeric'}
    );

  $('balance').textContent = money(saved);
  $('income').textContent = money(income);
  $('expense').textContent = money(expense);

  $('goalText').textContent =
    `Meta: ${goal}% da renda (${money(target)}). Saldo atual: ${money(saved)}.`;

  $('goalProgress').value =
    target>0
      ? Math.max(0,Math.min(100,saved/target*100))
      : 0;

  $('goalPercent').value = goal;

  const sorted = [...monthly].sort(
    (a,b)=>b.date.localeCompare(a.date)
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
          ${item.type==='in'?'+':'−'} ${money(item.value)}
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
      'Não foi possível entrar: '+
      (error.message||'verifique seus dados.')
    );
  }
};

$('createBtn').onclick = async () => {
  try {
    showMessage('');
    await signup();
  } catch (error) {
    showMessage(
      'Não foi possível criar a conta: '+
      (error.message||'erro desconhecido')
    );
  }
};

$('offlineBtn').onclick = async () => {
  try {
    showMessage('');
    await offlineLogin();
  } catch (error) {
    showMessage(
      error.message||
      'Não foi possível abrir os dados locais.'
    );
  }
};

$('date').value = today();

$('saveBtn').onclick = async () => {
  const desc = $('desc').value.trim();
  const value = Number($('value').value);
  const date = $('date').value||today();

  if (
    !desc ||
    !Number.isFinite(value) ||
    value<=0
  ) {
    alert(
      'Informe uma descrição e um valor válido.'
    );
    return;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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
  } catch (error) {
    alert(
      'Não foi possível salvar o lançamento.'
    );
  }
};

$('goalSave').onclick = async () => {
  const raw = $('goalPercent').value;
  const value = Number(raw);

  if (
    raw.trim()==='' ||
    !Number.isFinite(value) ||
    value<0 ||
    value>100
  ) {
    alert(
      'Informe um percentual entre 0 e 100.'
    );
    return;
  }

  try {
    localStorage.setItem(
      'goal',
      String(value)
    );

    await persistLocal();
    scheduleSync();
    render();

    alert('Meta salva.');
  } catch (error) {
    alert('Não foi possível salvar a meta.');
  }
};

function download(data,name,type) {
  const link = document.createElement('a');

  const url = URL.createObjectURL(
    new Blob([data],{type})
  );

  link.href = url;
  link.download = name;
  link.click();

  setTimeout(
    ()=>URL.revokeObjectURL(url),
    1000
  );
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

    const encrypted = await encrypt(
      {
        records,
        goal:Number(localStorage.getItem('goal')||15)
      },
      backupKey
    );

    download(
      JSON.stringify({
        version:2,
        salt:meta.salt,
        ...encrypted
      }),
      `backup-meu-financeiro-${today()}.json`,
      'application/json'
    );
  } catch (error) {
    alert(
      'Não foi possível exportar. Confira sua senha.'
    );
  }
};

$('importBtn').onclick = async () => {
  const file = $('backupFile').files[0];
  const password = $('backupPass').value;

  if (!file || !password) {
    alert(
      'Escolha o arquivo e informe a senha do backup.'
    );
    return;
  }

  if (file.size>10*1024*1024) {
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
      ![1,2].includes(backup.version) ||
      !Array.isArray(backup.salt)
    ) {
      throw new Error('Formato inválido.');
    }

    const backupKey = await derive(
      password,
      new Uint8Array(backup.salt)
    );

    const data = await decrypt(
      backup,
      backupKey
    );

    const imported = normalizeRecords(
      data.records||[]
    );

    const goal = Number(data.goal??15);

    if (
      !Number.isFinite(goal) ||
      goal<0 ||
      goal>100
    ) {
      throw new Error('Meta inválida.');
    }

    records = imported;

    localStorage.setItem(
      'goal',
      String(goal)
    );

    key = backupKey;

    await dbSet('meta',{
      salt:backup.salt
    });

    await persistLocal();

    $('backupFile').value = '';
    $('backupPass').value = '';

    render();
    scheduleSync();

    alert('Backup restaurado com sucesso.');
  } catch (error) {
    alert(
      'Não foi possível restaurar. Verifique o arquivo e a senha.'
    );
  }
};

$('syncBtn').onclick = () => {
  syncNow().catch(error => {
    setStatus(
      'Falha na sincronização: '+
      (error.message||'erro')
    );
  });
};

$('logoutBtn').onclick = async () => {
  try {
    if (supabase && currentUser) {
      await supabase.auth.signOut();
    }
  } catch (_) {}

  clearTimeout(syncTimer);

  key = null;
  records = [];
  currentUser = null;
  cloudEnabled = false;

  $('app').classList.add('hidden');
  $('lock').classList.remove('hidden');
  $('pass').value = '';

  setStatus(
    'Aplicativo bloqueado. Seus dados locais permanecem criptografados.'
  );
};

window.addEventListener('online',()=>{
  if (cloudEnabled) {
    syncNow().catch(error => {
      setStatus(
        'Falha ao reconectar: '+
        (error.message||'erro')
      );
    });
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load',()=>{
    navigator.serviceWorker
      .register('./sw.js',{updateViaCache:'none'})
      .then(reg=>reg.update().catch(()=>{}))
      .catch(err=>console.error('Service Worker:',err));
  });
}

(function boot(){
  if (!initSupabase()) {
    showMessage(
      'Biblioteca de sincronização não carregada. Você ainda pode usar o modo offline se houver dados locais.'
    );
  }

  $('date').value = today();
})();
