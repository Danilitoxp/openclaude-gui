import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './style.css';

// Estado global
let currentView = 'chat';
let logBuffer = [];
let autoScroll = true;
let lastStatus = null;

// Elementos DOM
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const restartBtn = document.getElementById('restartBtn');
const chatMessages = document.getElementById('chatMessages');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const logsContainer = document.getElementById('logsContainer');
const logCount = document.getElementById('logCount');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const openLogsFolderBtn = document.getElementById('openLogsFolderBtn');

// Inicialização
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupEventListeners();
  await loadSettings();
  await updateStatus();
  setupLogListener();
  startStatusPolling();
  console.log('OpenClaude GUI loaded');
});

// Navegação
function setupNavigation() {
  document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
}

function showView(viewName) {
  currentView = viewName;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-btn[data-view="${viewName}"]`).classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.add('active');
}

// Atualização de status
async function updateStatus() {
  try {
    const info = await invoke('get_status');
    const dotClasses = { offline: 'offline', starting: 'starting', running: 'running', error: 'error' };
    const textMap = { offline: 'Offline', starting: 'Iniciando...', running: 'Ativo', error: 'Erro' };

    statusDot.className = 'status-dot ' + (dotClasses[info.status] || 'offline');
    statusText.textContent = textMap[info.status] || 'Desconhecido';

    startBtn.disabled = info.status === 'starting' || info.status === 'running';
    stopBtn.disabled = info.status !== 'running';
    restartBtn.disabled = info.status !== 'running';

    if (info.status === 'starting') {
      showNotification('Iniciando OpenClaude...', 'info');
    }

    lastStatus = info;
    return info;
  } catch (err) {
    console.error('Error getting status:', err);
    return { status: 'offline' };
  }
}

// Chat
function addMessage(text, type) {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${type}`;

  if (type !== 'system') {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copiar';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copiado!';
      setTimeout(() => copyBtn.textContent = 'Copiar', 1500);
    };
    msgDiv.appendChild(copyBtn);
  }

  // Renderização básica Markdown-like
  let renderedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');

  msgDiv.innerHTML += renderedText;
  chatMessages.appendChild(msgDiv);

  if (autoScroll) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

async function sendMessage() {
  const text = promptInput.value.trim();
  if (!text) return;

  promptInput.value = '';
  addMessage(text, 'user');

  try {
    await invoke('send_command', { input: text });
  } catch (err) {
    addMessage(`Erro: ${err}`, 'system');
  }
}

// Logs
function addLogEntry(source, message) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${source}`;

  const now = new Date();
  const timestamp = now.toLocaleTimeString('pt-BR', { hour12: false });
  const sourceLabel = { stdout: 'OUT', stderr: 'ERR', system: 'SYS' }[source] || source;

  entry.innerHTML = `<span class="timestamp">[${timestamp}]</span><span class="source">${sourceLabel}</span>${escapeHtml(message)}`;

  logsContainer.appendChild(entry);
  logBuffer.push(source);

  if (logBuffer.length > 1000) {
    logsContainer.removeChild(logsContainer.firstChild);
    logBuffer.shift();
  }

  logCount.textContent = logBuffer.length;

  if (logsContainer.scrollHeight - logsContainer.scrollTop <= logsContainer.clientHeight + 100) {
    logsContainer.scrollTop = logsContainer.scrollHeight;
  }
}

async function clearLogs() {
  logsContainer.innerHTML = '';
  logBuffer = [];
  logCount.textContent = '0';
  try {
    await invoke('clear_logs');
  } catch (err) {
    console.error('Error clearing logs:', err);
  }
}

// Configurações
async function loadSettings() {
  try {
    const config = await invoke('get_config');
    document.getElementById('cfgPath').value = config.openclaude_path;
    document.getElementById('cfgArgs').value = config.args[0] || '';
    document.getElementById('cfgWorkDir').value = config.working_dir;
    document.getElementById('cfgPort').value = config.port;
    document.getElementById('cfgTimeout').value = config.startup_timeout_ms;
    document.getElementById('cfgAutoScroll').checked = config.auto_scroll;
    document.getElementById('cfgStartWindows').checked = config.start_with_windows;

    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === config.theme.toLowerCase());
    });

    autoScroll = config.auto_scroll;
    applyTheme(config.theme.toLowerCase());
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

async function saveSettings() {
  const config = {
    openclaude_path: document.getElementById('cfgPath').value,
    args: [document.getElementById('cfgArgs').value].filter(Boolean),
    working_dir: document.getElementById('cfgWorkDir').value,
    port: parseInt(document.getElementById('cfgPort').value) || 3000,
    startup_timeout_ms: parseInt(document.getElementById('cfgTimeout').value) || 30000,
    theme: document.querySelector('.theme-btn.active').dataset.theme.toLowerCase(),
    start_with_windows: document.getElementById('cfgStartWindows').checked,
    auto_scroll: document.getElementById('cfgAutoScroll').checked
  };

  try {
    await invoke('save_config', { newConfig: config });
    autoScroll = config.auto_scroll;
    applyTheme(config.theme);
    showNotification('Configurações salvas!', 'success');
  } catch (err) {
    showNotification(`Erro ao salvar: ${err}`, 'error');
  }
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.body.style.background = '#f5f5f5';
    document.body.style.color = '#333';
    document.querySelector('.sidebar').style.background = '#e0e0e0';
    document.querySelector('.header').style.background = '#e0e0e0';
  } else {
    document.body.style.background = '#1a1a2e';
    document.body.style.color = '#eee';
    document.querySelector('.sidebar').style.background = '#16213e';
    document.querySelector('.header').style.background = '#16213e';
  }
}

// Notificações
function showNotification(message, type = 'info') {
  const notif = document.createElement('div');
  notif.className = `notification ${type}`;
  notif.textContent = message;
  document.body.appendChild(notif);
  setTimeout(() => notif.remove(), 3000);
}

// Event Listeners
function setupEventListeners() {
  sendBtn.addEventListener('click', sendMessage);

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  startBtn.addEventListener('click', async () => {
    try {
      await invoke('start_process');
    } catch (err) {
      showNotification(`Erro: ${err}`, 'error');
    }
  });

  stopBtn.addEventListener('click', async () => {
    try {
      await invoke('stop_process');
      showNotification('Processo parado', 'info');
    } catch (err) {
      showNotification(`Erro: ${err}`, 'error');
    }
  });

  restartBtn.addEventListener('click', async () => {
    try {
      await invoke('restart_process');
    } catch (err) {
      showNotification(`Erro: ${err}`, 'error');
    }
  });

  clearLogsBtn.addEventListener('click', clearLogs);

  openLogsFolderBtn.addEventListener('click', async () => {
    try {
      const result = await invoke('open_logs_folder');
      showNotification(result.message, 'success');
    } catch (err) {
      showNotification(`Erro: ${err}`, 'error');
    }
  });

  document.getElementById('saveSettingsBtn').addEventListener('click', saveSettings);

  document.getElementById('resetSettingsBtn').addEventListener('click', async () => {
    await loadSettings();
    showNotification('Configurações restauradas', 'success');
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('testPathBtn').addEventListener('click', async () => {
    const path = document.getElementById('cfgArgs').value;
    try {
      const result = await invoke('test_connection');
      const testResult = document.getElementById('testResult');
      testResult.textContent = result.success ? 'Válido!' : 'Não encontrado';
      testResult.style.color = result.success ? '#4caf50' : '#e74c3c';
    } catch (err) {
      showNotification(`Erro: ${err}`, 'error');
    }
  });
}

// Listener de logs do backend
function setupLogListener() {
  listen('log-update', (event) => {
    const data = event.payload;
    addLogEntry(data.source, data.message);
  });
}

// Polling de status
function startStatusPolling() {
  setInterval(async () => {
    const status = await updateStatus();
    if (JSON.stringify(status) !== JSON.stringify(lastStatus)) {
      lastStatus = status;
    }
  }, 2000);
}

// Helper
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
