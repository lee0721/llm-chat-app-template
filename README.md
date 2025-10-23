# LLM Chat Application Template

A simple, ready-to-deploy chat application template powered by Cloudflare Workers AI. This template provides a clean starting point for building AI chat applications with streaming responses.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/cloudflare-ai-chat)

<!-- dash-content-start -->

## Demo

This template demonstrates how to build an AI-powered chat interface using Cloudflare Workers AI with streaming responses. It features:

- Real-time streaming of AI responses using Server-Sent Events (SSE)
- Easy customization of models and system prompts
- Support for AI Gateway integration
- Clean, responsive UI that works on mobile and desktop

## Features

- 💬 ChatGPT-inspired, responsive chat interface with dark theme
- ⚡ Server-Sent Events (SSE) for streaming responses
- 🧠 Powered by Cloudflare Workers AI LLMs
- 🛠️ Built with TypeScript and Cloudflare Workers
- 📱 Mobile-friendly design
- 🗂 Conversation history sidebar with quick session switching
- 📎 Inline knowledge uploads with previews (text, PDF, image OCR)
- 📚 Bring-your-own knowledge base via Cloudflare Vectorize
- 🔄 Maintains chat history on the client
- 🔎 Built-in Observability logging
<!-- dash-content-end -->

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or newer)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- A Cloudflare account with Workers AI access
- Workers AI models enabled for:
  - `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (chat)
  - `@cf/baai/bge-base-en-v1.5` (embeddings)
  - `@cf/pdf/extract-text` (PDF text extraction)
  - `@cf/tesseract-ocr` (image OCR)
- A [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) index (the sample configuration expects an index named `chat-knowledge`)

### Installation

1. Clone this repository:

   ```bash
   git clone https://github.com/cloudflare/templates.git
   cd templates/llm-chat-app
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Generate Worker type definitions:
   ```bash
   npm run cf-typegen
   ```

### Development

Start a local development server:

```bash
npm run dev
```

This will start a local server at http://localhost:8787.

Note: Using Workers AI accesses your Cloudflare account even during local development, which will incur usage charges.

### Deployment

Deploy to Cloudflare Workers:

```bash
npx wrangler deploy --migrations  # first deploy to register Durable Object
npm run deploy
```

### Monitor

View real-time logs associated with any deployed Worker:

```bash
npm wrangler tail
```

## Project Structure

```
/
├── public/             # Static assets
│   ├── index.html      # Chat UI HTML
│   └── chat.js         # Chat UI frontend script
├── src/
│   ├── index.ts        # Main Worker entry point
│   └── types.ts        # TypeScript type definitions
├── test/               # Test files
├── wrangler.jsonc      # Cloudflare Worker configuration
├── tsconfig.json       # TypeScript configuration
└── README.md           # This documentation
```

## How It Works

### Backend

The backend is built with Cloudflare Workers and uses the Workers AI platform to generate responses. The main components are:

1. **API Endpoint** (`/api/chat`): Accepts POST requests with chat messages and streams responses
2. **Streaming**: Uses Server-Sent Events (SSE) for real-time streaming of AI responses
3. **Workers AI Binding**: Connects to Cloudflare's AI service via the Workers AI binding
4. **Durable Object Memory**: Persists per-session chat history so conversations remain contextual
5. **Retrieval-Augmented Generation**: Embeds uploaded documents with `@cf/baai/bge-base-en-v1.5`, stores vectors in Cloudflare Vectorize, and prepends the most relevant snippets to each model call

### Frontend

The frontend is a simple HTML/CSS/JavaScript application that:

1. Presents a chat interface
2. Sends user messages to the API
3. Processes streaming responses in real-time
4. Maintains chat history on the client side
5. Lets users upload or paste documents and shows which snippets were used to ground the latest answer
6. Surfaces upload confirmations inline so the conversation stays in context

## Knowledge Grounding

- Upload reference material with `POST /api/docs` using raw text or files. The Worker will:
  - Accept `.txt`, `.md`, `.json`, `.csv`, and similar text files directly.
  - Run `@cf/pdf/extract-text` against uploaded PDFs.
  - Run `@cf/tesseract-ocr` against PNG/JPG images to pull out text.
- After extraction the content is chunked, embedded, and stored in the configured Vectorize index.
- When chatting, the Worker embeds each question, retrieves the top matches from Vectorize, and streams the context list to the client before the model's tokens arrive.
- Each assistant response in the chat lists the snippets it grounded on, so users can verify provenance without leaving the conversation.

## Model Selection

- Use the **Model** dropdown in the top-right corner to pick which Workers AI model powers the current conversation. Each new chat starts with Llama 3.3 70B (fast) by default.
- The choice is remembered per conversation and synced across reloads. Switching to another chat automatically restores its saved model.
- The dropdown is populated from `public/models.json` (currently mirroring the 80+ Workers AI models). Add or modify entries there to control what appears, or type/load a custom ID to fall back to the “Custom” option.

### Setting up Vectorize

1. Create an index (for example via the CLI):

   ```bash
   npx wrangler vectorize create chat-knowledge --dimensions 768 --metric cosine
   ```

2. Ensure the index name matches the binding in `wrangler.jsonc`.

## Customization

### Changing the Model

To use a different AI model, update the `MODEL_ID` constant in `src/index.ts`. You can find available models in the [Cloudflare Workers AI documentation](https://developers.cloudflare.com/workers-ai/models/).

### Using AI Gateway

The template includes commented code for AI Gateway integration, which provides additional capabilities like rate limiting, caching, and analytics.

To enable AI Gateway:

1. [Create an AI Gateway](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway) in your Cloudflare dashboard
2. Uncomment the gateway configuration in `src/index.ts`
3. Replace `YOUR_GATEWAY_ID` with your actual AI Gateway ID
4. Configure other gateway options as needed:
   - `skipCache`: Set to `true` to bypass gateway caching
   - `cacheTtl`: Set the cache time-to-live in seconds

Learn more about [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

### Modifying the System Prompt

The default system prompt can be changed by updating the `SYSTEM_PROMPT` constant in `src/index.ts`.

### Styling

The UI styling is contained in the `<style>` section of `public/index.html`. You can modify the CSS variables at the top to quickly change the color scheme.

## Resources

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare Workers AI Documentation](https://developers.cloudflare.com/workers-ai/)
- [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)
