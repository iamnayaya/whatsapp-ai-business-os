import type { GeminiFunctionDeclaration } from './client';

/**
 * The interface the SalesAgent depends on. The real implementation is
 * GeminiClient (from `./client`); tests inject a fake that never hits the
 * network. This keeps the agent loop decoupled from the SDK.
 */
export interface GeminiLike {
  generate(opts: {
    contents: GeminiTurn[];
    systemInstruction: string;
    tools: GeminiFunctionDeclaration[];
  }): Promise<GeminiResult>;
}

export interface GeminiTurn {
  role: 'user' | 'model';
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
  >;
}

export interface GeminiResult {
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

export type { GeminiFunctionDeclaration };

// Re-export the real client + its error so consumers have one import path.
export { GeminiClient, GeminiApiError, isGeminiError, geminiErrorMessage } from './client';