/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
  /**
   * Binding for the Workers AI API.
   */
  AI: Ai;

  /**
   * Binding for static assets.
   */
  ASSETS: { fetch: (request: Request) => Promise<Response> };

  /**
   * Durable Object namespace for storing chat session history.
   */
  SESSIONS: DurableObjectNamespace;

  /**
   * Vectorize index for document retrieval.
   */
  VECTORIZE: VectorizeIndex;
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface VectorizeMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface VectorizeQueryResponse {
  matches?: VectorizeMatch[];
}

export interface VectorizeIndex {
  query(request: {
    vector: number[];
    topK?: number;
    returnMetadata?: boolean;
  }): Promise<VectorizeQueryResponse>;

  upsert(
    vectors: Array<{
      id: string;
      vector: number[];
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<unknown>;
}
