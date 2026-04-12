# 🚀 OpenClaude GUI

<div align="center">
  <img src="assets/Preview.png" alt="OpenClaude GUI Banner" width="100%">
  
  <p align="center">
    <strong>Uma interface desktop moderna, rápida e elegante para o OpenClaude.</strong>
  </p>

  <p align="center">
    <img src="https://img.shields.io/badge/Maintained%20%3F-yes-green.svg" alt="Maintained">
    <img src="https://img.shields.io/github/license/danilo/openclaude-gui" alt="License">
    <img src="https://img.shields.io/badge/Framework-Tauri%202-blue" alt="Framework">
    <img src="https://img.shields.io/badge/Frontend-Vite%20%2B%20JS-yellow" alt="Frontend">
  </p>
</div>

---

## 🌟 O que é o OpenClaude GUI?

O **OpenClaude GUI** é o cliente desktop oficial (e bonitão!) para o projeto **OpenClaude** — o nosso Claude open source. Este projeto foi desenvolvido para proporcionar uma experiência de usuário premium, focada em produtividade e uma estética moderna.

Nascido da necessidade de ter uma interface local poderosa e fácil de usar, ele conecta você diretamente ao poder do OpenClaude sem as distrações do navegador.

## ✨ Funcionalidades Principais

- 🖥️ **Interface Nativa**: Construído com **Tauri 2**, garantindo baixo consumo de recursos e performance máxima.
- 🎨 **Design Premium**: Estética *glassmorphism* com bordas finas e sombras suaves para um visual state-of-the-art.
- 💬 **Gestão de Sessões**: Histórico de chat persistente e organizado.
- 🤖 **Seletor de Modelos**: Troque entre diferentes versões e provedores do OpenClaude com facilidade.
- 🚀 **Performance**: Frontend ultra-rápido utilizando **Vite** e Vanilla JS/CSS.

## 🛠️ Tecnologias Utilizadas

- [Tauri 2](https://tauri.app/) - Backend em Rust, UI em Webview.
- [Vite](https://vitejs.dev/) - Tooling de frontend rápido.
- [Vanilla CSS/JS](https://developer.mozilla.org/en-US/) - Para controle total e performance.

## 🚀 Como Começar

### Pré-requisitos

Antes de começar, você precisará ter instalado:
- [Node.js](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/tools/install) (necessário para o Tauri)

### Instalação

1. Clone o repositório:
   ```bash
   git clone https://github.com/seu-usuario/openclaude-gui.git
   cd openclaude-gui
   ```

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Inicie em modo de desenvolvimento:
   ```bash
   npm run tauri:dev
   ```

### Build

Para gerar o executável final:
```bash
npm run tauri:build
```

## 🤝 Contribuindo

Este projeto é feito pela comunidade para a comunidade. Sinta-se à vontade para abrir issues ou enviar Pull Requests para ajudar a tornar o OpenClaude a melhor alternativa open source!

1. Faça um Fork do projeto
2. Crie sua Feature Branch (`git checkout -b feature/NovaFeature`)
3. Commit suas mudanças (`git commit -m 'Add: Nova Feature'`)
4. Push para a Branch (`git push origin feature/NovaFeature`)
5. Abra um Pull Request

---

<div align="center">
  <p>Desenvolvido com ❤️ para a comunidade Open Source.</p>
</div>
