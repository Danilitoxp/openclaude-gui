import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, confirm as tauriConfirm } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
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
const attachmentPreviews = document.getElementById('attachmentPreviews');
const modelSelector = document.querySelector('.model-selector');

// Estado de Anexos
let currentAttachments = [];
let isGenerating = false;
let currentToolUses = []; // acumula ferramentas usadas durante geração
const toolCardMap = new Map(); // tool_use_id → card DOM element (para injetar output)
let lastToolCard = null; // referência ao último card exibido (para remover no próximo)

// ── Modo de execução ────────────────────────────────────────
// 'auto'  → --dangerously-skip-permissions (executa tudo)
// 'ask'   → comportamento padrão do CLI (pergunta antes de ações)
// 'plan'  → injeta instrução para só planejar, sem executar
const MODES = {
  auto: { icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>', label: 'Auto', desc: 'Executa tudo sem pedir' },
  ask: { icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>', label: 'Perguntar', desc: 'Confirma antes de cada ação' },
  plan: { icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>', label: 'Planejar', desc: 'Só descreve, não executa' },
};
let currentMode = localStorage.getItem('openclaude_mode') || 'auto';

// Price map for cost calculation (prices per 1M tokens)
const MODEL_PRICES = {
  'gpt-4o': { in: 5, out: 15 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'claude-3-5-sonnet-20240620': { in: 3, out: 15 },
  'claude-3-5-sonnet-20241022': { in: 3, out: 15 },
  'claude-3-5-sonnet-latest': { in: 3, out: 15 },
  'claude-3-5-haiku-20241022': { in: 0.8, out: 4 },
  'claude-3-haiku-20240307': { in: 0.25, out: 1.25 },
  'o1-preview': { in: 15, out: 60 },
  'o1-mini': { in: 3, out: 12 },
  'gemini-1.5-pro': { in: 3.5, out: 10.5 },
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },
  'qwen/qwen3.5-flash-02-23': { in: 0.10, out: 0.10 }, // Estimate for flash models
  'deepseek-chat': { in: 0.14, out: 0.28 },
};

function getLivingModel() {
  const saved = localStorage.getItem('openclaude_provider');
  if (saved) {
    try {
      const p = JSON.parse(saved);
      return p.model || '';
    } catch (e) { }
  }
  return '';
}

function calculateCost(model, inTok, outTok) {
  let p = MODEL_PRICES[model];
  if (!p) {
    // Try fuzzy match
    const key = Object.keys(MODEL_PRICES).find(k => model.includes(k));
    p = key ? MODEL_PRICES[key] : { in: 1, out: 1 }; // Fallback minimal
  }
  const cost = (inTok / 1000000 * p.in) + (outTok / 1000000 * p.out);
  return cost;
}

// ── Project selector ─────────────────────────────────────────
let currentProjectPath = null; // pasta ativa para a sessão atual

function setProject(path) {
  currentProjectPath = path;
  const badge = document.getElementById('projectBadge');
  const label = document.getElementById('projectBadgeLabel');
  const btn = document.getElementById('projectBtn');

  if (path) {
    // Mostra só o nome da pasta (último segmento) + path completo no title
    const folderName = path.replace(/\\/g, '/').split('/').pop() || path;
    if (label) label.textContent = folderName;
    if (label) label.title = path;
    if (badge) {
      badge.style.display = 'flex';
      badge.classList.add('has-folder');
    }
    if (btn) btn.classList.add('has-project');
  } else {
    if (badge) {
      badge.style.display = 'none';
      badge.classList.remove('has-folder');
    }
    if (btn) btn.classList.remove('has-project');
  }
  syncProviderWithCLI();
}

document.getElementById('projectBtn')?.addEventListener('click', async () => {
  try {
    const selected = await open({ directory: true, multiple: false, title: 'Selecionar pasta do projeto' });
    if (selected) setProject(selected);
  } catch (e) {
    console.error('[PROJECT] Erro ao selecionar pasta:', e);
  }
});

document.getElementById('projectClearBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  setProject(null);
});

function applyMode(mode) {
  currentMode = mode;
  localStorage.setItem('openclaude_mode', mode);
  const cfg = MODES[mode];
  const btn = document.getElementById('modeBtn');
  if (!btn) return;
  btn.dataset.mode = mode;

  const iconEl = btn.querySelector('.mode-icon');
  if (iconEl) iconEl.innerHTML = cfg.icon;

  const labelEl = btn.querySelector('.mode-label');
  if (labelEl) labelEl.textContent = cfg.label;
  // Marca a opção ativa no tooltip
  document.querySelectorAll('.mode-option').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
}

document.getElementById('modeBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('modeTooltip')?.classList.toggle('open');
});

document.querySelectorAll('.mode-option').forEach(el => {
  // Injeta o novo SVG na opção, substituindo qualquer emoji hardcoded que tenha ficado no HTML
  const modeKey = el.dataset.mode;
  if (MODES[modeKey]) {
    const iconContainer = el.querySelector('.opt-icon');
    if (iconContainer) iconContainer.innerHTML = MODES[modeKey].icon;
  }

  el.addEventListener('click', () => {
    applyMode(el.dataset.mode);
    document.getElementById('modeTooltip')?.classList.remove('open');
  });
});

document.addEventListener('click', () => {
  document.getElementById('modeTooltip')?.classList.remove('open');
});

// Inicializa o modo salvo
applyMode(currentMode);

// Window Controls
minimizeBtn?.addEventListener('click', () => appWindow.minimize());
maximizeBtn?.addEventListener('click', () => appWindow.toggleMaximize());
closeBtn?.addEventListener('click', () => appWindow.close());

// Global State
let currentSessionId = null;
let currentThinkingBubble = null;
let lastAssistantBubble = null;
let currentAssistantText = ''; // Buffer para texto do turno atual
const recentList = document.querySelector('.recent-list');

// ── Configuração do Markdown ────────────────────────────────────
if (window.marked) {
  marked.setOptions({ breaks: true });
}

// ── Toast minimalista ───────────────────────────────────────────
function showToast(message, variant = 'info', duration = 4000) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.textContent = message;
  container.appendChild(toast);
  // trigger transition
  requestAnimationFrame(() => toast.classList.add('visible'));
  const remove = () => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };
  setTimeout(remove, duration);
  toast.addEventListener('click', remove);
}

// Normaliza markdown produzido por modelos menores que esquecem quebras de linha
// antes de headings e listas (ex.: "completo:## Comandos" vira "completo:\n\n## Comandos").
function normalizeMarkdown(text) {
  if (!text) return text;
  // Não toca em blocos de código
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) continue; // bloco de código
    let s = parts[i];
    // Insere duas quebras antes de #, ##, ###... quando grudados em outro texto
    s = s.replace(/([^\n])(#{1,6}\s)/g, '$1\n\n$2');
    // Insere quebra antes de item de lista "- " ou "* " quando grudado
    s = s.replace(/([^\n\s])(\s)(-\s|\*\s)(?=[A-Za-z0-9\u00C0-\u017F])/g, '$1\n$3');
    // Insere quebra antes de itens numerados "1. ", "2. " grudados
    s = s.replace(/([^\n])\s(\d+\.\s)(?=[A-Za-z\u00C0-\u017F])/g, '$1\n$2');
    parts[i] = s;
  }
  return parts.join('');
}

// Renderiza markdown e aplica syntax highlighting nos code blocks
function renderMarkdown(text) {
  if (!window.marked || !text) return text || '';
  try {
    const normalized = normalizeMarkdown(text);
    const html = marked.parse(normalized);

    // Syntax highlighting será aplicado no final ou via MutationObserver se necessário,
    // mas aqui retornaremos o HTML puro processado pelo marked.
    return html;
  } catch (e) {
    console.error('Markdown error:', e);
    return text;
  }
}

// Aplica Highlight.js em um elemento
function applyHighlighting(el) {
  if (window.hljs) {
    el.querySelectorAll('pre code').forEach(block => {
      if (!block.dataset.highlighted) {
        hljs.highlightElement(block);
        block.dataset.highlighted = "true";
      }
    });
  }
}

// ── Provider Modal ──────────────────────────────────────────────
const providerModal = document.getElementById('providerModal');
const cancelProvider = document.getElementById('cancelProvider');
const activateProvider = document.getElementById('activateProvider');
const providerDropdown = document.getElementById('providerDropdown');
const dropdownSelected = document.getElementById('dropdownSelected');
const dropdownOptions = document.getElementById('dropdownOptions');

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', icon: '🔮', model: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com', requiresKey: true, envKey: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', icon: '🤖', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', requiresKey: true, envKey: 'OPENAI_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', icon: '🔀', model: 'anthropic/claude-3.5-sonnet', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true, envKey: 'OPENROUTER_API_KEY' },
  { id: 'gemini', name: 'Gemini', icon: '✨', model: 'gemini-1.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresKey: true, envKey: 'GEMINI_API_KEY' },
  { id: 'groq', name: 'Groq', icon: '⚡', model: 'llama-3.1-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1', requiresKey: true, envKey: 'GROQ_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', icon: '🌊', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', requiresKey: true, envKey: 'DEEPSEEK_API_KEY' },
  { id: 'mistral', name: 'Mistral', icon: '🌪️', model: 'mistral-large-latest', baseUrl: 'https://api.mistral.ai/v1', requiresKey: true, envKey: 'MISTRAL_API_KEY' },
  { id: 'moonshotai', name: 'Moonshot AI', icon: '🌙', model: 'moonshot-v1-32k', baseUrl: 'https://api.moonshot.ai/v1', requiresKey: true, envKey: 'MOONSHOT_API_KEY' },
  { id: 'together', name: 'Together AI', icon: '🤝', model: 'meta-llama/Llama-3.1-70b-instruct', baseUrl: 'https://api.together.xyz/v1', requiresKey: true, envKey: 'TOGETHER_API_KEY' },
  { id: 'azure', name: 'Azure OpenAI', icon: '☁️', model: '', baseUrl: '', requiresKey: true, envKey: 'AZURE_OPENAI_API_KEY' },
  { id: 'ollama', name: 'Ollama', icon: '🦙', model: 'llama3.1:8b', baseUrl: 'http://localhost:11434/v1', requiresKey: false, envKey: '' },
  { id: 'lmstudio', name: 'LM Studio', icon: '🖥️', model: 'local-model', baseUrl: 'http://localhost:1234/v1', requiresKey: false, envKey: '' },
  { id: 'custom', name: 'Custom', icon: '⚙️', model: '', baseUrl: '', requiresKey: false, envKey: 'OPENAI_API_KEY' },
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

async function openProviderModal() {
  providerModal.classList.add('open');
  showListView();
}

function showListView() {
  profilesView.style.display = 'block';
  formView.style.display = 'none';
  refreshProfiles();
}

function showFormView(clearForm = false) {
  profilesView.style.display = 'none';
  formView.style.display = 'block';
  if (clearForm) {
    document.getElementById('pfName').value = '';
    document.getElementById('pfBaseUrl').value = '';
    document.getElementById('pfModel').value = '';
    document.getElementById('pfApiKey').value = '';
    selectedProvider = PROVIDERS.find(p => p.id === 'openai');
    dropdownSelected.textContent = selectedProvider.name;
    renderProviderOptions();
  }
}

btnNewProfile?.addEventListener('click', () => showFormView(true));
btnBackToList?.addEventListener('click', () => showListView());

async function refreshProfiles() {
  const list = document.getElementById('profilesList');
  if (!list) return;

  try {
    const config = await invoke('get_global_config');
    const profiles = config.providerProfiles || [];
    const activeId = config.activeProviderProfileId;

    if (profiles.length === 0) {
      list.innerHTML = `
        <div class="profiles-empty">
          Nenhum perfil salvo no OpenClaude.<br>
          <span style="font-size: 10px; opacity: 0.5; margin-top: 8px; display: block;">Clique em "+ Novo Perfil" para começar.</span>
        </div>
      `;
      return;
    }

    list.innerHTML = '';
    profiles.forEach(p => {
      const card = document.createElement('div');
      card.className = `profile-card ${p.id === activeId ? 'active' : ''}`;

      const info = document.createElement('div');
      info.className = 'profile-info';
      info.innerHTML = `
        <div class="profile-name">${p.name} ${p.id === activeId ? ' <span style="color:#d86940; font-size:10px;">(ativo)</span>' : ''}</div>
        <div class="profile-details">${p.provider} | ${p.model}</div>
      `;

      card.onclick = () => {
        selectExistingProfile(p);
        showFormView(false); // Abre o form preenchido para edição/ativação
      };

      const actions = document.createElement('div');
      actions.className = 'profile-actions';

      const delBtn = document.createElement('button');
      delBtn.className = 'btn-icon-danger';
      delBtn.title = 'Excluir perfil';
      delBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      `;
      delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (confirm(`Excluir o perfil "${p.name}"?`)) {
          await invoke('delete_global_profile', { id: p.id });
          refreshProfiles();
        }
      };

      actions.appendChild(delBtn);
      card.appendChild(info);
      card.appendChild(actions);
      list.appendChild(card);
    });
  } catch (e) {
    list.innerHTML = `<div class="profiles-empty">Erro ao carregar perfis: ${e}</div>`;
  }
}

function selectExistingProfile(p) {
  document.getElementById('pfName').value = p.name || '';
  document.getElementById('pfBaseUrl').value = p.baseUrl || '';
  document.getElementById('pfModel').value = p.model || '';
  document.getElementById('pfApiKey').value = p.apiKey || '';

  // Tenta mapear o provider fixo
  const matched = PROVIDERS.find(prov => prov.id.toLowerCase() === p.provider.toLowerCase() || prov.name.toLowerCase() === p.provider.toLowerCase());
  if (matched) {
    selectedProvider = matched;
    dropdownSelected.textContent = matched.name;
  } else {
    selectedProvider = PROVIDERS.find(prov => prov.id === 'custom');
    dropdownSelected.textContent = 'Custom';
  }
  renderProviderOptions();
}

async function syncProviderWithCLI() {
  // Chamado no início do app para carregar o label, não precisa mexer no modal
  try {
    const cliEnv = await invoke('get_cli_env', { projectDir: currentProjectPath || null });
    const v = cliEnv.vars || {};
    if (cliEnv.exists) {
      let bestMatch = null;
      for (const p of PROVIDERS) {
        if (p.envKey && v[p.envKey]) {
          bestMatch = p;
          break;
        }
      }
      if (!bestMatch && cliEnv.baseUrl) {
        bestMatch = PROVIDERS.find(p => cliEnv.baseUrl.includes(p.id)) ||
          PROVIDERS.find(p => p.baseUrl && cliEnv.baseUrl.startsWith(p.baseUrl));
      }
      if (bestMatch) {
        updateModelLabel(bestMatch.name, cliEnv.model || bestMatch.model);
      }
    }
  } catch (e) { }
}

function closeModal() {
  providerModal.classList.remove('open');
}

modelSelector?.addEventListener('click', openProviderModal);
cancelProvider?.addEventListener('click', closeModal);

providerModal?.addEventListener('click', (e) => {
  if (e.target === providerModal) closeModal();
});

activateProvider?.addEventListener('click', async () => {
  const name = document.getElementById('pfName').value.trim();
  const baseUrl = document.getElementById('pfBaseUrl').value.trim();
  const model = document.getElementById('pfModel').value.trim();
  const apiKey = document.getElementById('pfApiKey').value.trim();

  if (!name || !baseUrl || !model) {
    showNotification('Preencha Nome, Base URL e Modelo.', 'error');
    return;
  }

  const vars = {
    'OPENAI_BASE_URL': baseUrl,
    'OPENAI_MODEL': model
  };

  const p = selectedProvider || PROVIDERS.find(p => p.id === 'custom');
  if (p.envKey) {
    vars[p.envKey] = apiKey;
  } else {
    vars['OPENAI_API_KEY'] = apiKey;
  }

  const providerId = p.id;
  vars['OPENCLAUDE_PROVIDER'] = (providerId === 'anthropic' || providerId === 'gemini' || providerId === 'ollama') ? providerId : 'openai';

  localStorage.setItem('openclaude_provider', JSON.stringify({ name, model }));
  localStorage.setItem('openclaude_provider_full', JSON.stringify({ id: p.id, name, baseUrl, model, apiKey }));

  updateModelLabel(name, model);

  try {
    await invoke('save_env_config', { projectDir: currentProjectPath || null, vars });
    await invoke('save_global_profile', {
      name: name,
      baseUrl: baseUrl,
      apiKey: apiKey,
      model: model,
      providerId: p.id
    });
    showNotification(`Provedor "${name}" ativado e sincronizado!`, 'success');
    closeModal();
  } catch (e) {
    showNotification(`Erro ao salvar: ${e}`, 'error');
  }
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
          const confirmed = await tauriConfirm(`Excluir a conversa "${readable}"?`, { title: 'Excluir conversa', kind: 'warning' });
          if (confirmed) {
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

// Listen for log events (keeping background active)
const responseArea = document.getElementById('responseArea');

const selectSession = async (id) => {
  try {
    // No interval to clear anymore
    const messages = await invoke('load_session', { id });
    currentSessionId = id;
    // Ao carregar uma sessão salva, não continuamos a sessão CLI anterior
    window._continueSession = false;

    responseArea.innerHTML = '';
    const hero = document.querySelector('.hero-section');
    if (hero) hero.classList.add('chat-mode');
    if (responseArea) responseArea.style.display = 'flex';

    messages.forEach(msg => {
      const type = msg.role === 'user' ? 'user-message' : 'stdout';
      lastAssistantBubble = null;

      let textContent = msg.content;
      if (Array.isArray(textContent)) {
        // Extrapola apenas o texto de arrays multimodais para o histórico
        const textObj = textContent.find(c => c.type === 'text');
        textContent = textObj ? textObj.text : '[Imagem Anexada]';
      }

      const line = document.createElement('div');
      line.className = `log-line ${type}`;

      const content = document.createElement('div');
      content.className = 'content';

      if (type === 'stdout') {
        // Mensagem do assistente - renderiza com markdown e highlighting
        const icon = document.createElement('img');
        icon.src = '/src/assets/loading.svg';
        icon.className = 'assistant-icon';
        line.appendChild(icon);

        const cleanText = textContent.replace(/^\[API RESPONSE\]\s*/, '').replace(/^\[API\]\s*/, '').trim();
        content.innerHTML = renderMarkdown(cleanText);
        applyHighlighting(content);
        lastAssistantBubble = line;
      } else if (type === 'user-message') {
        // Mensagem do usuário
        const messageText = document.createElement('div');
        messageText.textContent = textContent.replace(/^\[USER\]\s*/, '').trim();
        content.appendChild(messageText);
      }

      line.appendChild(content);
      responseArea.appendChild(line);
    });

    await loadSessionsList();
    if (sidebar && !sidebar.classList.contains('collapsed')) sidebar.classList.add('collapsed');
  } catch (err) {
    console.error('[ERROR] Falha ao carregar sessão:', err);
  }
};

const createLogLine = (text, type) => {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;

  const content = document.createElement('div');
  content.className = 'content';

  if (type === 'stdout' || type === 'api-response' || type === 'thinking') {
    // Adiciona o ícone do assistente (loading.svg para estados ativos)
    const icon = document.createElement('img');
    const isThinking = type === 'thinking';
    icon.src = '/src/assets/loading.svg'; // Usa o ícone solicitado pelo usuário
    icon.className = 'assistant-icon' + (isThinking ? ' spinning' : '');
    line.appendChild(icon);

    if (type === 'thinking') {
      content.innerHTML = `
        <div class="thinking-header">
          <div class="thinking-text">Pensando</div>
          <span class="live-timer">0s</span>
        </div>
        <div class="thinking-activity-area"></div>
        <div class="thinking-live-stats">
          <span class="live-tokens" style="display:none;"></span>
          <span class="live-cost" style="display:none; color: #666; font-family: monospace; font-size: 0.85em; margin-left: 8px;"></span>
        </div>
      `;
    } else {
      const cleanText = text.replace(/^\[API RESPONSE\]\s*/, '').replace(/^\[API\]\s*/, '').trim();
      content.innerHTML = renderMarkdown(cleanText);
      applyHighlighting(content);
    }

    if (type === 'stdout' || type === 'api-response') {
      lastAssistantBubble = line;
    }
  } else if (type === 'user-message') {
    const messageText = document.createElement('div');
    messageText.textContent = text.replace(/^\[USER\]\s*/, '').trim();

    if (window._currentSendingAttachments) {
      window._currentSendingAttachments.forEach(at => {
        if (at.isImage && at.data) {
          const img = document.createElement('img');
          img.src = at.data;
          img.style.maxWidth = '250px';
          img.style.borderRadius = '8px';
          img.style.marginBottom = '12px';
          img.style.display = 'block';
          content.appendChild(img);
        }
      });
    }

    content.appendChild(messageText);
  } else {
    content.textContent = text;
  }

  line.appendChild(content);
  responseArea.appendChild(line);
  responseArea.scrollTo({ top: responseArea.scrollHeight, behavior: 'smooth' });

  return line;
};

const updateBubbleContent = (bubble, text) => {
  if (!bubble) return;
  const content = bubble.querySelector('.content');
  if (content) {
    const cleanText = text.replace(/^\[API RESPONSE\]\s*/, '').replace(/^\[API\]\s*/, '').trim();
    content.innerHTML = renderMarkdown(cleanText);
    applyHighlighting(content);
  }
};

// Atualiza o botão Enviar -> Parar
function setGenerationState(generating) {
  isGenerating = generating;
  if (generating) {
    sendBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    `;
    sendBtn.classList.add('stop-mode');
    sendBtn.title = "Parar geração";
  } else {
    sendBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2a150e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    `;
    sendBtn.classList.remove('stop-mode');
    sendBtn.title = "Enviar prompt";
  }
}

listen('log-update', async (event) => {
  const data = event.payload;
  console.log(`[LOG-UPDATE] source=${data.source} | msg(${(data.message || '').length}c)=`, (data.message || '').slice(0, 300));

  // Helpers: ativa o chat mode e sincroniza estado do thinking
  const ensureChatMode = () => {
    const hero = document.querySelector('.hero-section');
    if (hero && !hero.classList.contains('chat-mode')) hero.classList.add('chat-mode');
    const placeholder = responseArea.querySelector('.logs-placeholder');
    if (placeholder) placeholder.remove();
  };

  const updateThinkingState = (title, subtext, labelData = null) => {
    if (!currentThinkingBubble) {
      currentThinkingBubble = createLogLine('Processando...', 'thinking');
    }

    if (title) {
      const titleEl = currentThinkingBubble.querySelector('.thinking-text');
      if (titleEl) titleEl.textContent = title;
    }

    const activityArea = currentThinkingBubble.querySelector('.thinking-activity-area');
    if (!activityArea) return;

    if (labelData) {
      // Substitui o status anterior por um label rico
      activityArea.innerHTML = `
        <div class="tool-use-row live">
          <div class="tool-use-header">
            <span class="tool-name">${labelData.name}</span>
            <span class="tool-pill" title="${escapeHtml(String(labelData.val))}">${escapeHtml(String(labelData.val))}</span>
          </div>
        </div>
      `;
    } else if (subtext !== undefined && subtext) {
      // Substitui o status por texto simples
      activityArea.innerHTML = `<span class="thinking-activity-line">${subtext}</span>`;
    } else if (subtext === '') {
      activityArea.innerHTML = '';
    }
  };

  // 'done' = fim da resposta streaming -> Salva a conversa
  if (data.source === 'done') {
    console.log('[STREAM-COMPLETE] Streaming finalizado com sucesso');
    setGenerationState(false);
    if (window._thinkingTimer) { clearInterval(window._thinkingTimer); window._thinkingTimer = null; }

    // Para a animação do ícone ao finalizar
    if (lastAssistantBubble) {
      const icon = lastAssistantBubble.querySelector('.assistant-icon');
      if (icon) {
        icon.classList.remove('spinning');
      }
    }

    // Se o processo terminou prematuramente sem enviar resposta (mas deixou erro)
    if (!lastAssistantBubble && currentThinkingBubble) {
      const errData = currentThinkingBubble.dataset.lastError;
      if (errData && errData.trim()) {
        console.error('[ERROR-DATA]', errData);
        createLogLine(`⚠️ O processo falhou:\n${errData.trim()}`, 'stderr');
      } else {
        console.warn('[WARNING] Agente encerrou subitamente sem resposta');
        createLogLine(`⚠️ O agente encerrou a execução subitamente sem enviar resposta.`, 'stderr');
      }
    }

    if (currentThinkingBubble) {
      currentThinkingBubble.remove();
      currentThinkingBubble = null;
    }

    if (currentSessionId) {
      await invoke('save_session', { id: currentSessionId });
      await loadSessionsList();
    }
    return;
  }

  // Filtre apenas se não houver payload relevante
  if (!data.message && data.source !== 'system' && !data.id) return;

  // ── Labels amigáveis para tool use em PT-BR ──
  const toolLabels = {
    'Read': (inp) => ({ name: 'Lendo', val: inp.file_path || inp.path || '', sub: 'Arquivo' }),
    'Write': (inp) => ({ name: 'Criando', val: inp.file_path || '', sub: 'Arquivo' }),
    'Edit': (inp) => ({ name: 'Editando', val: inp.file_path || '', sub: 'Arquivo' }),
    'Bash': (inp) => { const c = inp.command || ''; return { name: 'Executando', val: c.length > 100 ? c.slice(0, 100) + '…' : c, sub: 'Comando terminal' }; },
    'Glob': (inp) => ({ name: 'Buscando', val: inp.pattern || '', sub: 'Arquivos no workspace' }),
    'Grep': (inp) => ({ name: 'Pesquisando', val: inp.pattern || '', sub: 'Conteúdo nos arquivos' }),
    'Agent': (inp) => ({ name: 'Subagente', val: (inp.description || inp.prompt || '').slice(0, 50) + '…', sub: 'Delegando tarefa' }),
    'TodoWrite': (_) => ({ name: 'Tarefas', val: 'atualizando lista', sub: 'Pendências' }),
    'WebFetch': (inp) => ({ name: 'Web', val: (inp.url || '').slice(0, 60), sub: 'Buscando conteúdo' }),
    'WebSearch': (inp) => ({ name: 'Pesquisa', val: inp.query || '', sub: 'Buscando na web' }),
    'NotebookEdit': (_) => ({ name: 'Notebook', val: 'editando', sub: 'Jupyter' }),
    'Skill': (inp) => ({ name: 'Skill', val: inp.skill || '', sub: 'Executando skill' }),
  };

  // ── Processa stdout (stream-json): cada chunk pode ter múltiplas linhas JSON ──
  if (data.source === 'stdout') {
    window._lastActivityTime = Date.now(); // Registra atividade para o indicador de inatividade
    console.log(`[STDOUT] Recebido ${data.message.length} caracteres`);
    // Buffer de linhas incompletas entre chunks
    window._stdoutLineBuf = (window._stdoutLineBuf || '') + data.message;
    const lines = window._stdoutLineBuf.split('\n');
    // Última parte pode ser incompleta — preserva no buffer
    window._stdoutLineBuf = lines.pop() || '';
    console.log(`[STDOUT] Processando ${lines.length} linhas | Buffer: ${window._stdoutLineBuf.length} caracteres`);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // Tenta parsear como JSON (stream-json)
      let evt;
      try { evt = JSON.parse(line); } catch (parseErr) {
        console.warn(`[STDOUT-PARSE] Linha NÃO é JSON (modo texto puro): "${line.slice(0, 150)}"`);
        // Não é JSON → modo texto puro (fallback para --print sem stream-json)
        if (lastAssistantBubble) {
          currentAssistantText += (currentAssistantText ? '\n' : '') + line;
          updateBubbleContent(lastAssistantBubble, currentAssistantText);
          // Yield: efeito de streaming linha a linha
          await new Promise(r => requestAnimationFrame(r));
        } else {
          // Mensagens internas do CLI ([context], deprecation, etc.) — mostra como info de progresso
          if (line.includes('[context]')) {
             updateThinkingState(null, line);
             continue;
          }

          ensureChatMode();
          if (currentThinkingBubble) {
            currentThinkingBubble.remove();
            currentThinkingBubble = null;
          }
          currentAssistantText = line;
          lastAssistantBubble = createLogLine(currentAssistantText, 'stdout');
          // Yield: mostra a primeira linha antes de continuar
          await new Promise(r => requestAnimationFrame(r));
        }
        continue;
      }

      // ── Evento JSON parseado com sucesso ──
      const evtType = evt.type;
      const evtSub = evt.subtype;
      console.log(`[JSON-EVENT] type=${evtType} subtype=${evtSub || '-'} keys=[${Object.keys(evt).join(',')}]`);



      // system/init — mostra modelo sendo usado e sincroniza label da UI
      if (evtType === 'system' && evtSub === 'init') {
        const activeModel = evt.model || '';
        const activeProvider = evt.provider || '';
        if (activeModel && activeProvider) {
          updateModelLabel(activeProvider, activeModel);
        }
        updateThinkingState('Conectando', `Aguardando ${activeModel || 'resposta'}...`);
        continue;
      }

      // system/thinking — feedback visual do agente agindo
      if (evtType === 'system' && evtSub === 'thinking') {
        const title = evt.title || 'Processando';
        const msg = evt.message || evt.subtext || '';
        updateThinkingState(title, msg);
        continue;
      }

      // system/task_progress ou task_started — feedback detalhado do CLI (subtítulo)
      if (evtType === 'system' && (evtSub === 'task_progress' || evtSub === 'task_started')) {
        const desc = evt.description || '';
        if (desc) {
          updateThinkingState('Trabalhando', desc);
        }
        continue;
      }

      // system/api_retry — mostra info de retry
      if (evtType === 'system' && evtSub === 'api_retry') {
        updateThinkingState('Reconectando', `⏳ tentativa ${evt.attempt || '?'}/${evt.max_retries || '?'}`);
        if (evt.error && currentThinkingBubble) {
          currentThinkingBubble.dataset.lastError =
            (currentThinkingBubble.dataset.lastError || '') + `API ${evt.error_status || ''}: ${evt.error}\n`;
        }
        continue;
      }

      // assistant — mensagem do assistente com content blocks
      // Formato SDK: {type:"assistant", message:{content:[...], usage:{input_tokens, output_tokens}}}
      if (evtType === 'assistant' && evt.message?.content) {
        console.log(`[ASSISTANT-BLOCKS] total=${(evt.message.content || []).length} types=[${(evt.message.content || []).map(b => b.type).join(',')}]`);
        // Acumula tokens em tempo real
        const u = evt.message.usage;
        if (u && window._liveTokens) {
          window._liveTokens.in += u.input_tokens || u.prompt_tokens || 0;
          window._liveTokens.out += u.output_tokens || u.completion_tokens || 0;
        }

        const blocks = Array.isArray(evt.message.content) ? evt.message.content : [];

        for (const block of blocks) {
          if (block.type === 'tool_use') {
            const toolName = block.name || '';
            const toolInput = block.input || {};
            const labelFn = toolLabels[toolName];
            const labelObj = labelFn ? labelFn(toolInput) : { name: toolName, val: '...', sub: '' };

            currentToolUses.push({ name: toolName, input: toolInput, label: labelObj, id: block.id });

            // Em vez de ocupar a tela com cards gigantes durante o thinking,
            // mostramos a atividade em tempo real no bubble de pensamento.
            ensureChatMode();
            updateThinkingState('Trabalhando', null, labelObj);
            
            // Pequeno delay visual para fluidez
            await new Promise(r => requestAnimationFrame(r));
          }

          if (block.type === 'text' && block.text) {
            ensureChatMode();
            if (currentThinkingBubble) {
              currentThinkingBubble.remove();
              currentThinkingBubble = null;
            }
            // Remove o último card de ferramenta ao começar a falar
            if (lastToolCard) {
              lastToolCard.remove();
              lastToolCard = null;
            }

            // Animação word-by-word: simula streaming de tokens em tempo real
            // Divide em tokens (palavras + espaços/pontuação) para efeito natural
            const tokens = block.text.match(/\S+\s*/g) || [block.text];
            const DELAY_MS = 18; // ms entre batches
            // Batch adaptativo: mantém animação em ~1.5s independente do tamanho
            const BATCH = Math.max(1, Math.ceil(tokens.length / 80));
            for (let i = 0; i < tokens.length; i += BATCH) {
              currentAssistantText += tokens.slice(i, i + BATCH).join('');
              if (lastAssistantBubble) {
                updateBubbleContent(lastAssistantBubble, currentAssistantText);
              } else {
                lastAssistantBubble = createLogLine(currentAssistantText, 'stdout');
              }
              responseArea.scrollTo({ top: responseArea.scrollHeight, behavior: 'smooth' });
              await new Promise(r => setTimeout(r, DELAY_MS));
            }
          }
        }
        continue;
      }

      // tool — resultado de uma ferramenta {type:"tool", tool_use_id:"...", content:[...]}
      if (evtType === 'tool') {
        const toolUseId = evt.tool_use_id || '';
        const content = Array.isArray(evt.content) ? evt.content : [];
        const outputText = content
          .filter(c => c.type === 'text')
          .map(c => c.text || '')
          .join('\n')
          .trim();

        const tUse = currentToolUses.find(t => t.id === toolUseId);
        if (tUse) tUse.output = outputText;

        if (toolCardMap.has(toolUseId)) {
          const card = toolCardMap.get(toolUseId);
          card.classList.add('completed');

          if (outputText) {
            // Adiciona seção de output ao card existente
            const outSection = document.createElement('div');
            outSection.className = 'tool-output';
            const outPre = document.createElement('pre');
            outPre.className = 'tool-output-pre';
            outPre.textContent = outputText.length > 2000
              ? outputText.slice(0, 2000) + '\n… (truncado)'
              : outputText;
            outSection.appendChild(outPre);
            card.appendChild(outSection);
          }
          responseArea.scrollTo({ top: responseArea.scrollHeight, behavior: 'smooth' });
          // Pausa: mostra o resultado da ferramenta por um momento
          await new Promise(r => setTimeout(r, 100));
        }
        toolCardMap.delete(toolUseId);
        continue;
      }

      // result — resposta final {type:"result", subtype:"success", result:"...", duration_ms, total_cost_usd, usage}
      if (evtType === 'result') {
        const resultText = evt.result || '';

        // Renderiza sumário colapsável apenas para ferramentas SEM card inline
        // (Write/Edit/Bash já aparecem como cards — só mostra Read/Glob/Grep/etc.)
        const INLINE_TOOLS = new Set(['Write', 'Edit', 'Bash']);
        const silentTools = currentToolUses.filter(t => !INLINE_TOOLS.has(t.name));
        if (silentTools.length > 0) {
          if (currentThinkingBubble) {
            currentThinkingBubble.remove();
            currentThinkingBubble = null;
          }
          // Remove o último card de ferramenta ao finalizar o ciclo
          if (lastToolCard) {
            lastToolCard.remove();
            lastToolCard = null;
          }
          ensureChatMode();
          const toolBlock = renderToolUseBlock(silentTools);
          if (toolBlock) responseArea.appendChild(toolBlock);
        }
        currentToolUses = [];

        if (resultText) {
          if (currentThinkingBubble) {
            currentThinkingBubble.remove();
            currentThinkingBubble = null;
          }
          ensureChatMode();

          // Sempre prioriza o resultText final se ele existir
          if (lastAssistantBubble) {
            updateBubbleContent(lastAssistantBubble, resultText);
          } else {
            createLogLine(resultText, 'stdout');
          }
        }
        // Mostra barra de stats (tokens, tempo, custo) abaixo da resposta
        if (lastAssistantBubble) {
          const statsBar = document.createElement('div');
          statsBar.className = 'response-stats';

          const totalSec = evt.duration_ms ? evt.duration_ms / 1000 : 0;
          let duration = null;
          if (totalSec >= 60) {
            const m = Math.floor(totalSec / 60);
            const s = Math.floor(totalSec % 60);
            duration = `${m}m${s}s`;
          } else if (totalSec > 0) {
            duration = totalSec.toFixed(1) + 's';
          }
          const cost = evt.total_cost_usd != null && evt.total_cost_usd > 0 ? '$' + evt.total_cost_usd.toFixed(4) : null;
          const turns = evt.num_turns || null;

          // Soma tokens de todos os modelos usados (SDK usa camelCase em modelUsage)
          let inTok = 0, outTok = 0;
          if (evt.modelUsage && typeof evt.modelUsage === 'object') {
            for (const m of Object.values(evt.modelUsage)) {
              inTok += m.inputTokens || 0;
              outTok += m.outputTokens || 0;
            }
          }
          // Fallback: campo usage direto (pode ser snake_case ou camelCase)
          if (!inTok && !outTok && evt.usage) {
            inTok = evt.usage.input_tokens || evt.usage.inputTokens || 0;
            outTok = evt.usage.output_tokens || evt.usage.outputTokens || 0;
          }

          const parts = [];
          if (inTok || outTok)
            parts.push(`<span class="stat-item"><span class="stat-icon">↑</span><span class="stat-value">${inTok.toLocaleString()}</span> <span class="stat-icon">↓</span><span class="stat-value">${outTok.toLocaleString()} tk</span></span>`);
          if (duration)
            parts.push(`<span class="stat-item"><span class="stat-icon">⏱</span><span class="stat-value">${duration}</span></span>`);
          if (cost)
            parts.push(`<span class="stat-item"><span class="stat-icon">💲</span><span class="stat-value">${cost}</span></span>`);
          if (turns && turns > 1)
            parts.push(`<span class="stat-item"><span class="stat-icon">↻</span><span class="stat-value">${turns} turnos</span></span>`);

          if (parts.length > 0) {
            statsBar.innerHTML = parts.join('');
            // Append ao .content (não ao .log-line) para ficar ABAIXO do texto
            const contentEl = lastAssistantBubble.querySelector('.content');
            if (contentEl) {
              contentEl.appendChild(statsBar);
            } else {
              lastAssistantBubble.appendChild(statsBar);
            }
          }
        }

        // Injeta botões de resposta rápida apenas no modo Ask (não no Auto nem no Plan).
        // No modo Plan o agente só descreve ações, então quick replies não fazem sentido:
        // clicar em "ok" re-enviaria com o prefixo de planejamento, fazendo o agente
        // descrever mais um plano ao invés de executar.
        if (lastAssistantBubble && resultText && currentMode === 'ask') {
          injectQuickReplies(lastAssistantBubble, resultText);
        }

        continue;
      }

      // Outros eventos do sistema (ignorar silenciosamente)
    }
    return;
  }

  // ── stderr e system (logs do processo) ──
  if (currentThinkingBubble && (data.source === 'system' || data.source === 'stderr')) {
    window._lastActivityTime = Date.now(); // Registra atividade
    const subtextEl = currentThinkingBubble.querySelector('.thinking-subtext');
    const titleEl = currentThinkingBubble.querySelector('.thinking-text');
    if (subtextEl) {
      currentThinkingBubble.dataset.realLogsReceived = "true";
      subtextEl.style.display = 'inline-block';
      let cleanText = data.message.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '\n');

      if (data.source === 'stderr') {
        // Classifica: warnings benignos não devem virar "Erro no processo".
        // Só marcamos como erro quando há padrões realmente fatais.
        const isFatal = /\b(error|fatal|exception|traceback|panic|enotfound|econnrefused|etimedout|failed|cannot|unable)\b/i.test(cleanText)
          && !/\bwarning\b/i.test(cleanText);
        const isWarning = /\bwarning\b/i.test(cleanText) || /^\s*\[(context|deprecation|warn)\]/i.test(cleanText);

        let buf = (currentThinkingBubble.dataset.stderrBuf || '') + cleanText;
        if (buf.length > 2000) buf = buf.slice(-2000);
        currentThinkingBubble.dataset.stderrBuf = buf;

        if (isFatal) {
          if (titleEl) titleEl.textContent = 'Erro no processo';
          currentThinkingBubble.dataset.lastError = (currentThinkingBubble.dataset.lastError || '') + cleanText;
        } else if (isWarning && titleEl && titleEl.textContent !== 'Erro no processo') {
          titleEl.textContent = 'Processando';
        } else if (titleEl && titleEl.textContent !== 'Erro no processo') {
          titleEl.textContent = 'Processando';
        }

        const lines = buf.split('\n').filter(l => l.trim().length > 0);
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1].trim();
          // Mensagens internas do CLI ([context], etc.) — ignora, mantém subtítulo anterior
          if (/\[context\]/i.test(lastLine) || /not in context window/i.test(lastLine)) {
            // não atualiza o subtítulo
          } else {
            subtextEl.textContent = `└ ${lastLine}`;
          }
          subtextEl.classList.toggle('active', isFatal);
        }
      } else {
        if (titleEl) titleEl.textContent = 'Processando';
        subtextEl.textContent = `└ ${cleanText.replace(/\n/g, ' ').trim()}`;
        subtextEl.classList.add('active');
      }
    }
    return;
  }

  // ── Fallback: texto simples que não é stdout, stderr ou system ──
  const hero = document.querySelector('.hero-section');
  if (hero && !hero.classList.contains('chat-mode')) hero.classList.add('chat-mode');
  const placeholder = responseArea.querySelector('.logs-placeholder');
  if (placeholder) placeholder.remove();

  // Se for stdout/api-response e já tivermos uma bolha de assistente aberta, mesclamos o texto
  // para evitar ícones duplicados e manter a resposta unificada.
  if ((data.source === 'stdout' || data.source === 'api-response') && lastAssistantBubble) {
    currentAssistantText += data.message;
    updateBubbleContent(lastAssistantBubble, currentAssistantText);
  } else {
    createLogLine(data.message, data.source);
  }
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

// ── Quick Replies: detecta opções na resposta do agente ──────
// Padrões de pedido de permissão/aprovação (sem precisar terminar com '?')
const APPROVAL_PATTERNS = [
  /\b(falta|preciso|precisa|necessit[ao])\b.{0,60}\b(aprova[çc][aã]o|permiss[aã]o|autoriza[çc][aã]o)\b/i,
  /\b(libere|conceda|d[eê]|autorize)\b.{0,60}\b(permiss[aã]o|acesso|aprova[çc][aã]o)\b/i,
  /\b(permission|approve|grant access|needs? approval)\b/i,
  /\brequer.{0,40}aprova[çc][aã]o\b/i,
  /\b(aguardo|aguardando)\b.{0,60}\b(permiss[aã]o|aprova[çc][aã]o|confirma[çc][aã]o|escolha|decis[aã]o)\b/i,
  /\b(permita|permite)\b.{0,80}\b(escrev[ae]r?|cri[ae]r?|execut[ae]r?|copi[ae]r?|mov[ae]r?|delet[ae]r?|remov[ae]r?)\b/i,
  /\b(posso|pode[mr]os|vou)\b.{0,80}\b(criar|escrever|executar|copiar|mover|deletar|remover)\b.{0,80}\?/i,
  /\b(sua|tua)\b.{0,30}\b(escolha|decis[aã]o|confirma[çc][aã]o|aprova[çc][aã]o)\b/i,
];

function detectQuickReplies(text) {
  if (!text) return [];
  const trimmed = text.trim();

  // Pedido explícito de permissão/aprovação → Aprovar / Negar
  if (APPROVAL_PATTERNS.some(p => p.test(trimmed))) {
    return ['Sim, pode fazer', 'Não, cancela'];
  }

  // A partir daqui exige terminar com '?'
  if (!trimmed.endsWith('?')) return [];

  // Opções numeradas: "1. xxx" ou "1) xxx"
  const numbered = [...text.matchAll(/^\s*\d+[.)]\s*(.+)$/gm)];
  if (numbered.length >= 2) return numbered.map(m => m[1].trim()).slice(0, 5);

  // Bullet points: "• xxx", "- xxx", "* xxx"
  const bullets = [...text.matchAll(/^\s*[•\-\*]\s+(.+)$/gm)];
  if (bullets.length >= 2) return bullets.map(m => m[1].trim()).slice(0, 5);

  // "Opção X: xxx" em qualquer língua
  const opcoes = [...text.matchAll(/(?:opção|opcion|option)\s+\w+[:\-]\s*(.+)/gi)];
  if (opcoes.length >= 2) return opcoes.map(m => m[1].trim()).slice(0, 5);

  // Pergunta simples → Sim / Não
  if (trimmed.length < 300) return ['Sim', 'Não'];

  return [];
}

// ── Inline tool block: mostra código/comando em tempo real ───
function guessLang(filePath) {
  if (!filePath) return '';
  const ext = filePath.split('.').pop().toLowerCase();
  return {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rs: 'rust', html: 'html', css: 'css', json: 'json',
    md: 'markdown', sh: 'bash', toml: 'toml', yaml: 'yaml', yml: 'yaml'
  }[ext] || '';
}

function createInlineToolBlock(toolName, toolInput) {
  const ICONS = { Write: '📝', Edit: '✏️', Bash: '⚡', Read: '📄' };

  if (toolName === 'Write') {
    const filePath = toolInput.file_path || '';
    const content = toolInput.content || '';
    const lang = guessLang(filePath);
    return buildCodeCard(ICONS.Write, `Criando ${filePath}`, content, lang);
  }

  if (toolName === 'Edit') {
    const filePath = toolInput.file_path || '';
    const oldStr = toolInput.old_string || '';
    const newStr = toolInput.new_string || '';
    return buildDiffCard(filePath, oldStr, newStr);
  }

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    return buildCodeCard(ICONS.Bash, 'Comando Bash', cmd, 'bash');
  }

  return null; // Read, Glob, Grep, etc. → apenas no sumário colapsável
}

function buildDiffCard(filePath, oldStr, newStr) {
  const card = document.createElement('div');
  card.className = 'inline-tool-card diff-card';

  const header = document.createElement('div');
  header.className = 'inline-tool-header';
  header.innerHTML = `
    <span class="inline-tool-icon">✏️</span>
    <span class="inline-tool-title">${escapeHtml(filePath)}</span>
    <div class="inline-tool-spinner"></div>
  `;
  card.appendChild(header);

  const pre = document.createElement('pre');
  pre.className = 'diff-pre';

  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // Linhas removidas
  oldLines.forEach(line => {
    const row = document.createElement('div');
    row.className = 'diff-line diff-removed';
    row.innerHTML = `<span class="diff-gutter">-</span><span class="diff-content">${escapeHtml(line)}</span>`;
    pre.appendChild(row);
  });

  // Separador
  const sep = document.createElement('div');
  sep.className = 'diff-separator';
  sep.textContent = '───────────────────────';
  pre.appendChild(sep);

  // Linhas adicionadas
  newLines.forEach(line => {
    const row = document.createElement('div');
    row.className = 'diff-line diff-added';
    row.innerHTML = `<span class="diff-gutter">+</span><span class="diff-content">${escapeHtml(line)}</span>`;
    pre.appendChild(row);
  });

  card.appendChild(pre);
  return card;
}

function buildCodeCard(icon, title, code, lang) {
  const card = document.createElement('div');
  card.className = 'inline-tool-card';

  const header = document.createElement('div');
  header.className = 'inline-tool-header';
  header.innerHTML = `
    <span class="inline-tool-icon">${icon}</span>
    <span class="inline-tool-title">${escapeHtml(title)}</span>
    <div class="inline-tool-spinner"></div>
  `;
  card.appendChild(header);

  if (code.trim()) {
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    if (lang) codeEl.className = `language-${lang}`;
    codeEl.textContent = code;
    if (window.hljs && lang) {
      try { hljs.highlightElement(codeEl); } catch (_) { }
    }
    pre.appendChild(codeEl);
    card.appendChild(pre);
  }

  return card;
}

// ── Tool use collapsible block ────────────────────────────────
function buildToolSummary(tools) {
  if (!tools.length) return 'Processamento finalizado';
  const first = tools[0].name || 'Ferramenta';
  const count = tools.length;
  if (count === 1) return `Executou ${first}`;
  return `Executou ${count} ferramentas (${first} e mais)`;
}

function renderToolUseBlock(tools) {
  if (!tools.length) return null;

  const summaryText = buildToolSummary(tools);

  const details = document.createElement('details');
  details.className = 'tool-use-block';

  const sum = document.createElement('summary');
  sum.className = 'tool-use-summary';
  sum.textContent = summaryText;
  details.appendChild(sum);

  const list = document.createElement('div');
  list.className = 'tool-use-list';

  // Limita a exibição inicial a 8 ferramentas
  const limit = 8;
  const showMoreSize = tools.length > limit;
  const visibleTools = tools.slice(0, limit);

  const createRow = (t) => {
    const row = document.createElement('div');
    row.className = 'tool-use-row';
    const labelData = typeof t.label === 'object' ? t.label : { name: t.name, val: t.label, sub: '' };
    row.innerHTML = `
      <div class="tool-use-header">
        <span class="tool-name">${labelData.name}</span>
        <span class="tool-pill" title="${escapeHtml(String(labelData.val))}">${escapeHtml(String(labelData.val))}</span>
      </div>
      ${t.output ? `<div class="tool-subtext">${escapeHtml(t.output.length > 500 ? t.output.slice(0, 500) + '...' : t.output)}</div>` : (labelData.sub ? `<div class="tool-subtext">${labelData.sub}</div>` : '')}
    `;
    return row;
  };

  visibleTools.forEach(t => list.appendChild(createRow(t)));

  if (showMoreSize) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'show-more-tools';
    moreBtn.textContent = `Mostrar mais ${tools.length - limit}`;
    moreBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      moreBtn.remove();
      tools.slice(limit).forEach(t => list.appendChild(createRow(t)));
    };
    list.appendChild(moreBtn);
  }

  details.appendChild(list);
  return details;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function injectQuickReplies(bubble, resultText) {
  const options = detectQuickReplies(resultText);
  if (!options.length) return;

  const bar = document.createElement('div');
  bar.className = 'quick-replies';

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.className = 'quick-reply-btn';
    btn.textContent = opt.length > 70 ? opt.slice(0, 70) + '…' : opt;
    btn.title = opt;
    btn.onclick = () => {
      bar.remove();
      sendMessage(opt);
    };
    bar.appendChild(btn);
  }

  const contentEl = bubble.querySelector('.content');
  if (contentEl) contentEl.appendChild(bar);
}

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
    } catch (_) { }
  }
  return false;
}

// Manipulação de Anexos
async function handleFileAttachment(files) {
  for (const file of files) {
    if (currentAttachments.length >= 5) {
      showNotification('Máximo de 5 anexos permitidos', 'error');
      break;
    }

    const isImage = file.type.startsWith('image/');
    const reader = new FileReader();

    reader.onload = (e) => {
      currentAttachments.push({
        name: file.name,
        type: file.type,
        data: e.target.result, // base64
        isImage: isImage
      });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  }
}

function renderAttachments() {
  if (!attachmentPreviews) return;
  attachmentPreviews.innerHTML = '';
  currentAttachments.forEach((at, index) => {
    const item = document.createElement('div');
    item.className = 'preview-item';

    if (at.isImage) {
      item.innerHTML = `<img src="${at.data}" alt="Preview">`;
    } else {
      item.innerHTML = `
        <div class="file-card-visual">
          <div class="file-card-line long"></div>
          <div class="file-card-line short"></div>
          <div class="file-card-line long"></div>
          <div class="file-card-line long"></div>
        </div>
        <div class="file-name-tag">${at.name}</div>
      `;
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-preview';
    removeBtn.innerHTML = '×';
    removeBtn.onclick = () => {
      currentAttachments.splice(index, 1);
      renderAttachments();
    };

    item.appendChild(removeBtn);
    attachmentPreviews.appendChild(item);
  });
}

// Chat logic
// directText: opcional, envia esse texto sem usar o input (usado pelos quick-reply buttons)
async function sendMessage(directText) {
  if (isGenerating) {
    console.log('[USER] Cancelando geração...');
    await invoke('stop_chat_stream');
    setGenerationState(false);
    return;
  }

  // Apenas considera `directText` se for realmente uma string (evita [object PointerEvent]
  // quando sendMessage é chamado como handler de click, por ex.)
  const hasDirectText = typeof directText === 'string';
  const text = hasDirectText ? directText.trim() : chatInput.value.trim();
  if (!text && currentAttachments.length === 0) return;

  hideSlashMenu();

  // Se veio de quick-reply, limpa o input (pode ter texto digitado)
  if (hasDirectText) chatInput.value = '';

  // Slash commands locais (não precisam ir ao CLI)
  if (text.startsWith('/')) {
    const handled = await handleSlashCommand(text);
    if (handled) {
      chatInput.value = '';
      chatInput.style.height = 'auto';
      return;
    }
  }

  console.log('[SEND-MESSAGE] Iniciando envio de mensagem...');
  console.log(`[SEND-MESSAGE] Texto: ${text.slice(0, 100)}... | Anexos: ${currentAttachments.length}`);

  // Renderizar mensagem do usuário na tela
  let displayContent = text;

  // Guardar temporariamente para o createLogLine mostrar
  window._currentSendingAttachments = [...currentAttachments];
  createLogLine(displayContent, 'user-message');
  window._currentSendingAttachments = null;

  chatInput.value = '';
  console.log('[USER] Sent:', text);

  // Gerar ID de sessão se não houver
  if (!currentSessionId) {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const title = text.slice(0, 20).trim().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
    currentSessionId = `session_${title}_${ts}`;
    console.log(`[SESSION] Criada nova sessão: ${currentSessionId}`);
  }

  // Auto-minimizar sidebar ao conversar
  if (sidebar && !sidebar.classList.contains('collapsed')) {
    sidebar.classList.add('collapsed');
  }

  // Transition UI to Chat Mode
  const hero = document.querySelector('.hero-section');
  if (hero) hero.classList.add('chat-mode');
  if (responseArea) responseArea.style.display = 'flex';

  // Reset tool use accumulator for this new message
  currentToolUses = [];
  toolCardMap.clear();
  lastAssistantBubble = null;
  currentAssistantText = '';

  // Show thinking indicator
  currentThinkingBubble = createLogLine('Pensando', 'thinking');
  window._stdoutLineBuf = ''; // Limpa buffer de linhas JSON entre mensagens

  const subEl = currentThinkingBubble.querySelector('.thinking-subtext');
  if (subEl) {
    subEl.style.display = 'inline-block';
    subEl.textContent = 'Preparando requisição...';
  }
  window._thinkingStartTime = Date.now();
  window._lastActivityTime = Date.now(); // Rastreia última atividade de stdout/stderr
  window._liveTokens = { in: 0, out: 0 };

  // Timer em tempo real atualiza a cada segundo
  window._thinkingTimer = setInterval(() => {
    if (!currentThinkingBubble) { clearInterval(window._thinkingTimer); return; }

    const elapsedSeconds = Math.floor((Date.now() - window._thinkingStartTime) / 1000);
    const m = Math.floor(elapsedSeconds / 60);
    const s = elapsedSeconds % 60;
    const formatted = m > 0 ? `${m}m${s}s` : `${s}s`;

    const timerEl = currentThinkingBubble.querySelector('.live-timer');
    if (timerEl) timerEl.textContent = formatted;

    const tokEl = currentThinkingBubble.querySelector('.live-tokens');
    const costEl = currentThinkingBubble.querySelector('.live-cost');
    if (tokEl && (window._liveTokens.in || window._liveTokens.out)) {
      tokEl.style.display = '';
      tokEl.textContent = `↑${window._liveTokens.in.toLocaleString()} ↓${window._liveTokens.out.toLocaleString()} tk`;
      
      const model = getLivingModel();
      const costRaw = calculateCost(model, window._liveTokens.in, window._liveTokens.out);
      if (costEl && costRaw > 0) {
        costEl.style.display = 'inline-block';
        costEl.innerHTML = `<span style="color: #999; margin-right: 2px;">$</span>${costRaw.toFixed(4)}`;
      }
    }

    // Indicador de inatividade: se nenhum dado chegou nos últimos 5s,
    // atualiza o subtítulo para deixar claro que está aguardando a API.
    // Nota: não usamos !lastAssistantBubble pois ele fica setado entre trocas da mesma sessão.
    const silenceSec = Math.floor((Date.now() - (window._lastActivityTime || Date.now())) / 1000);
    if (silenceSec >= 5) {
      const subEl = currentThinkingBubble.querySelector('.thinking-subtext');
      const titleEl = currentThinkingBubble.querySelector('.thinking-text');
      if (titleEl && titleEl.textContent !== 'Erro no processo') {
        titleEl.textContent = 'Processando';
      }
      if (subEl) {
        subEl.style.display = 'inline-block';
        const dots = '.'.repeat((Math.floor(silenceSec / 2) % 3) + 1);
        subEl.textContent = `Aguardando resposta${dots} ${silenceSec}s`;
      }
    }
  }, 1000);

  setGenerationState(true);

  try {
    // Simulação: Para arquivos de texto, vamos ler o conteúdo e anexar ao prompt
    let finalPrompt = text;

    if (currentAttachments.length > 0) {
      for (const at of currentAttachments) {
        if (at.path) {
          if (at.isImage) {
            // O CLI precisa saber de onde puxar a imagem se não for enviado via base64 nativo
            finalPrompt = `[Imagem anexada em: ${at.path}]\n\n${finalPrompt}`;
          } else {
            const ext = at.name.split('.').pop().toLowerCase();
            const binaryExts = ['pdf', 'zip', 'tar', 'gz', 'exe', 'bin', 'docx', 'xlsx'];

            if (binaryExts.includes(ext)) {
              // Deixa que a IA use a própria ferramenta de leitura/extração para arquivos complexos
              finalPrompt = `[Documento anexado em: ${at.path}]\nPor favor, utilize suas ferramentas de sistema para analisar este arquivo caso necessário.\n\n${finalPrompt}`;
            } else {
              try {
                const content = await readTextFile(at.path);
                // Trunca textos bizarramente grandes para não explodir a memória do Webview (100k caracteres max)
                const safeContent = content.length > 100000 ? content.slice(0, 100000) + '\n\n...[CONTEÚDO TRUNCADO PARA ECONOMIZAR CONTEXTO]' : content;
                finalPrompt = `[Conteúdo do Arquivo: ${at.name}]\n${safeContent}\n\n${finalPrompt}`;
              } catch (e) {
                console.warn(`Não foi possível ler ${at.name}:`, e);
                finalPrompt = `[Arquivo anexado em: ${at.path}]\n\n${finalPrompt}`;
              }
            }
          }
        }
      }
    }

    // Sempre ativar stream-json para parsing de eventos (tool use, text, etc.)
    let envVars = {
      'OPENCLAUDE_STREAM_JSON': '1',
      'OPENCLAUDE_MODE': currentMode,
      ...(currentProjectPath ? { 'OPENCLAUDE_CWD': currentProjectPath } : {}),
      ...(window._continueSession ? { 'OPENCLAUDE_CONTINUE': '1' } : {}),
    };
    // Após a primeira mensagem da sessão, ativa --continue automaticamente
    // para que as mensagens seguintes mantenham o contexto da conversa.
    window._continueSession = true;

    // Puxa as configurações do provedor salvas no Modal da interface
    const savedProvider = localStorage.getItem('openclaude_provider_full');
    if (savedProvider) {
      try {
        const data = JSON.parse(savedProvider);

        // Mapeia o provider da GUI para o valor que o CLI entende via --provider
        const idOrName = (data.id || data.name || '').toLowerCase();
        const cliProvider =
          idOrName === 'anthropic' ? 'anthropic' :
            idOrName === 'gemini' ? 'gemini' :
              idOrName === 'ollama' ? 'ollama' :
                'openai'; // OpenRouter, Groq, DeepSeek, Mistral, Together, LM Studio, custom, etc.

        Object.assign(envVars, {
          'OPENCLAUDE_PROVIDER': cliProvider,
          'OPENAI_API_KEY': data.apiKey || '',
          'ANTHROPIC_API_KEY': data.apiKey || '',
          'GROQ_API_KEY': data.apiKey || '',
          'OPENAI_BASE_URL': data.baseUrl || '',
          'OPENAI_MODEL': data.model || '',
          'ANTHROPIC_MODEL': data.model || ''
        });
      } catch (e) { }
    }

    console.log('[INVOKE] Chamando send_command no backend...');
    console.log(`[INVOKE] Provider: ${envVars.OPENCLAUDE_PROVIDER} | Model: ${envVars.OPENAI_MODEL}`);

    await invoke('send_command', {
      input: finalPrompt,
      attachments: currentAttachments.map(a => ({
        name: a.name,
        data: a.data || null,
        path: a.path || null,
        type: a.type || null
      })),
      envVars: envVars
    });

    console.log('[INVOKE] send_command executado com sucesso');
    currentAttachments = [];
    renderAttachments();
  } catch (err) {
    console.error('[INVOKE-ERROR] Erro ao invocar send_command:', err);
    setGenerationState(false);
    if (currentThinkingBubble) {
      currentThinkingBubble.remove();
      currentThinkingBubble = null;
    }
    showInChat(`Erro: ${err}`, 'stderr');
  }
}

// Input Events
sendBtn?.addEventListener('click', () => sendMessage());

// ── Memory Modal (CLAUDE.md) ───────────────────────────────────
document.body.insertAdjacentHTML('beforeend', `
<div id="memoryModal" class="modal-overlay">
  <div class="modal" style="width: 650px; max-width: 95vw;">
    <div class="modal-header">
      <h2 class="modal-title">Memória do Projeto</h2>
      <p class="modal-subtitle">Edite as instruções globais e histórico (CLAUDE.md)</p>
    </div>
    <textarea id="memoryTextarea" class="memory-textarea" spellcheck="false" placeholder="Escreva as regras do projeto aqui..."></textarea>
    <div class="modal-actions">
      <button id="cancelMemory" class="btn-modal-secondary">Cancelar</button>
      <button id="saveMemory" class="btn-modal-primary">Salvar</button>
    </div>
  </div>
</div>
`);

const memoryModal = document.getElementById('memoryModal');
const memoryTextarea = document.getElementById('memoryTextarea');
let currentMemoryPath = null;

window.openMemoryModal = async function (projectPath) {
  if (!projectPath) {
    showNotification('Nenhum projeto selecionado. Selecione uma pasta primeiro.', 'error');
    return;
  }

  const separator = projectPath.includes('\\') ? '\\' : '/';
  currentMemoryPath = `${projectPath}${separator}CLAUDE.md`;

  try {
    const content = await readTextFile(currentMemoryPath);
    memoryTextarea.value = content;
  } catch (err) {
    // Se der erro ao ler, assumimos que não existe ainda e mostramos um template
    memoryTextarea.value = "## Instruções do Projeto\n\nAdicione aqui o contexto, comandos e regras específicas para este projeto...";
  }

  memoryModal.classList.add('open');
};

document.getElementById('cancelMemory')?.addEventListener('click', () => {
  memoryModal.classList.remove('open');
});

document.getElementById('saveMemory')?.addEventListener('click', async () => {
  if (!currentMemoryPath) return;
  try {
    await writeTextFile(currentMemoryPath, memoryTextarea.value);
    showNotification('Memória (CLAUDE.md) salva com sucesso!', 'success');
    memoryModal.classList.remove('open');
  } catch (err) {
    showNotification('Erro ao salvar o arquivo CLAUDE.md', 'error');
  }
});

// ── Slash commands ───────────────────────────────────────────
const SLASH_COMMANDS = [
  { cmd: '/clear', icon: '🗑️', desc: 'Limpar conversa atual' },
  { cmd: '/compact', icon: '📦', desc: 'Compactar histórico para economizar contexto' },
  { cmd: '/memory', icon: '🧠', desc: 'Ver/editar memória do projeto (CLAUDE.md)' },
  { cmd: '/help', icon: '❓', desc: 'Mostrar comandos disponíveis' },
  { cmd: '/cost', icon: '💰', desc: 'Mostrar custo e tokens usados na sessão' },
  { cmd: '/init', icon: '🚀', desc: 'Inicializar projeto com CLAUDE.md' },
  { cmd: '/continue', icon: '↩️', desc: 'Continuar última conversa do projeto' },
];

const slashMenu = document.getElementById('slashMenu');
let slashMenuIndex = -1;

function showSlashMenu(filter) {
  const items = SLASH_COMMANDS.filter(c => c.cmd.startsWith(filter));
  if (!items.length) { hideSlashMenu(); return; }

  slashMenu.innerHTML = '';
  items.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'slash-item' + (i === slashMenuIndex ? ' active' : '');
    el.innerHTML = `<span class="slash-icon">${item.icon}</span><span class="slash-cmd">${item.cmd}</span><span class="slash-desc">${item.desc}</span>`;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      chatInput.value = item.cmd + ' ';
      autoResizeInput();
      hideSlashMenu();
      chatInput.focus();
    });
    slashMenu.appendChild(el);
  });
  slashMenu.style.display = 'flex';
  slashMenuIndex = -1;
}

function hideSlashMenu() {
  slashMenu.style.display = 'none';
  slashMenuIndex = -1;
}

async function handleSlashCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const base = parts[0].toLowerCase();

  if (base === '/clear') {
    if (confirm('Limpar a conversa atual?')) startNewSession();
    return true;
  }
  if (base === '/help') {
    const help = SLASH_COMMANDS.map(c => `${c.icon} **${c.cmd}** — ${c.desc}`).join('\n');
    showInChat('**Comandos disponíveis:**\n\n' + help, 'stdout');
    return true;
  }
  if (base === '/cost') {
    const tok = window._liveTokens || { in: 0, out: 0 };
    showInChat(`**Tokens nesta sessão:** ↑${tok.in.toLocaleString()} entrada / ↓${tok.out.toLocaleString()} saída`, 'stdout');
    return true;
  }
  if (base === '/memory') {
    // Abre o CLAUDE.md do projeto ou da pasta padrão
    const projectPath = currentProjectPath || null;
    openMemoryModal(projectPath);
    return true;
  }
  if (base === '/continue') {
    window._continueSession = true;
    showInChat('↩️ Modo continuar ativado — próxima mensagem vai retomar a última sessão do projeto.', 'system');
    return true;
  }
  // /compact e /init → passa direto para o CLI
  return false;
}

// Auto-resize do textarea conforme o usuário digita
function autoResizeInput() {
  if (!chatInput) return;
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
}
chatInput?.addEventListener('input', () => {
  autoResizeInput();
  const val = chatInput.value;
  if (val.startsWith('/') && !val.includes(' ')) {
    showSlashMenu(val);
  } else {
    hideSlashMenu();
  }
});

chatInput?.addEventListener('keydown', (e) => {
  // Navegar no slash menu com setas
  if (slashMenu.style.display !== 'none') {
    const items = slashMenu.querySelectorAll('.slash-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashMenuIndex = Math.min(slashMenuIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === slashMenuIndex));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashMenuIndex = Math.max(slashMenuIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === slashMenuIndex));
      return;
    }
    if (e.key === 'Tab' || (e.key === 'Enter' && slashMenuIndex >= 0)) {
      e.preventDefault();
      const active = slashMenu.querySelector('.slash-item.active') || items[0];
      if (active) active.dispatchEvent(new MouseEvent('mousedown'));
      return;
    }
    if (e.key === 'Escape') { hideSlashMenu(); return; }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    if (chatInput) chatInput.style.height = 'auto';
  }
});

// Listener para colar imagens (Ctrl+V)
chatInput?.addEventListener('paste', (e) => {
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (const item of items) {
    if (item.type.indexOf('image') !== -1) {
      const file = item.getAsFile();
      handleFileAttachment([file]);
    }
  }
});

// Listener para o botão de alfinete (diálogo do Tauri)
attachBtn?.addEventListener('click', async () => {
  try {
    const selected = await open({
      multiple: true,
      filters: [{
        name: 'Imagens e Documentos',
        extensions: ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'txt', 'js', 'py', 'rs']
      }]
    });

    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      paths.forEach(path => {
        const name = path.split(/[\\/]/).pop();
        currentAttachments.push({
          name: name,
          path: path,
          isImage: name.match(/\.(png|jpg|jpeg|gif)$/i),
          isPath: true
        });
      });
      renderAttachments();
    }
  } catch (err) {
    console.error('Erro ao abrir diálogo:', err);
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = (e) => handleFileAttachment(e.target.files);
    input.click();
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
    window._continueSession = false;

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

    await syncProviderWithCLI();
    const savedLocal = localStorage.getItem('openclaude_provider');
    if (savedLocal && !document.querySelector('.model-selector span').textContent.includes('·')) {
      const { name, model } = JSON.parse(savedLocal);
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