import { createFileRoute } from '@tanstack/react-router';
import { chat, toServerSentEventsResponse } from '@tanstack/ai';
import { createOllamaChat } from '@tanstack/ai-ollama';
import { fetchVideoByVideoIdService } from '#/lib/services/videos';
import { prepareChatPrompt } from '#/lib/services/learning';
import { webSearchTool } from '#/lib/services/chat-tools';
import { OLLAMA_HOST, OLLAMA_CHAT_MODEL as CHAT_MODEL } from '#/lib/env';

// Streaming chat endpoint (TanStack AI migration).
//
// The endpoint produces Server-Sent Events in AG-UI format:
//   data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"...","delta":"..."}\n\n
//   ...
//   data: [DONE]\n\n
//
// Retrieval (BM25 top-k + query rewriting + contextual retrieval) is shared
// with the non-streaming `askAboutVideoService` via `prepareChatPrompt`.
//
// Ollama host: the TanStack AI Ollama adapter talks to the native Ollama HTTP
// API (not the OpenAI-compat `/v1` endpoint). Our existing env var points at
// `.../v1`, so we strip the suffix here for backward compatibility with any
// existing `.env` files.

// Client-side message shape. `toolCalls` on an assistant message carries
// the tool invocations + their results from that turn — the server
// expands these into proper `role: 'tool'` message entries so the model
// maintains agentic continuity across turns (knows it already searched
// for X, etc.) instead of losing its tool-use history every message.
type ClientToolCall = {
  id: string;
  name: string;
  input: unknown | null;
  result: string | null;
  status: 'running' | 'done';
};
type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ClientToolCall[];
};

type ModelMessage = {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  toolCallId?: string;
};

// Expand the client's (user/assistant + inline toolCalls) history into the
// proper ModelMessage sequence the LLM's agent loop expects:
//   user       → { role: 'user', content }
//   assistant  → if toolCalls: { role: 'assistant', toolCalls }, then one
//                { role: 'tool', toolCallId, content: result } per call,
//                then (if there's also text) { role: 'assistant', content }
//   assistant  → otherwise just { role: 'assistant', content }
// Preserves conversation + tool-use continuity across turns.
function expandHistoryForModel(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
      continue;
    }
    // assistant
    const completedCalls = (msg.toolCalls ?? []).filter((tc) => tc.status === 'done');
    if (completedCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: null,
        toolCalls: completedCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: tc.input != null ? JSON.stringify(tc.input) : '{}',
          },
        })),
      });
      for (const tc of completedCalls) {
        if (tc.result !== null) {
          out.push({
            role: 'tool',
            toolCallId: tc.id,
            content: tc.result,
          });
        }
      }
    }
    if (msg.content && msg.content.trim().length > 0) {
      out.push({ role: 'assistant', content: msg.content });
    }
  }
  return out;
}

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { videoId?: string; messages?: ChatMessage[] };
        try {
          body = await request.json();
        } catch {
          return new Response('Invalid JSON body', { status: 400 });
        }

        if (!body.videoId || !Array.isArray(body.messages)) {
          return new Response('videoId and messages required', { status: 400 });
        }

        const video = await fetchVideoByVideoIdService(body.videoId);
        if (!video) {
          return new Response('Video not found', { status: 404 });
        }
        if (video.summaryStatus !== 'generated') {
          return new Response('Summary not ready', { status: 409 });
        }

        const { system, retrievedCount } = await prepareChatPrompt(video, body.messages);
        // Expand the client's (user/assistant + inline toolCalls) history
        // into proper ModelMessage sequences so the agent loop sees its
        // own prior tool calls/results and maintains continuity.
        const expanded = expandHistoryForModel(body.messages);
        const toolCallCount = expanded.filter((m) => m.role === 'tool').length;
        console.log(
          `[${new Date().toISOString().slice(11, 23)}] [chat ${body.videoId}] → streaming response (tanstack-ai)`,
          {
            retrievedChunks: retrievedCount,
            messages: body.messages.length,
            expandedMessages: expanded.length,
            priorToolResults: toolCallCount,
          },
        );

        const adapter = createOllamaChat(CHAT_MODEL, OLLAMA_HOST);
        // Workaround: @tanstack/ai-ollama@0.6.6 silently drops
        // `systemPrompts` in its chatStream implementation. Ollama
        // natively accepts `{ role: 'system', ... }` as the first message.
        const messagesWithSystem: ModelMessage[] = [
          { role: 'system', content: system },
          ...expanded,
        ];
        const stream = chat({
          adapter,
          // `as never` because TanStack AI's ConstrainedModelMessage union
          // excludes 'system' role, but the Ollama adapter passes role
          // straight through and Ollama accepts it.
          messages: messagesWithSystem as never,
          // Agent loop: model can call `web_search(query)` when the
          // retrieved transcript passages don't answer the question.
          // Execution happens server-side; tool events stream as
          // TOOL_CALL_* SSE frames (ignored by the current client, which
          // only renders TEXT_MESSAGE_CONTENT deltas — the model's
          // natural-language response after the tool runs shows through).
          tools: [webSearchTool],
        });

        return toServerSentEventsResponse(stream);
      },
    },
  },
});
