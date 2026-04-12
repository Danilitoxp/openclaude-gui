import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './style.css';

// Tauri Window Instance
const appWindow = getCurrentWindow();

// DOM Elements - Titlebar
const minimizeBtn = document.querySelector('.titlebar-btn.minimize');
const maximizeBtn = document.querySelector('.titlebar-btn.maximize');
const closeBtn = document.querySelector('.titlebar-btn.close');

// DOM Elements - Input
const chatInput = document.querySelector('.chat-input');
const sendBtn = document.querySelector('.send-btn');
const attachBtn = document.querySelector('.attach-btn');
const modelSelector = document.querySelector('.model-selector');

// Window Controls
minimizeBtn?.addEventListener('click', () => appWindow.minimize());
maximizeBtn?.addEventListener('click', () => appWindow.toggleMaximize());
closeBtn?.addEventListener('click', () => appWindow.close());

// Global State
let currentSessionId = null;
let currentThinkingBubble = null;
let lastAssistantBubble = null;
const recentList = document.querySelector('.recent-list');

// ── Provider Modal ──────────────────────────────────────────────
const providerModal   = document.getElementById('providerModal');
const cancelProvider  = document.getElementById('cancelProvider');
const activateProvider = document.getElementById('activateProvider');
const providerDropdown = document.getElementById('providerDropdown');
const dropdownSelected = document.getElementById('dropdownSelected');
const dropdownOptions  = document.getElementById('dropdownOptions');

const PROVIDERS = [
  { id: 'anthropic',    name: 'Anthropic',    icon: '🔮', model: 'claude-sonnet-4-6',           baseUrl: 'https://api.anthropic.com',                               requiresKey: true },
  { id: 'openai',       name: 'OpenAI',       icon: '🤖', model: 'gpt-4o',                      baseUrl: 'https://api.openai.com/v1',                               requiresKey: true },
  { id: 'gemini',       name: 'Gemini',       icon: '✨', model: 'gemini-3-flash-preview',      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresKey: true },
  { id: 'groq',         name: 'Groq',         icon: '⚡', model: 'llama-3.3-70b-versatile',    baseUrl: 'https://api.groq.com/openai/v1',                          requiresKey: true },
  { id: 'deepseek',     name: 'DeepSeek',     icon: '🌊', model: 'deepseek-chat',               baseUrl: 'https://api.deepseek.com/v1',                             requiresKey: true },
  { id: 'mistral',      name: 'Mistral',      icon: '🌪️', model: 'mistral-large-latest',       baseUrl: 'https://api.mistral.ai/v1',                               requiresKey: true },
  { id: 'openrouter',   name: 'OpenRouter',   icon: '🔀', model: 'openai/gpt-4o',              baseUrl: 'https://openrouter.ai/api/v1',                            requiresKey: true },
  { id: 'moonshotai',   name: 'Moonshot AI',  icon: '🌙', model: 'kimi-k2.5',                  baseUrl: 'https://api.moonshot.ai/v1',                              requiresKey: true },
  { id: 'together',     name: 'Together AI',  icon: '🤝', model: 'Qwen/Qwen3.5-9B',            baseUrl: 'https://api.together.xyz/v1',                             requiresKey: true },
  { id: 'ollama',       name: 'Ollama',       icon: '🦙', model: 'llama3.1:8b',                baseUrl: 'http://localhost:11434/v1',                               requiresKey: false },
  { id: 'lmstudio',    name: 'LM Studio',    icon: '🖥️', model: 'local-model',               baseUrl: 'http://localhost:1234/v1',                                requiresKey: false },
  { id: 'custom',       name: 'Custom',       icon: '⚙️', model: '',                            baseUrl: '',                                                        requiresKey: false },
];

let selectedProvider = null;

function renderProviderOptions() {
  dropdownOptions.innerHTML = '';
  PROVIDERS.forEach(p => {
    const div = document.createElement('div');
    div.className = 'dropdown-option';
    if (selectedProvider?.id === p.id) div.classList.add('selected');
    div.textContent = p.name;
    div.onclick = (e) => {
        e.stopPropagation();
        selectProvider(p);
        providerDropdown.classList.remove('open');
    };
    dropdownOptions.appendChild(div);
  });
}

dropdownSelected?.addEventListener('click', () => {
    providerDropdown.classList.toggle('open');
});

function selectProvider(p) {
  selectedProvider = p;
  dropdownSelected.textContent = p.name;
  document.getElementById('pfName').value = p.name;
  document.getElementById('pfBaseUrl').value = p.baseUrl;
  document.getElementById('pfModel').value = p.model;
  document.getElementById('pfApiKey').value = '';
}

function openProviderModal() {
  renderProviderOptions();
  
  // Tentar carregar dados salvos do localStorage
  const saved = localStorage.getItem('openclaude_provider_full');
  if (saved) {
    try {
      const data = JSON.parse(saved);
      document.getElementById('pfName').value = data.name || '';
      document.getElementById('pfBaseUrl').value = data.baseUrl || '';
      document.getElementById('pfModel').value = data.model || '';
      document.getElementById('pfApiKey').value = data.apiKey || '';
      
      // Marcar o provedor na lista
      selectedProvider = PROVIDERS.find(p => p.name === data.name) || null;
      renderProviderOptions();
    } catch (e) {
      console.error('Falha ao parsear config salva:', e);
    }
  }

  providerModal.classList.add('open');
}

function closeModal() {
  providerModal.classList.remove('open');
  selectedProvider = null;
}

modelSelector?.addEventListener('click', openProviderModal);
cancelProvider?.addEventListener('click', closeModal);

providerModal?.addEventListener('click', (e) => {
  if (e.target === providerModal) closeModal();
});

activateProvider?.addEventListener('click', async () => {
  const name    = document.getElementById('pfName').value.trim();
  const baseUrl = document.getElementById('pfBaseUrl').value.trim();
  const model   = document.getElementById('pfModel').value.trim();
  const apiKey  = document.getElementById('pfApiKey').value.trim();

  if (!name || !baseUrl || !model) {
    showNotification('Preencha Nome, Base URL e Modelo.', 'error');
    return;
  }

  // Atualiza o label do seletor na bottom bar
  document.querySelector('.model-selector span').textContent = `${name.toUpperCase()} · ${model}`;

  // Persistência local
  localStorage.setItem('openclaude_provider', JSON.stringify({ name, model }));
  localStorage.setItem('openclaude_provider_full', JSON.stringify({ name, baseUrl, model, apiKey }));

  // Atualiza o label do seletor na bottom bar
  updateModelLabel(name, model);

  // Envia o comando /provider para o processo caso esteja rodando
  try {
    const status = await invoke('get_status');
    if (status.status === 'running') {
      await invoke('send_command', { input: `/provider` });
    }
  } catch (_) {}

  showNotification(`Provedor "${name}" ativado!`, 'success');
  closeModal();
});

function updateModelLabel(name, model) {
    const label = document.querySelector('.model-selector span');
    if (label) label.textContent = `${name.toUpperCase()} · ${model}`;
}


const loadSessionsList = async () => {
  try {
    const sessions = await invoke('list_sessions');
    if (recentList) {
      recentList.innerHTML = '';
      sessions.forEach(filename => {
        const id = filename.replace('.json', '');
        const li = document.createElement('li');
        li.className = `recent-item ${id === currentSessionId ? 'active' : ''}`;
        
        // Texto da conversa
        let readable = id.replace(/^session_/, '');
        readable = readable.replace(/_\d{4}-\d{2}-\d{2}T.*$/, ''); 
        readable = readable.replace(/_/g, ' '); 
        
        const textSpan = document.createElement('span');
        textSpan.className = 'item-text';
        textSpan.textContent = readable;
        li.appendChild(textSpan);

        // Botão de deletar
        const delBtn = document.createElement('button');
        delBtn.className = 'delete-session-btn';
        delBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        `;
        delBtn.title = 'Excluir conversa';
        delBtn.onclick = async (e) => {
          e.stopPropagation(); // Não abrir a conversa ao deletar
          if (confirm(`Excluir a conversa "${readable}"?`)) {
            try {
              await invoke('delete_session', { id });
              if (currentSessionId === id) {
                startNewSession();
              }
              await loadSessionsList();
            } catch (err) {
              console.error('[ERROR] Falha ao deletar sessão:', err);
            }
          }
        };
        li.appendChild(delBtn);

        li.onclick = () => selectSession(id);
        recentList.appendChild(li);
      });
    }
  } catch (err) {
    console.error('[ERROR] Falha ao carregar lista de sessões:', err);
  }
};

const selectSession = async (id) => {
  try {
    const messages = await invoke('load_session', { id });
    currentSessionId = id;
    
    responseArea.innerHTML = '';
    const hero = document.querySelector('.hero-section');
    if (hero) hero.classList.add('chat-mode');
    if (responseArea) responseArea.style.display = 'flex';
    
    messages.forEach(msg => {
      const type = msg.role === 'user' ? 'user-message' : 'stdout';
      lastAssistantBubble = null;
      createLogLine(msg.content, type);
    });
    
    await loadSessionsList();
    if (sidebar && !sidebar.classList.contains('collapsed')) sidebar.classList.add('collapsed');
  } catch (err) {
    console.error('[ERROR] Falha ao carregar sessão:', err);
  }
};

// Listen for log events (keeping background active)
const responseArea = document.getElementById('responseArea');

const createLogLine = (text, type) => {
  // Se for um pedaço de resposta (stdout) e já tivermos uma bolha ativa, anexa nela
  if (type === 'stdout' && lastAssistantBubble) {
    const content = lastAssistantBubble.querySelector('.content');
    content.textContent += text;
    responseArea.scrollTo({ top: responseArea.scrollHeight, behavior: 'smooth' });
    return lastAssistantBubble;
  }

  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  
  const content = document.createElement('div');
  content.className = 'content';

  if (type === 'stdout' || type === 'api-response' || type === 'thinking') {
    const icon = document.createElement('img');
    icon.src = '/src/assets/icon.png';
    icon.className = 'assistant-icon';
    line.appendChild(icon);

    if (type === 'thinking') {
      content.textContent = 'Pensando';
    } else {
      content.textContent = text
          .replace(/^\[API RESPONSE\]\s*/, '')
          .replace(/^\[API\]\s*/, '')
          .trim();
    }
    
    // Se for o início de uma resposta, marca como bolha ativa
    if (type === 'stdout') {
      lastAssistantBubble = line;
    } else {
      lastAssistantBubble = null;
    }
  } else if (type === 'user-message') {
    content.textContent = text.replace(/^\[USER\]\s*/, '').trim();
    lastAssistantBubble = null; // Mensagem do usuário interrompe a corrente
  } else {
    content.textContent = text;
    lastAssistantBubble = null;
  }

  line.appendChild(content);
  responseArea.appendChild(line);
  responseArea.scrollTo({ top: responseArea.scrollHeight, behavior: 'smooth' });
  
  return line;
};

listen('log-update', async (event) => {
  const data = event.payload;

  // 'done' = fim da resposta streaming -> Salva a conversa
  if (data.source === 'done') {
    lastAssistantBubble = null;
    if (currentThinkingBubble) { currentThinkingBubble.remove(); currentThinkingBubble = null; }
    
    if (currentSessionId) {
       await invoke('save_session', { id: currentSessionId });
       await loadSessionsList();
    }
    return;
  }

  if (!data.message || !data.message.trim()) return;

  const hero = document.querySelector('.hero-section');
  if (hero && !hero.classList.contains('chat-mode')) hero.classList.add('chat-mode');
  const placeholder = responseArea.querySelector('.logs-placeholder');
  if (placeholder) placeholder.remove();

  if (currentThinkingBubble && data.source === 'stdout') {
    currentThinkingBubble.remove();
    currentThinkingBubble = null;
  }

  createLogLine(data.message, data.source);
});

// Listen for custom events from frontend
window.addEventListener('openclaude:user-message', (event) => {
  const data = event.detail;
  console.log(`[USER] ${data.message}`);
  createLogLine(`[USER] ${data.message}`, 'user-message');
});

window.addEventListener('openclaude:api-response', (event) => {
  const data = event.detail;
  console.log(`[API RESPONSE] ${data.message}`);
  createLogLine(`[API RESPONSE] ${data.message}`, 'api-response');
});

window.addEventListener('openclaude:error', (event) => {
  const data = event.detail;
  console.error(`[ERROR] ${data.message}`);
  createLogLine(`[ERROR] ${data.message}`, 'error');
});

// Normalize Rust enum status (may be PascalCase "Offline" or object {"Error":"msg"})
function normalizeStatus(status) {
  if (typeof status === 'string') return status.toLowerCase();
  if (typeof status === 'object' && status !== null) return Object.keys(status)[0].toLowerCase();
  return 'offline';
}

// Show a message in the chat area (activates chat mode if needed)
function showInChat(text, source = 'system') {
  const hero = document.querySelector('.hero-section');
  if (hero && !hero.classList.contains('chat-mode')) {
    hero.classList.add('chat-mode');
  }
  const placeholder = responseArea.querySelector('.logs-placeholder');
  if (placeholder) placeholder.remove();
  createLogLine(text, source);
}

// Wait until process status is 'running' (up to maxWaitMs ms)
async function waitForRunning(maxWaitMs = 15000) {
  const interval = 500;
  const maxAttempts = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const s = await invoke('get_status');
      const st = normalizeStatus(s.status);
      if (st === 'running') return true;
      if (st === 'error') return false;
    } catch (_) {}
  }
  return false;
}

// Chat logic
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  // Renderizar mensagem do usuário na tela
  createLogLine(text, 'user-message');

  chatInput.value = '';
  console.log('[USER] Sent:', text);

  // Gerar ID de sessão se não houver
  if (!currentSessionId) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = text.slice(0, 20).trim().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    currentSessionId = `session_${title}_${ts}`;
  }

  // Auto-minimizar sidebar ao conversar
  if (sidebar && !sidebar.classList.contains('collapsed')) {
    sidebar.classList.add('collapsed');
  }

  // Transition UI to Chat Mode
  const hero = document.querySelector('.hero-section');
  if (hero) hero.classList.add('chat-mode');
  if (responseArea) responseArea.style.display = 'flex';

  // Show thinking indicator
  currentThinkingBubble = createLogLine('Pensando...', 'thinking');

  try {
    await invoke('chat_stream', { input: text });
  } catch (err) {
    if (currentThinkingBubble) { currentThinkingBubble.remove(); currentThinkingBubble = null; }
    showInChat(`Erro: ${err}`, 'stderr');
  }
}

// Input Events
sendBtn?.addEventListener('click', sendMessage);

chatInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Notifications (Simplified for now)
function showNotification(message, type = 'info') {
  const notif = document.createElement('div');
  notif.className = `notification ${type}`;
  notif.textContent = message;
  document.body.appendChild(notif);

  setTimeout(() => {
    notif.remove();
  }, 3000);
}

// Sidebar Interactions
const sidebar = document.getElementById('sidebar');
const mainSidebarToggle = document.getElementById('mainSidebarToggle');
const newSessionBtn = document.getElementById('newSessionBtn');

const toggleSidebar = () => {
  sidebar.classList.toggle('collapsed');
};

mainSidebarToggle?.addEventListener('click', toggleSidebar);

const startNewSession = async () => {
  try {
    // Salva a atual antes de limpar
    if (currentSessionId) {
      await invoke('save_session', { id: currentSessionId });
    }

    await invoke('clear_chat_history');
    responseArea.innerHTML = '';
    const hero = document.querySelector('.hero-section');
    if (hero) hero.classList.remove('chat-mode');
    if (responseArea) responseArea.style.display = 'none';
    
    lastAssistantBubble = null;
    currentThinkingBubble = null;
    currentSessionId = null; 
    
    await loadSessionsList();
    console.log('[SYSTEM] Memória limpa e nova sessão iniciada');
  } catch (err) {
    console.error('[ERROR] Falha ao limpar histórico:', err);
  }
};

newSessionBtn?.addEventListener('click', startNewSession);

// Initialization
(async () => {
    try {
        await invoke('get_config');
        await loadSessionsList(); // Carregar sessões ao iniciar
        
        const savedProvider = localStorage.getItem('openclaude_provider');
        if (savedProvider) {
          const { name, model } = JSON.parse(savedProvider);
          updateModelLabel(name, model);
        }
    } catch (err) {
        console.warn('Config not loaded:', err);
    } finally {
        // Remover Splash Screen com fade-out suave
        setTimeout(() => {
          const loader = document.getElementById('app-loading');
          if (loader) {
            loader.classList.add('fade-out');
            document.body.classList.add('ready'); // Revelar o resto do app
            // Remover do DOM após a animação
            setTimeout(() => loader.remove(), 600);
          }
        }, 800); // 800ms de "respiro" para o app estabilizar
    }
})();