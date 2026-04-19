const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
} = require("obsidian");
const { spawn, execSync } = require("child_process");

const VIEW_TYPE = "local-llm-chat";

// ─── Chat View ────────────────────────────────────────────────────────────────

class LLMChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "LLM Chat"; }
  getIcon() { return "message-square"; }

  async onOpen() {
    this.build();

    const ok = await this.plugin.ensureReady((msg, isError) =>
      this.setStatus(msg, isError)
    );
    if (ok) this.setReady();
  }

  // Called whenever the panel is closed (leaf detached), Obsidian open or not.
  // Unload the model from memory to free VRAM/RAM.
  async onClose() {
    await this.plugin.unloadModel();
  }

  build() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("llm-root");

    // Top bar: status text + close button
    const topBar = root.createDiv({ cls: "llm-topbar" });
    this.statusEl = topBar.createDiv({ cls: "llm-status" });
    this.setStatus("Initializing…");
    const closeBtn = topBar.createEl("button", { cls: "llm-btn llm-btn-close", text: "✕" });
    closeBtn.setAttribute("aria-label", "Close panel");
    closeBtn.addEventListener("click", () => this.leaf.detach());

    this.messagesEl = root.createDiv({ cls: "llm-messages" });

    const bar = root.createDiv({ cls: "llm-bar" });
    this.inputEl = bar.createEl("textarea", {
      cls: "llm-input",
      attr: { placeholder: "Ask something… (Enter to send, Shift+Enter for newline)" },
    });
    this.inputEl.disabled = true;

    const actions = bar.createDiv({ cls: "llm-actions" });
    this.sendBtn = actions.createEl("button", {
      cls: "llm-btn llm-btn-send",
      text: "Send",
    });
    this.sendBtn.disabled = true;

    const clearBtn = actions.createEl("button", {
      cls: "llm-btn llm-btn-clear",
      text: "Clear",
    });

    this.sendBtn.addEventListener("click", () => this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    clearBtn.addEventListener("click", () => {
      this.messages = [];
      this.messagesEl.empty();
    });

    this.messages.forEach((m) => this.addBubble(m.role, m.content));
  }

  setStatus(text, isError = false) {
    if (!this.statusEl) return;
    this.statusEl.setText(text);
    this.statusEl.className = "llm-status" + (isError ? " llm-status-error" : "");
  }

  setReady() {
    if (!this.statusEl) return;
    this.statusEl.setText(`● ${this.plugin.settings.model} ready`);
    this.statusEl.className = "llm-status llm-status-ok";
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    this.inputEl.focus();
  }

  addBubble(role, text) {
    const wrap = this.messagesEl.createDiv({ cls: `llm-msg llm-msg-${role}` });
    wrap.createDiv({ cls: "llm-msg-label", text: role === "user" ? "You" : "Assistant" });
    const content = wrap.createDiv({ cls: "llm-msg-content" });
    content.setText(text);
    this.scrollBottom();
    return content;
  }

  scrollBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  setLoading(on) {
    this.sendBtn.disabled = on;
    this.sendBtn.setText(on ? "…" : "Send");
    this.inputEl.disabled = on;
  }

  async send() {
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = "";
    this.messages.push({ role: "user", content: text });
    this.addBubble("user", text);
    this.setLoading(true);

    const contentEl = this.addBubble("assistant", "");
    contentEl.addClass("llm-thinking");

    try {
      const { ollamaUrl, model, systemPrompt } = this.plugin.settings;
      const apiMessages = [];
      if (systemPrompt.trim())
        apiMessages.push({ role: "system", content: systemPrompt.trim() });
      apiMessages.push(...this.messages);

      const res = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: apiMessages, stream: true }),
      });

      if (!res.ok) throw new Error(`Ollama returned ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      contentEl.removeClass("llm-thinking");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split("\n")) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.content) {
              full += chunk.message.content;
              contentEl.setText(full);
              this.scrollBottom();
            }
          } catch {}
        }
      }

      this.messages.push({ role: "assistant", content: full });
    } catch (err) {
      contentEl.removeClass("llm-thinking");
      contentEl.addClass("llm-error");
      contentEl.setText(`Error: ${err.message}`);
      new Notice(`LLM Chat: ${err.message}`);
    } finally {
      this.setLoading(false);
      this.inputEl.focus();
    }
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class LLMSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Local LLM Chat" });

    new Setting(containerEl)
      .setName("Ollama URL")
      .setDesc("Base URL where Ollama runs.")
      .addText((t) =>
        t.setValue(this.plugin.settings.ollamaUrl).onChange(async (v) => {
          this.plugin.settings.ollamaUrl = v.trim();
          this.plugin.resetReady();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc(
        "Ollama model name (e.g. gemma3:270m, llama3, mistral). " +
        "Pulled automatically if not present."
      )
      .addText((t) =>
        t.setValue(this.plugin.settings.model).onChange(async (v) => {
          this.plugin.settings.model = v.trim();
          this.plugin.resetReady();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Sent at the start of every conversation. Keep it short.")
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
          this.plugin.settings.systemPrompt = v;
          await this.plugin.saveSettings();
        });
      });
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  ollamaUrl: "http://localhost:11434",
  model: "gemma3:270m",
  systemPrompt: "You are a concise, helpful assistant.",
};

class LocalLLMChatPlugin extends Plugin {
  ollamaProcess = null; // only set if WE spawned it
  _readyPromise = null;

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new LLMChatView(leaf, this));

    this.addRibbonIcon("message-square", "Open LLM Chat", () => this.openPanel());
    this.addCommand({
      id: "open-llm-chat",
      name: "Open LLM Chat panel",
      callback: () => this.openPanel(),
    });

    this.addSettingTab(new LLMSettingTab(this.app, this));

    // 'quit' fires before Obsidian closes the window — more reliable than onunload
    // for stopping the server process.
    this.registerEvent(
      this.app.workspace.on("quit", () => this.shutdown())
    );
  }

  async openPanel() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  resetReady() {
    this._readyPromise = null;
  }

  ensureReady(onStatus) {
    if (!this._readyPromise) {
      this._readyPromise = this._doEnsureReady(onStatus).catch((err) => {
        this._readyPromise = null;
        throw err;
      });
    } else {
      onStatus?.("Waiting for initialization…");
    }
    return this._readyPromise;
  }

  async _doEnsureReady(onStatus) {
    const status = (msg, isError = false) => {
      onStatus?.(msg, isError);
      console.log(`[LLM Chat] ${msg}`);
    };

    try {
      status("Checking Ollama…");
      const alreadyRunning = await this.pingOllama();

      if (!alreadyRunning) {
        status("Starting Ollama server…");
        await this.spawnOllamaServer();
        const ready = await this.waitForOllama(20000);
        if (!ready) {
          throw new Error(
            '"ollama serve" did not respond in 20 s. ' +
            'Is "ollama" installed and in your PATH?'
          );
        }
      }

      const modelReady = await this.isModelAvailable();
      if (!modelReady) {
        status(`Pulling "${this.settings.model}" — this may take a while…`);
        await this.pullModel((msg) => status(msg));
      }

      return true;
    } catch (err) {
      status(`Error: ${err.message}`, true);
      new Notice(`LLM Chat: ${err.message}`);
      this._readyPromise = null;
      return false;
    }
  }

  // ── Model memory management ───────────────────────────────────────────────

  // Unload model from GPU/RAM — called when the chat panel is closed while
  // Obsidian is still open. The server keeps running; only VRAM is freed.
  async unloadModel() {
    const { model } = this.settings;
    console.log(`[LLM Chat] Unloading model: ${model}`);
    try {
      await new Promise((resolve, reject) => {
        const proc = spawn("ollama", ["stop", model], {
          stdio: "ignore",
        });
        proc.on("close", resolve);
        proc.on("error", reject);
      });
    } catch (err) {
      // Not fatal — model just stays in memory
      console.warn(`[LLM Chat] Could not run ollama stop: ${err.message}`);
    }
  }

  // Stop model AND kill the server — called when Obsidian quits.
  async shutdown() {
    await this.unloadModel();

    if (this.ollamaProcess) {
      console.log("[LLM Chat] Stopping Ollama server…");
      // Try graceful first, then force after 2 s
      this.ollamaProcess.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        try { this.ollamaProcess?.kill("SIGKILL"); } catch {}
      }, 2000);
      await new Promise((resolve) => {
        this.ollamaProcess.on("close", () => {
          clearTimeout(killTimer);
          resolve();
        });
        // Don't wait forever
        setTimeout(resolve, 3000);
      });
      this.ollamaProcess = null;
    }
  }

  // ── Ollama helpers ────────────────────────────────────────────────────────

  async pingOllama() {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${this.settings.ollamaUrl}/api/tags`, {
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }

  async waitForOllama(timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.pingOllama()) return true;
      await new Promise((r) => setTimeout(r, 600));
    }
    return false;
  }

  spawnOllamaServer() {
    return new Promise((resolve, reject) => {
      let errored = false;

      const proc = spawn("ollama", ["serve"], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      proc.on("error", (err) => {
        errored = true;
        reject(
          new Error(
            `Could not launch Ollama: ${err.message}. ` +
            `Make sure "ollama" is installed and in your PATH.`
          )
        );
      });

      // 300 ms grace — if it exits immediately it was likely a port conflict,
      // meaning Ollama was already running (pingOllama will confirm).
      setTimeout(() => {
        if (!errored) {
          this.ollamaProcess = proc;
          resolve();
        }
      }, 300);
    });
  }

  async isModelAvailable() {
    try {
      const res = await fetch(`${this.settings.ollamaUrl}/api/tags`);
      const data = await res.json();
      const name = this.settings.model.toLowerCase().split(":")[0];
      return (data.models ?? []).some((m) =>
        m.name.toLowerCase().startsWith(name)
      );
    } catch {
      return false;
    }
  }

  pullModel(onProgress) {
    return new Promise((resolve, reject) => {
      const proc = spawn("ollama", ["pull", this.settings.model], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buf = "";
      const handleData = (data) => {
        buf += data.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.total && json.completed) {
              const pct = Math.round((json.completed / json.total) * 100);
              onProgress(`Pulling ${this.settings.model}… ${pct}%`);
            } else if (json.status) {
              onProgress(json.status);
            }
          } catch {
            const clean = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
            if (clean) onProgress(clean);
          }
        }
      };

      proc.stdout.on("data", handleData);
      proc.stderr.on("data", handleData);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ollama pull exited with code ${code}`));
      });
      proc.on("error", (err) =>
        reject(new Error(`Cannot run ollama pull: ${err.message}`))
      );
    });
  }

  // ── Plugin lifecycle ──────────────────────────────────────────────────────

  onunload() {
    // onunload fires on plugin disable/reload.
    // Obsidian close is handled by the 'quit' event above.
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    this.shutdown();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = LocalLLMChatPlugin;
