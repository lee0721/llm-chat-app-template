/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model IDs for Workers AI
// https://developers.cloudflare.com/workers-ai/models/
const DEFAULT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const EMBEDDING_MODEL_ID = "@cf/baai/bge-base-en-v1.5";
const PDF_EXTRACT_MODEL_ID = "@cf/pdf/extract-text";
// Default image-to-text model (adjust to whatever is available in your account)
const OCR_MODEL_ID = "@cf/unum/uform-gen2-qwen-500m";

// Default system prompt
const SYSTEM_PROMPT =
  "You are a helpful, friendly assistant. Provide concise and accurate responses.";
const MAX_HISTORY = 20;
const MAX_CONTEXT_CHUNKS = 4;
const EMBEDDING_MAX_CHARS = 2048;
const DOCUMENT_MAX_CHARS = 50000;
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const MAX_DOC_CHUNKS = 60;
const JSON_HEADERS = { "content-type": "application/json" } as const;

export default {
  /**
   * Main request handler for the Worker
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Handle static assets (frontend)
    if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // API Routes
    if (url.pathname === "/api/history") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        return jsonResponse({ error: "Missing sessionId" }, 400);
      }

      try {
        const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
        const history = await fetchSessionHistory(stub);
        return jsonResponse(history);
      } catch (error) {
        console.error("Failed to load session history:", error);
        return jsonResponse({ error: "Unable to load history" }, 500);
      }
    }

    if (url.pathname === "/api/docs") {
      if (request.method === "POST") {
        return handleDocumentUpload(request, env);
      }

      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/chat") {
      // Handle POST requests for chat
      if (request.method === "POST") {
        return handleChatRequest(request, env, ctx);
      }

      // Method not allowed for other request types
      return new Response("Method not allowed", { status: 405 });
    }

    // Handle 404 for unmatched routes
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    // Parse JSON request body
    const body = await safeJson(request);
    if (!body) {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const message =
      typeof body.message === "string" ? body.message.trim() : "";

    if (!sessionId) {
      return jsonResponse({ error: "Missing sessionId" }, 400);
    }

    if (!message) {
      return jsonResponse({ error: "Message content is required" }, 400);
    }

    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    const historyRecord = await fetchSessionHistory(stub);
    const sessionModelId = selectModelId(
      body.modelId,
      historyRecord.modelId,
      DEFAULT_MODEL_ID,
    );

    const userMessage: ChatMessage = { role: "user", content: message };
    await appendMessage(stub, userMessage, sessionModelId);

    const { promptMessages, snippets } = await buildRetrievalContext(
      env,
      message,
    );
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...promptMessages,
      ...historyRecord.messages,
      userMessage,
    ];

    const response = await env.AI.run(
      sessionModelId as any,
      {
        messages,
        max_tokens: 1024,
      },
      {
        returnRawResponse: true,
        // Uncomment to use AI Gateway
        // gateway: {
        //   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
        //   skipCache: false,      // Set to true to bypass cache
        //   cacheTtl: 3600,        // Cache time-to-live in seconds
        // },
      },
    );

    if (!response.body) {
      return jsonResponse({ error: "Model returned empty response" }, 500);
    }

    const [clientStream, storageStream] = response.body.tee();

    ctx.waitUntil(captureAssistantResponse(storageStream, stub, sessionModelId));

    const outboundStream = prependContextStream(clientStream, snippets);

    // Return streaming response
    return new Response(outboundStream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    console.error("Error processing chat request:", error);
    return new Response(
      JSON.stringify({ error: "Failed to process request" }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}

async function handleDocumentUpload(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    let title = "Untitled document";
    let rawText = "";
    let sourceType: DocumentSourceType = "manual";
    let originalFileName: string | undefined;

    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const titleField = formData.get("title");
      if (typeof titleField === "string" && titleField.trim()) {
        title = titleField.trim();
      }

      const textField = formData.get("text");
      const textFieldValue =
        typeof textField === "string" && textField.trim() ? textField : "";
      if (textFieldValue) {
        rawText = textFieldValue;
      }

      const fileField = formData.get("file");
      if (fileField instanceof File) {
        const extraction = await extractTextFromUpload(fileField, env);
        originalFileName = extraction.originalName ?? fileField.name;
        title = originalFileName || title;
        const combinedContent = [extraction.text, rawText]
          .filter((value) => typeof value === "string" && value.trim())
          .join("\n\n");
        rawText = combinedContent;
        sourceType = extraction.sourceType;
      }
    } else {
      const body = await safeJson(request);
      if (!body) {
        return jsonResponse({ error: "Invalid document payload" }, 400);
      }

      if (typeof body.title === "string" && body.title.trim()) {
        title = body.title.trim();
      }

      if (typeof body.text === "string" && body.text.trim()) {
        rawText = body.text;
      }
    }

    if (typeof request.headers.get("x-source-type") === "string") {
      sourceType = request.headers.get("x-source-type") as DocumentSourceType;
    }

    const cleaned = rawText.replace(/\r\n/g, "\n").trim();
    if (!cleaned) {
      return jsonResponse({ error: "Document content is required" }, 400);
    }

    const limited =
      cleaned.length > DOCUMENT_MAX_CHARS
        ? cleaned.slice(0, DOCUMENT_MAX_CHARS)
        : cleaned;

    const chunks = chunkText(limited)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    if (chunks.length === 0) {
      return jsonResponse({ error: "No textual content found to index" }, 400);
    }

    const docId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const upserts = await generateEmbeddingsForChunks(
      env,
      chunks,
      EMBEDDING_MAX_CHARS,
      docId,
      {
        title,
        sourceType,
        originalFileName,
      },
    );

    await env.VECTORIZE.upsert(upserts);

    return jsonResponse({
      docId,
      title,
      chunks: upserts.length,
      sourceType,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Failed to index document";
    console.error("Error indexing document:", error);
    return jsonResponse({ error: message }, 500);
  }
}

async function captureAssistantResponse(
  stream: ReadableStream<Uint8Array>,
  stub: DurableObjectStub,
  modelId: string,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let fullResponse = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as {
            response?: string;
          };
          if (typeof parsed.response === "string") {
            fullResponse += parsed.response;
          }
        } catch (err) {
          console.error("Failed to parse assistant stream chunk:", err);
        }
      }
    }

    if (buffered) {
      try {
        const parsed = JSON.parse(buffered) as { response?: string };
        if (typeof parsed.response === "string") {
          fullResponse += parsed.response;
        }
      } catch {
        // ignore trailing partial JSON
      }
    }
  } catch (error) {
    console.error("Error reading assistant stream:", error);
  }

  if (!fullResponse) {
    return;
  }

  await appendMessage(stub, { role: "assistant", content: fullResponse }, modelId);
}

async function appendMessage(
  stub: DurableObjectStub,
  message: ChatMessage,
  modelId: string,
): Promise<void> {
  const response = await stub.fetch("https://session/messages", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ message, modelId }),
  });

  if (!response.ok) {
    throw new Error(`Failed to store message: ${response.status}`);
  }
}

async function fetchSessionHistory(
  stub: DurableObjectStub,
): Promise<{
  messages: ChatMessage[];
  modelId?: string;
  createdAt?: string;
  updatedAt?: string;
}> {
  const response = await stub.fetch("https://session/messages");
  if (!response.ok) {
    throw new Error(`Failed to read session history: ${response.status}`);
  }

  const data = (await response.json()) as {
    messages?: ChatMessage[];
    modelId?: string;
    createdAt?: string;
    updatedAt?: string;
  };

  const messages = Array.isArray(data.messages) ? data.messages : [];

  return {
    messages: messages.slice(-MAX_HISTORY),
    modelId: typeof data.modelId === "string" ? data.modelId : undefined,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
}

async function safeJson(request: Request): Promise<any | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

function selectModelId(
  requestedModelId: unknown,
  storedModelId: string | undefined,
  fallbackModelId: string,
): string {
  if (typeof requestedModelId === "string" && requestedModelId.trim()) {
    return requestedModelId.trim();
  }

  if (typeof storedModelId === "string" && storedModelId.trim()) {
    return storedModelId.trim();
  }

  return fallbackModelId;
}

async function buildRetrievalContext(
  env: Env,
  question: string,
): Promise<{
  promptMessages: ChatMessage[];
  snippets: ContextSnippet[];
}> {
  const trimmed = question.trim();
  if (!trimmed) {
    return { promptMessages: [], snippets: [] };
  }

  try {
    const embedding = await embedText(env, trimmed);
    if (!embedding) {
      return { promptMessages: [], snippets: [] };
    }

    const queryResult = await env.VECTORIZE.query({
      vector: embedding,
      topK: MAX_CONTEXT_CHUNKS,
      returnMetadata: true,
    });

    const contexts: ContextSnippet[] = [];
    const matches = queryResult?.matches ?? [];

    for (const match of matches) {
      if (!match) {
        continue;
      }

      const metadata = match.metadata as {
        text?: string;
        title?: string;
        chunkIndex?: number;
      } | undefined;

      const snippet =
        typeof metadata?.text === "string" ? metadata.text.trim() : "";

      if (!snippet) {
        continue;
      }

      contexts.push({
        title:
          typeof metadata?.title === "string" && metadata.title.trim()
            ? metadata.title.trim()
            : undefined,
        text: snippet,
        index:
          typeof metadata?.chunkIndex === "number"
            ? metadata.chunkIndex
            : undefined,
        score: typeof match.score === "number" ? match.score : undefined,
      });

      if (contexts.length >= MAX_CONTEXT_CHUNKS) {
        break;
      }
    }

    if (contexts.length === 0) {
      return { promptMessages: [], snippets: [] };
    }

    const contextBlock = contexts
      .map((context, index) => {
        const headerParts = [`Context ${index + 1}`];
        if (context.title) {
          headerParts.push(`from "${context.title}"`);
        }
        if (typeof context.index === "number") {
          headerParts.push(`(chunk ${context.index + 1})`);
        }

        return `${headerParts.join(" ")}:\n${context.text}`;
      })
      .join("\n\n");

    return {
      promptMessages: [
        {
          role: "system",
          content: `Use the reference material below to answer the user. If none of it is relevant, answer based on your general knowledge.\n\n${contextBlock}`,
        },
      ],
      snippets: contexts,
    };
  } catch (error) {
    console.error("Failed to build retrieval context:", error);
    return { promptMessages: [], snippets: [] };
  }
}

async function embedText(env: Env, text: string): Promise<number[] | null> {
  const truncated =
    text.length > EMBEDDING_MAX_CHARS ? text.slice(0, EMBEDDING_MAX_CHARS) : text;

  try {
    const result = (await env.AI.run(EMBEDDING_MODEL_ID, {
      text: [truncated],
    })) as EmbeddingResponse;

    const embedding = result?.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      return null;
    }

    return embedding;
  } catch (error) {
    console.error("Failed to generate embedding:", error);
    return null;
  }
}

async function generateEmbeddingsForChunks(
  env: Env,
  chunks: string[],
  maxChunkLength: number,
  docId: string,
  metadata: {
    title: string;
    sourceType: DocumentSourceType;
    originalFileName?: string;
  },
): Promise<
  Array<{
    id: string;
    vector: number[];
    metadata: Record<string, unknown>;
  }>
> {
  const truncatedChunks = chunks.map((chunk) =>
    chunk.length > maxChunkLength ? chunk.slice(0, maxChunkLength) : chunk,
  );

  const embeddings = (await env.AI.run(EMBEDDING_MODEL_ID, {
    text: truncatedChunks,
  })) as EmbeddingResponse;

  const embeddingData = embeddings?.data ?? [];
  if (embeddingData.length !== truncatedChunks.length) {
    throw new Error(
      `Embedding response length ${embeddingData.length} did not match chunk count ${truncatedChunks.length}`,
    );
  }

  const upserts: Array<{
    id: string;
    vector: number[];
    metadata: Record<string, unknown>;
  }> = [];

  truncatedChunks.forEach((chunk, index) => {
    const embedding = embeddingData[index]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      console.warn(
        `Skipping chunk ${index} for doc ${docId}: embedding missing from model ${EMBEDDING_MODEL_ID}`,
      );
      return;
    }

    upserts.push({
      id: `${docId}#${index}`,
      vector: embedding,
      metadata: {
        text: chunk,
        title: metadata.title,
        docId,
        chunkIndex: index,
        uploadedAt: new Date().toISOString(),
        sourceType: metadata.sourceType,
        originalFileName: metadata.originalFileName,
      },
    });
  });

  if (!upserts.length) {
    throw new Error(
      `Embedding model ${EMBEDDING_MODEL_ID} returned no vectors for provided content.`,
    );
  }

  return upserts;
}

function chunkText(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): string[] {
  const normalized = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  const step = Math.max(1, chunkSize - overlap);
  let index = 0;

  while (index < normalized.length && chunks.length < MAX_DOC_CHUNKS) {
    const slice = normalized.slice(index, index + chunkSize).trim();
    if (slice.length > 0) {
      chunks.push(slice);
    }

    if (index + chunkSize >= normalized.length) {
      break;
    }

    index += step;
  }

  return chunks;
}

function prependContextStream(
  stream: ReadableStream<Uint8Array>,
  snippets: ContextSnippet[],
): ReadableStream<Uint8Array> {
  if (!snippets.length) {
    return stream;
  }

  const encoder = new TextEncoder();
  const payload = JSON.stringify({
    context: snippets.map((snippet) => ({
      title: snippet.title,
      text: snippet.text,
      index: snippet.index,
      score: snippet.score,
    })),
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${payload}\n`));
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          if (value) {
            controller.enqueue(value);
          }
        }
      } catch (error) {
        console.error("Error streaming AI response:", error);
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

interface ContextSnippet {
  title?: string;
  text: string;
  index?: number;
  score?: number;
}

interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
}

type DocumentSourceType = "manual" | "text-file" | "pdf" | "image";

interface ExtractedDocument {
  text: string;
  sourceType: DocumentSourceType;
  originalName?: string;
}

interface PdfExtractionResponse {
  text?: string;
  pages?: Array<{ text?: string }>;
}

interface OcrExtractionResponse {
  text?: string;
  data?: {
    text?: string;
  };
}

async function extractTextFromUpload(
  file: File,
  env: Env,
): Promise<ExtractedDocument> {
  const name = file.name ?? "document";
  const lowerName = name.toLowerCase();
  const mime = file.type.toLowerCase();

  if (
    mime.startsWith("text/") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".csv")
  ) {
    const text = await file.text();
    return {
      text,
      sourceType: "text-file",
      originalName: name,
    };
  }

  if (mime === "application/pdf" || lowerName.endsWith(".pdf")) {
    const rawText = await extractTextFromPdf(file, env);
    return {
      text: rawText,
      sourceType: "pdf",
      originalName: name,
    };
  }

  if (mime.startsWith("image/")) {
    const rawText = await extractTextFromImage(file, env);
    return {
      text: rawText,
      sourceType: "image",
      originalName: name,
    };
  }

  throw new Error(`Unsupported file type "${mime || lowerName}"`);
}

async function extractTextFromPdf(file: File, env: Env): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  try {
    const result = (await env.AI.run(PDF_EXTRACT_MODEL_ID as any, {
      pdf: [...bytes],
    })) as PdfExtractionResponse;

    const segments: string[] = [];
    if (typeof result?.text === "string") {
      segments.push(result.text);
    }
    if (Array.isArray(result?.pages)) {
      for (const page of result.pages) {
        if (typeof page?.text === "string") {
          segments.push(page.text);
        }
      }
    }

    const combined = segments.join("\n\n").trim();
    if (combined) {
      return combined;
    }

    throw new Error("PDF extraction returned empty content");
  } catch (error) {
    console.error("PDF extraction failed:", error);
    if (
      error instanceof Error &&
      /No such model/i.test(error.message ?? "")
    ) {
      throw new Error(
        "PDF extraction requires enabling @cf/pdf/extract-text in Workers AI.",
      );
    }
    throw new Error("Unable to extract text from the PDF file.");
  }
}

async function extractTextFromImage(file: File, env: Env): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  try {
    const payload: Record<string, unknown> = {
      image: [...bytes],
    };

    if (OCR_MODEL_ID.includes("llava")) {
      payload.prompt =
        "Extract the textual content from this image. If there is no readable text, reply with a short description.";
    } else {
      payload.detect_orientation = true;
    }

    const result = (await env.AI.run(OCR_MODEL_ID as any, payload)) as
      | OcrExtractionResponse
      | {
          description?: string;
          caption?: string;
          text?: string;
          output?: string;
        }
      | string;

    const textCandidates: string[] = [];

    if (typeof result === "string") {
      textCandidates.push(result);
    } else if (result) {
      if (typeof (result as any).text === "string") {
        textCandidates.push((result as any).text);
      }
      const description = (result as any).description ?? (result as any).caption;
      if (typeof description === "string") {
        textCandidates.push(description);
      }
      if (typeof (result as any).output === "string") {
        textCandidates.push((result as any).output);
      }
      if (typeof (result as any)?.data?.text === "string") {
        textCandidates.push((result as any).data.text);
      }
    }

    const combined = textCandidates
      .map((snippet) => snippet.trim())
      .filter(Boolean)
      .join("\n");

    if (combined) {
      return combined;
    }

    throw new Error("Image model returned empty content");
  } catch (error) {
    console.error("Image OCR failed:", error);
    if (
      error instanceof Error &&
      /No such model/i.test(error.message ?? "")
    ) {
      throw new Error(
        `Image-to-text model ${OCR_MODEL_ID} is not available on this account. Choose another model from Workers AI Models or adjust the config.`,
      );
    }
    throw new Error("Unable to extract text from the image with the selected model.");
  }
}

interface StoredSessionRecord {
  messages: ChatMessage[];
  modelId?: string;
  createdAt?: string;
  updatedAt?: string;
}

const SESSION_STORAGE_KEY = "session";

export class SessionDurableObject {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/messages") {
        const session = await this.getSessionRecord();

      return new Response(
        JSON.stringify({
          messages: session.messages,
          modelId: session.modelId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }),
        { headers: JSON_HEADERS },
      );
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      const body = await safeJson(request);
      const message = body?.message as ChatMessage | undefined;
      const modelId =
        typeof body?.modelId === "string" && body.modelId.trim()
          ? (body.modelId as string).trim()
          : undefined;

      if (
        !message ||
        (message.role !== "assistant" && message.role !== "user") ||
        typeof message.content !== "string"
      ) {
        return jsonResponse({ error: "Invalid message payload" }, 400);
      }

      await this.persistMessage(message, modelId);
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }

  private async getSessionRecord(): Promise<StoredSessionRecord> {
    let stored =
      (await this.state.storage.get<StoredSessionRecord | ChatMessage[]>(
        SESSION_STORAGE_KEY,
      )) ?? null;

    if (!stored) {
      const legacyMessages =
        (await this.state.storage.get<ChatMessage[]>("messages")) ?? null;
      if (legacyMessages) {
        await this.state.storage.delete("messages");
        stored = legacyMessages;
      }
    }

    if (!stored) {
      return {
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    if (Array.isArray(stored)) {
      return {
        messages: stored,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      messages: Array.isArray(stored.messages) ? stored.messages : [],
      modelId:
        typeof stored.modelId === "string" ? stored.modelId.trim() : undefined,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }

  private async persistMessage(
    message: ChatMessage,
    modelId?: string,
  ): Promise<void> {
    const session = await this.getSessionRecord();
    session.messages.push(message);
    session.messages = session.messages.slice(-MAX_HISTORY);
    if (modelId) {
      session.modelId = modelId;
    }
    const now = new Date().toISOString();
    session.updatedAt = now;
    if (!session.createdAt) {
      session.createdAt = now;
    }
    await this.state.storage.put(SESSION_STORAGE_KEY, session);
  }
}
