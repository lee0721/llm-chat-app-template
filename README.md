# Cloudflare AI Chat

An LLM-powered chat application built on [Cloudflare Workers](https://developers.cloudflare.com/workers/), [Workers AI](https://developers.cloudflare.com/workers-ai/), Durable Objects, and Vectorize.  It provides an experience similar to ChatGPT where users can open multiple conversation threads, switch among Workers AI models, upload reference documents, and see which snippets were used to ground each answer.

## Highlights

- **Multi-model chat** – switch between 80+ Workers AI models (Llama 3.3, Mistral, Qwen, etc.) from the header dropdown. Each conversation remembers its chosen model.
- **Conversation sidebar** – create, rename, or delete chats; all chat state is persisted in a Durable Object per session.
- **Document ingestion & RAG** – upload text, PDF, or image files. Content is chunked, embedded with Workers AI, and stored in a Vectorize index. Streaming responses list the exact snippets referenced.
- **Attachment status & toasts** – the composer shows upload progress, chunk counts, and warnings when no text is extracted from a file.
- **Error transparency** – explicit messages explain when a model is unavailable or a file contained no readable text.

## Architecture

```
┌──────────┐        ┌──────────────────────┐        ┌─────────────────────┐
│  Browser │──HTTP─▶│ Cloudflare Worker    │──AI──▶ │ Workers AI (LLM/Emb)│
└──────────┘        │  • Routes /api/chat  │        └─────────────────────┘
                     │  • Durable Objects   │                     │
                     │  • Vectorize queries │◀────── embeddings ──┘
                     └────────┬────────────┘
                              │
                       ┌──────▼──────┐
                       │ Durable     │ stores per-session messages,
                       │ Object      │ model selections & metadata
                       └─────────────┘
```

- **Worker** (`src/index.ts`) handles API routes, orchestrates model calls, streaming responses, and document ingestion.
- **Durable Object** (`SessionDurableObject`) keeps chat history and the selected model ID for each session.
- **Vectorize** stores document embeddings for retrieval-augmented responses.
- **Static UI** (`public/`) is delivered via Workers Assets and implements the chat experience.

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account with Workers, Workers AI, Durable Objects, and Vectorize enabled

### Install dependencies

```bash
npm install
```

### Configure Wrangler

Update [`wrangler.jsonc`](wrangler.jsonc) with your account ID and bindings if they differ:

```jsonc
{
  "name": "cloudflare-ai-chat",
  "main": "src/index.ts",
  "durable_objects": { "bindings": [{ "name": "SESSIONS", "class_name": "SessionDurableObject" }] },
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "chat-knowledge" }],
  "ai": { "binding": "AI" }
}
```

Create the necessary Durable Object migration once:

```bash
npx wrangler deploy --migrations
```

Create the Vectorize index if you have not already:

```bash
npx wrangler vectorize create chat-knowledge --dimensions 1024 --metric cosine
```

### Local development

```bash
npm run dev
```

This serves the app at http://localhost:8787 using live Workers AI calls.

### Deploy

```bash
npx wrangler deploy
```

## Usage

1. Open the deployed URL and click **+ New Chat** or select an existing conversation from the sidebar.
2. Choose a model from the **Model** dropdown.  The list comes from [`public/models.json`](public/models.json) and covers the Workers AI catalog; add or remove entries as you see fit.
3. Send messages as usual.  Streaming responses show the snippets retrieved from Vectorize at the start of each answer.
4. Upload documents via the paperclip button.  The status chip reflects progress (`Uploading…`, `Indexed`, or `No text extracted`).  A toast summarizes how many chunks were stored.
5. Use the ✕ icon beside a conversation to delete it (Durable Object state is cleared and the local sidebar updates).

## Document ingestion details

- Text & Markdown files are read as-is.
- PDFs are processed via Workers AI `@cf/pdf/extract-text`.
- Images use a fallback sequence of `@cf/unum/uform-gen2-qwen-500m` then `@cf/llava/llava-1.5-7b-hf`.  If no text can be extracted, the upload is rejected with a descriptive message.
- Plain text chunks are embedded with `@cf/baai/bge-base-en-v1.5` and stored in the Vectorize index.

## Limitations & future ideas

- Image OCR quality depends on open-source vision models; ambiguous or stylized text may require manual transcription.
- Rate limits follow Workers Free (10k Neurons/day).  Consider adding AI Gateway for more control in production scenarios.
- Possible extensions: switch to a stronger external OCR provider, add auth, provide analytics dashboards, or integrate Workflows for long-running jobs.

## Credits

- Inspired by the official Cloudflare [LLM Chat App template](https://github.com/cloudflare/templates/tree/main/llm-chat-app-template).
- UI built from scratch with vanilla HTML/CSS/JS for minimal dependency overhead.

Happy building!
