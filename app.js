
'use strict';

const $ = id => document.getElementById(id);

const DB = 'mcf-db';
const STORE = 'vault';
const PBKDF2_ITERATIONS = 250000;

let key = null;
let records = [];

const enc = new TextEncoder();
const dec = new TextDecoder();

function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function month() {
  return today().slice(0, 7);
}

function money(n) {
  return Number(n || 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
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
      const request = db.transaction(STORE).objectStore(STORE).get(name);
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
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite')
        .objectStore(STORE)
        .put(value, name);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

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

async function encrypt(obj, encryptionKey = key) {
  if (!encryptionKey) {
    throw new Error('Aplicativo bloqueado.');
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    enc.encode(JSON.stringify(obj))
  );

  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(encrypted))
  };
}

async function decrypt(blob, encryptionKey = key) {
  if (!encryptionKey || !blob || !blob.iv || !blob.data) {
    throw new Error('Dados criptografados inválidos.');
  }

  const result = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(blob.iv)
    },
    encryptionKey,
    new Uint8Array(blob.data)
  );

  return JSON.parse(dec.decode(result));
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
      !['in', 'out'].includes(item.type) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(item.date)
    ) {
      throw new Error('Existe um lançamento com dados inválidos.');
    }

    return {
      id: String(item.id || crypto.randomUUID()),
      desc: String(item.desc),
      value,
      type: item.type,
      category: String(item.category || 'Outros'),
      date: item.date
    };
  });
}

async function persist() {
  const goal = Number(localStorage.getItem('goal') || 15);

  await dbSet('data', await encrypt({
    records,
    goal
  }));
}

async function unlock(pass) {
  const meta = await dbGet('meta');

  if (!meta || !Array.isArray(meta.salt)) {
    throw new Error('Configuração de acesso não encontrada.');
  }

  const derivedKey = await derive(
    pass,
    new Uint8Array(meta.salt)
  );

  const storedData = await dbGet('data');

  if (!storedData) {
    throw new Error('Dados financeiros não encontrados.');
  }

  const data = await decrypt(storedData, derivedKey);

  key = derivedKey;
  records = normalizeRecords(data.records || []);

  localStorage.setItem('goal', String(data.goal ?? 15));

  $('lock').classList.add('hidden');
  $('app').classList.remove('hidden');

  render();
}

$('createBtn').onclick = async () => {
  const pass = $('newPass').value;
  const confirmation = $('confirmPass').value;

  if (pass.length < 8 || pass !== confirmation) {
    $('lockMsg').textContent =
      'Use pelo menos 8 caracteres e confirme a mesma senha.';
    return;
  }

  try {
    if (await dbGet('meta')) {
      $('lockMsg').textContent =
        'Já existe uma configuração neste aparelho. Entre com sua senha.';
      return;
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));

    key = await derive(pass, salt);

    await dbSet('meta', {
      salt: Array.from(salt)
    });

    records = [];
    localStorage.setItem('goal', '15');

    await persist();

    $('lock').classList.add('hidden');
    $('app').classList.remove('hidden');

    render();
  } catch (error) {
    key = null;

    $('lockMsg').textContent =
      'Não foi possível criar o acesso neste navegador.';
  }
};

(async () => {
  try {
    const meta = await dbGet('meta');

    if (meta) {
      $('setup').classList.add('hidden');
      $('login').classList.remove('hidden');
    }
  } catch (error) {
    $('lockMsg').textContent =
      'Seu navegador não permite armazenamento seguro.';
  }
})();

$('loginBtn').onclick = async () => {
  const pass = $('pass').value;

  if (!pass) {
    $('lockMsg').textContent = 'Digite sua senha.';
    return;
  }

  try {
    await unlock(pass);
    $('pass').value = '';
    $('lockMsg').textContent = '';
  } catch (error) {
    key = null;
    $('lockMsg').textContent =
      'Senha incorreta ou dados indisponíveis.';
  }
};

function showTab(tab) {
  ['home', 'add', 'goals', 'settings'].forEach(name => {
    $(name).classList.toggle('hidden', name !== tab);
  });

  if (tab === 'goals') {
    $('goalPercent').value =
      Number(localStorage.getItem('goal') || 15);
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
  })[char]);
}

function render() {
  const currentMonth = month();

  const monthlyRecords = records.filter(item =>
    item.date.slice(0, 7) === currentMonth
  );

  const income = monthlyRecords
    .filter(item => item.type === 'in')
    .reduce((sum, item) => sum + item.value, 0);

  const expense = monthlyRecords
    .filter(item => item.type === 'out')
    .reduce((sum, item) => sum + item.value, 0);

  const goal = Number(localStorage.getItem('goal') || 15);
  const target = income * goal / 100;
  const saved = income - expense;

  $('monthLabel').textContent =
    new Date().toLocaleDateString('pt-BR', {
      month: 'long',
      year: 'numeric'
    });

  $('balance').textContent = money(saved);
  $('income').textContent = money(income);
  $('expense').textContent = money(expense);

  $('goalText').textContent =
    `Meta: ${goal}% da renda (${money(target)}). Saldo atual: ${money(saved)}.`;

  $('goalProgress').value =
    target > 0
      ? Math.max(0, Math.min(100, saved / target * 100))
      : 0;

  $('goalPercent').value = goal;

  const sorted = [...monthlyRecords].sort((a, b) =>
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

$('date').value = today();

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

  try {
    records.push({
      id: crypto.randomUUID(),
      desc,
      value,
      type: $('type').value,
      category: $('category').value,
      date
    });

    await persist();

    $('desc').value = '';
    $('value').value = '';
    $('date').value = today();

    showTab('home');
    render();
  } catch (error) {
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
    localStorage.setItem('goal', String(value));
    await persist();
    render();
    alert('Meta salva.');
  } catch (error) {
    alert('Não foi possível salvar a meta.');
  }
};

$('logoutBtn').onclick = () => {
  key = null;
  records = [];

  $('app').classList.add('hidden');
  $('lock').classList.remove('hidden');
  $('login').classList.remove('hidden');
  $('setup').classList.add('hidden');

  $('pass').value = '';
  $('newPass').value = '';
  $('confirmPass').value = '';
  $('lockMsg').textContent = '';
};

function download(data, name, type) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(
    new Blob([data], { type })
  );

  link.href = url;
  link.download = name;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('exportBtn').onclick = async () => {
  const password = prompt(
    'Crie uma senha para proteger este backup (mínimo 8 caracteres):'
  );

  if (!password || password.length < 8) {
    alert('A senha deve ter pelo menos 8 caracteres.');
    return;
  }

  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const backupKey = await derive(password, salt);

    const encrypted = await encrypt({
      records,
      goal: Number(localStorage.getItem('goal') || 15)
    }, backupKey);

    download(
      JSON.stringify({
        version: 1,
        salt: Array.from(salt),
        ...encrypted
      }),
      `backup-meu-financeiro-${today()}.json`,
      'application/json'
    );
  } catch (error) {
    alert('Não foi possível exportar o backup.');
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
      backup.version !== 1 ||
      !Array.isArray(backup.salt)
    ) {
      throw new Error('Formato de backup inválido.');
    }

    const backupKey = await derive(
      password,
      new Uint8Array(backup.salt)
    );

    const data = await decrypt(backup, backupKey);

    const importedRecords = normalizeRecords(data.records || []);
    const importedGoal = Number(data.goal ?? 15);

    if (
      !Number.isFinite(importedGoal) ||
      importedGoal < 0 ||
      importedGoal > 100
    ) {
      throw new Error('Meta inválida no backup.');
    }

    records = importedRecords;
    localStorage.setItem('goal', String(importedGoal));

    await persist();

    render();

    $('backupFile').value = '';
    $('backupPass').value = '';

    alert('Backup restaurado com sucesso.');
  } catch (error) {
    alert(
      'Não foi possível restaurar. Verifique o arquivo e a senha.'
    );
  }
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', {
      updateViaCache: 'none'
    }).then(registration => {
      registration.update().catch(() => {});
    }).catch(error => {
      console.error('Erro ao registrar o Service Worker:', error);
    });
  });
}
