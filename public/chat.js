/**
 * LLM Chat App Frontend
 *
 * Handles the chat UI interactions and communication with the backend API.
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const fileAttachButton = document.getElementById("file-attach-button");
const fileInput = document.getElementById("file-input");
const attachmentPreview = document.getElementById("attachment-preview");
const sessionListEl = document.getElementById("session-list");
const newChatButton = document.getElementById("new-chat-button");
const modelSelect = document.getElementById("model-select");

// Chat state
const SESSION_LIST_KEY = "llm-chat-sessions";
const ACTIVE_SESSION_KEY = "llm-chat-active-session";
const LEGACY_SESSION_KEY = "llm-chat-session-id";
const DEFAULT_SESSION_TITLE = "New chat";
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MODELS_RESOURCE_PATH = "/models.json";
const DEFAULT_MODEL_OPTIONS = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Llama 3.3 70B Instruct (fast)",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct-fp8",
    label: "Llama 3.1 8B Instruct",
  },
  {
    id: "@cf/mistral/mistral-7b-instruct-v0.2",
    label: "Mistral 7B Instruct v0.2",
  },
  {
    id: "@cf/qwen/qwen1.5-7b-chat-awq",
    label: "Qwen 1.5 7B Chat",
  },
  {
    id: "@cf/openchat/openchat-3.5-0106",
    label: "OpenChat 3.5",
  },
];
let modelOptions = [];
const DEFAULT_GREETING =
  "Hello! I'm an LLM chat app powered by Cloudflare Workers AI. How can I help you today?";
let sessions = loadSessionsFromStorage();
migrateLegacySession();
let activeSessionId = loadActiveSessionId();

if (!activeSessionId) {
  const session = createSessionRecord();
  sessions.unshift(session);
  activeSessionId = session.id;
  persistSessions();
}

localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
let chatHistory = [];
let isProcessing = false;
let attachments = [];

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Send button click handler
sendButton.addEventListener("click", sendMessage);

if (fileAttachButton && fileInput) {
  fileAttachButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", handleFileSelection);
}

if (modelSelect) {
  loadModelOptions().finally(() => {
    populateModelSelect();
    updateModelSelectionUI();
  });
  modelSelect.addEventListener("change", handleModelChange);
} else {
  loadModelOptions();
}

if (newChatButton) {
  newChatButton.addEventListener("click", () => {
    const session = createSessionRecord();
    sessions.unshift(session);
    persistSessions();
    setActiveSession(session.id);
  });
}

renderSessionList();
// Initialize chat history
initializeChat();

/**
 * Sends a message to the chat API and processes the response
 */
async function sendMessage() {
  const message = userInput.value.trim();

  // Don't send empty messages
  if (message === "" || isProcessing) return;

  // Disable input while processing
  isProcessing = true;
  userInput.disabled = true;
  sendButton.disabled = true;

  // Add user message to chat
  addMessageToChat("user", message);

  // Clear input
  userInput.value = "";
  userInput.style.height = "auto";

  // Show typing indicator
  typingIndicator.classList.add("visible");

  // Add message to history
  chatHistory.push({ role: "user", content: message });
  maybeUpdateSessionTitle(message);

  try {
    const activeSession = getActiveSession();
    const modelId = activeSession?.modelId ?? DEFAULT_MODEL_ID;

    // Create new assistant response element
    const assistantMessageEl = document.createElement("div");
    assistantMessageEl.className = "message assistant-message";
    assistantMessageEl.innerHTML = `
      <div class="assistant-message-body">
        <p></p>
      </div>
      <div class="assistant-context" hidden>
        <h4>Context used</h4>
        <ol></ol>
      </div>
    `;
    chatMessages.appendChild(assistantMessageEl);

    const responseParagraph = assistantMessageEl.querySelector("p");
    const contextContainer =
      assistantMessageEl.querySelector(".assistant-context");
    const contextList = assistantMessageEl.querySelector(".assistant-context ol");

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Send request to API
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sessionId: activeSessionId,
        modelId,
        message,
      }),
    });

    // Handle errors
    if (!response.ok) {
      throw new Error("Failed to get response");
    }

    // Process streaming response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      // Decode chunk
      const chunk = decoder.decode(value, { stream: true });

      // Process SSE format
      const lines = chunk.split("\n");
      for (const line of lines) {
        try {
          const trimmed = line.trim();
          if (trimmed === "") {
            continue;
          }

          const jsonData = JSON.parse(trimmed);

          if (Array.isArray(jsonData.context)) {
            renderContextInline(contextContainer, contextList, jsonData.context);
            continue;
          }

          if (jsonData.response) {
            // Append new content to existing text
            responseText += jsonData.response;
            responseParagraph.textContent = responseText;

            // Scroll to bottom
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        } catch (e) {
          console.error("Error parsing JSON:", e);
        }
      }
    }

    // Add completed response to chat history
    chatHistory.push({ role: "assistant", content: responseText });
    touchSession(activeSessionId);
  } catch (error) {
    console.error("Error:", error);
    addMessageToChat(
      "assistant",
      "Sorry, there was an error processing your request.",
    );
  } finally {
    // Hide typing indicator
    typingIndicator.classList.remove("visible");

    // Re-enable input
    isProcessing = false;
    userInput.disabled = false;
    sendButton.disabled = false;
    userInput.focus();
  }
}

/**
 * Helper function to add message to chat
 */
function addMessageToChat(role, content) {
  const messageEl = document.createElement("div");
  messageEl.className = `message ${role}-message`;
  messageEl.innerHTML = `<p>${content}</p>`;
  chatMessages.appendChild(messageEl);

  // Scroll to bottom
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Loads chat history from the server and renders it
 */
async function initializeChat() {
  chatMessages.innerHTML = "";
  attachments = [];
  renderAttachmentPreview();

  if (!activeSessionId) {
    const session = createSessionRecord();
    sessions.unshift(session);
    activeSessionId = session.id;
    persistSessions();
    renderSessionList();
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  }

  addMessageToChat("assistant", DEFAULT_GREETING);

  try {
    const response = await fetch(
      `/api/history?sessionId=${encodeURIComponent(activeSessionId)}`,
    );

    if (!response.ok) {
      throw new Error("Failed to load history");
    }

    const data = await response.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const session = getActiveSession();
    const serverModelId =
      typeof data.modelId === "string" && data.modelId.trim()
        ? data.modelId.trim()
        : undefined;
    if (session && serverModelId && session.modelId !== serverModelId) {
      session.modelId = serverModelId;
      persistSessions();
      renderSessionList();
    }

    if (messages.length === 0) {
      chatHistory = [];
      updateModelSelectionUI();
      return;
    }

    chatHistory = messages;
    chatMessages.innerHTML = "";
    for (const msg of messages) {
      addMessageToChat(msg.role, msg.content);
    }
    updateModelSelectionUI();
  } catch (error) {
    console.error("Error loading chat history:", error);
    updateModelSelectionUI();
  }
}

function addAttachment(file, status = "uploading", message = "") {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  attachments.push({
    id,
    file,
    name: file.name ?? "Untitled file",
    status,
    message,
  });

  renderAttachmentPreview();
  return id;
}

function setAttachmentStatus(id, status, message = "") {
  attachments = attachments.map((attachment) =>
    attachment.id === id
      ? { ...attachment, status, message }
      : attachment,
  );
  renderAttachmentPreview();
}

function renderContextInline(container, listEl, snippets) {
  if (!container || !listEl) return;

  if (!Array.isArray(snippets) || snippets.length === 0) {
    container.hidden = true;
    listEl.innerHTML = "";
    return;
  }

  container.hidden = false;
  listEl.innerHTML = "";

  snippets.forEach((snippet) => {
    if (!snippet || typeof snippet.text !== "string") {
      return;
    }

    const li = document.createElement("li");
    const title =
      typeof snippet.title === "string" && snippet.title.trim()
        ? snippet.title.trim()
        : "Untitled document";
    const preview =
      snippet.text.length > 280 ? `${snippet.text.slice(0, 280)}…` : snippet.text;

    const titleEl = document.createElement("strong");
    titleEl.textContent = title;
    li.appendChild(titleEl);

    const metaParts = [];
    if (typeof snippet.index === "number") {
      metaParts.push(`chunk ${snippet.index + 1}`);
    }
    if (typeof snippet.score === "number") {
      metaParts.push(`relevance ${snippet.score.toFixed(2)}`);
    }

    if (metaParts.length > 0) {
      const metaEl = document.createElement("span");
      metaEl.className = "context-meta";
      metaEl.textContent = metaParts.join(" • ");
      li.appendChild(metaEl);
    }

    const bodyEl = document.createElement("div");
    bodyEl.textContent = preview;
    li.appendChild(bodyEl);

    listEl.appendChild(li);
  });
}

function handleFileSelection(event) {
  const files = Array.from(event.target.files ?? []);
  if (!files.length) return;

  for (const file of files) {
    const id = addAttachment(file, "uploading", "Uploading…");
    uploadFileAsKnowledge(id, file);
  }

  // Reset input to allow selecting the same file again if needed
  event.target.value = "";
}

function renderAttachmentPreview() {
  if (!attachmentPreview) return;

  attachmentPreview.innerHTML = "";
  if (!attachments.length) {
    attachmentPreview.hidden = true;
    return;
  }

  attachmentPreview.hidden = false;

  attachments.forEach((attachment) => {
    const chip = document.createElement("div");
    chip.style.display = "inline-flex";
    chip.style.alignItems = "center";
    chip.style.gap = "0.45rem";
    chip.style.padding = "0.35rem 0.75rem";
    chip.style.borderRadius = "999px";
    chip.style.backgroundColor = "rgba(42, 44, 50, 0.9)";
    chip.style.border = "1px solid rgba(255, 255, 255, 0.08)";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = attachment.name;
    nameSpan.style.fontSize = "0.9rem";

    const statusSpan = document.createElement("span");
    statusSpan.style.fontSize = "0.8rem";
    statusSpan.style.opacity = "0.7";
    if (attachment.status === "uploading") {
      statusSpan.textContent = "Uploading…";
    } else if (attachment.status === "ok") {
      statusSpan.textContent = "Indexed";
      statusSpan.style.color = "#34d399";
    } else if (attachment.status === "error") {
      statusSpan.textContent = attachment.message || "Failed";
      statusSpan.style.color = "#f87171";
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.textContent = "✕";
    removeBtn.style.border = "none";
    removeBtn.style.background = "transparent";
    removeBtn.style.color = "var(--text-muted)";
    removeBtn.style.cursor = "pointer";
    removeBtn.style.fontSize = "0.9rem";
    removeBtn.addEventListener("click", () => {
      attachments = attachments.filter((item) => item.id !== attachment.id);
      renderAttachmentPreview();
      if (fileInput) {
        fileInput.value = "";
      }
    });

    chip.appendChild(nameSpan);
    chip.appendChild(statusSpan);
    chip.appendChild(removeBtn);
    attachmentPreview.appendChild(chip);
  });
}

function showKnowledgeToast(title, chunkCount, isError = false, details = "") {
  const toast = document.createElement("div");
  toast.className = `knowledge-toast${isError ? " error" : ""}`;
  const safeTitle = title && title.trim() ? title.trim() : "Untitled document";

  if (isError) {
    toast.innerHTML = `<strong>Upload failed</strong><span>${safeTitle}${
      details ? ` • ${details}` : ""
    }</span>`;
  } else {
    const chunksLabel =
      chunkCount === 1 ? "1 chunk indexed" : `${chunkCount} chunks indexed`;
    toast.innerHTML = `<strong>Knowledge updated</strong><span>${safeTitle} • ${chunksLabel}</span>`;
  }

  chatMessages.appendChild(toast);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

async function uploadFileAsKnowledge(id, file) {
  setAttachmentStatus(id, "uploading", "Uploading…");
  const formData = new FormData();
  formData.append("file", file, file.name);
  formData.append("title", file.name ?? "Document");

  try {
    const response = await fetch("/api/docs", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      let message = "Failed to index document.";
      try {
        const data = await response.json();
        if (data?.error) {
          message = data.error;
        }
      } catch {
        // ignore
      }
      throw new Error(message);
    }

    const success = await response.json();
    const title = success?.title ?? file.name ?? "Document";
    const chunkCount = success?.chunks ?? 0;
    setAttachmentStatus(id, "ok", "Indexed");
    showKnowledgeToast(title, chunkCount);
    touchSession(activeSessionId);
  } catch (error) {
    console.error("Document upload failed:", error);
    const message =
      error instanceof Error ? error.message : "Failed to index document.";
    setAttachmentStatus(id, "error", message);
    showKnowledgeToast(file.name ?? "Document", 0, true, message);
  }
}

function loadSessionsFromStorage() {
  try {
    const raw = localStorage.getItem(SESSION_LIST_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

  return parsed
    .filter((item) => item && typeof item.id === "string")
    .map((item) => ({
      id: item.id,
      title:
        typeof item.title === "string" && item.title.trim()
          ? item.title.trim()
          : DEFAULT_SESSION_TITLE,
      modelId:
        typeof item.modelId === "string" && item.modelId.trim()
          ? item.modelId.trim()
          : DEFAULT_MODEL_ID,
      createdAt:
        typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      updatedAt:
        typeof item.updatedAt === "string"
          ? item.updatedAt
            : item.createdAt ?? new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

function persistSessions() {
  try {
    localStorage.setItem(SESSION_LIST_KEY, JSON.stringify(sessions));
  } catch (error) {
    console.error("Failed to persist sessions:", error);
  }
}

function migrateLegacySession() {
  try {
    const legacyId = localStorage.getItem(LEGACY_SESSION_KEY);
  if (!legacyId) {
    return;
  }

  if (sessions.some((session) => session.id === legacyId)) {
    localStorage.removeItem(LEGACY_SESSION_KEY);
    return;
  }

  const now = new Date().toISOString();
  sessions.unshift({
    id: legacyId,
    title: "Previous chat",
    modelId: DEFAULT_MODEL_ID,
    createdAt: now,
    updatedAt: now,
  });
  localStorage.removeItem(LEGACY_SESSION_KEY);
  persistSessions();
  } catch (error) {
    console.error("Failed to migrate legacy session:", error);
  }
}

function loadActiveSessionId() {
  const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
  if (stored && sessions.some((session) => session.id === stored)) {
    return stored;
  }
  return sessions.length ? sessions[0].id : null;
}

function createSessionRecord(title = DEFAULT_SESSION_TITLE, id) {
  const now = new Date().toISOString();
  return {
    id: id ?? generateSessionId(),
    title,
    modelId: DEFAULT_MODEL_ID,
    createdAt: now,
    updatedAt: now,
  };
}

function generateSessionId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function setActiveSession(sessionId) {
  if (!sessionId || sessionId === activeSessionId) {
    return;
  }

  if (!sessions.some((session) => session.id === sessionId)) {
    return;
  }

  activeSessionId = sessionId;
  localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  attachments = [];
  renderAttachmentPreview();
  renderSessionList();
  updateModelSelectionUI();
  initializeChat();
}

function renderSessionList() {
  if (!sessionListEl) return;

  sessionListEl.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "session-empty";
    empty.textContent = "No conversations yet";
    sessionListEl.appendChild(empty);
    updateModelSelectionUI();
    return;
  }

  sessions.forEach((session) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-item${
      session.id === activeSessionId ? " active" : ""
    }`;

    const titleEl = document.createElement("span");
    titleEl.className = "session-item-title";
    titleEl.textContent = session.title || DEFAULT_SESSION_TITLE;

    const metaEl = document.createElement("span");
    metaEl.className = "session-item-meta";
    metaEl.textContent = formatTimestamp(session.updatedAt);

    button.appendChild(titleEl);
    button.appendChild(metaEl);

    button.addEventListener("click", () => {
      if (session.id !== activeSessionId) {
        setActiveSession(session.id);
      }
    });

    sessionListEl.appendChild(button);
  });

  updateModelSelectionUI();
}

function formatTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function touchSession(sessionId, updates = {}) {
  const index = sessions.findIndex((session) => session.id === sessionId);
  if (index === -1) {
    return;
  }

  const session = sessions[index];
  session.updatedAt = new Date().toISOString();
  if (typeof updates.title === "string" && updates.title.trim()) {
    session.title = updates.title.trim();
  }
   if (typeof updates.modelId === "string" && updates.modelId.trim()) {
     session.modelId = updates.modelId.trim();
   }

  sessions.splice(index, 1);
  sessions.unshift(session);
  persistSessions();
  renderSessionList();
  return session;
}

function maybeUpdateSessionTitle(message) {
  const session = sessions.find((item) => item.id === activeSessionId);
  if (!session) {
    return;
  }

  const trimmed = message.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    touchSession(activeSessionId);
    return;
  }

  if (!session.title || session.title === DEFAULT_SESSION_TITLE) {
    const newTitle = trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
    touchSession(activeSessionId, { title: newTitle });
  } else {
    touchSession(activeSessionId);
  }
}

async function loadModelOptions() {
  try {
    const response = await fetch(MODELS_RESOURCE_PATH, {
      headers: {
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to load model list: ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("Invalid model list format");
    }

    modelOptions = data
      .filter((entry) => entry && typeof entry.id === "string")
      .map((entry) => ({
        id: entry.id.trim(),
        label:
          typeof entry.label === "string" && entry.label.trim()
            ? entry.label.trim()
            : entry.id.trim(),
      }));
  } catch (error) {
    console.error("Failed to load model options:", error);
    modelOptions = [];
  }
}

function getActiveSession() {
  return sessions.find((session) => session.id === activeSessionId) ?? null;
}

function populateModelSelect() {
  if (!modelSelect) return;
  modelSelect.innerHTML = "";
  const options = modelOptions.length ? modelOptions : DEFAULT_MODEL_OPTIONS;
  options.forEach((option) => {
    const opt = document.createElement("option");
    opt.value = option.id;
    opt.textContent = option.label;
    modelSelect.appendChild(opt);
  });
}

function handleModelChange(event) {
  const value = typeof event.target.value === "string" ? event.target.value : "";
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  const session = getActiveSession();
  if (!session || session.modelId === trimmed) {
    return;
  }

  ensureModelOptionExists(trimmed);
  touchSession(activeSessionId, { modelId: trimmed });
  updateModelSelectionUI();
}

function ensureModelOptionExists(modelId) {
  if (!modelSelect) return;
  const exists = Array.from(modelSelect.options).some(
    (option) => option.value === modelId,
  );
  if (exists) {
    return;
  }
  const opt = document.createElement("option");
  opt.value = modelId;
  opt.textContent = `Custom (${modelId})`;
  modelSelect.appendChild(opt);
  if (!modelOptions.some((option) => option.id === modelId)) {
    modelOptions.push({ id: modelId, label: `Custom (${modelId})` });
  }
}

function updateModelSelectionUI() {
  if (!modelSelect) return;
  const session = getActiveSession();
  const modelId = session?.modelId ?? DEFAULT_MODEL_ID;
  ensureModelOptionExists(modelId);
  if (modelSelect.value !== modelId) {
    modelSelect.value = modelId;
  }
}
