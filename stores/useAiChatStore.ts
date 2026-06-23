'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { useComponentsStore } from '@/stores/useComponentsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { usePagesStore } from '@/stores/usePagesStore';

/** A tool the agent invoked during an assistant turn, shown as a status line. */
export interface ChatToolCall {
  id: string;
  name: string;
  ok?: boolean;
}

/** A preview of an image the user attached to a message. */
export interface ChatImage {
  id: string;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: ChatToolCall[];
  images?: ChatImage[];
  /** True for the auto-generated visual self-review turn (rendered compactly). */
  review?: boolean;
}

type ChatStatus = 'idle' | 'streaming';

interface AiChatState {
  isOpen: boolean;
  messages: ChatMessage[];
  status: ChatStatus;
  error: string | null;
  /** When on, the agent screenshots its work and critiques/fixes it automatically. */
  autoReview: boolean;
  /** Chosen model id, or null to use the server-resolved default. */
  model: string | null;
}

/** A layer the user explicitly attached as context for a message. */
export interface SelectedLayerRef {
  id: string;
  name: string;
}

/** An image the user attached to a message, ready to send to the model. */
export interface ImageAttachment {
  /** MIME type, e.g. "image/png". */
  mediaType: string;
  /** Base64-encoded bytes (no data: URL prefix). */
  data: string;
  /** Full data URL, used only for local preview. */
  dataUrl: string;
}

/** A page, collection, or layer the user referenced via @-mention. */
export interface Mention {
  type: 'page' | 'collection' | 'layer';
  id: string;
  label: string;
}

/** Extra context attached to a single message from the composer. */
export interface MessageAttachment {
  selectedLayers?: SelectedLayerRef[];
  images?: ImageAttachment[];
  mentions?: Mention[];
  referenceUrls?: string[];
}

interface AiChatActions {
  open: () => void;
  close: () => void;
  toggle: () => void;
  clear: () => void;
  stop: () => void;
  setAutoReview: (value: boolean) => void;
  setModel: (model: string | null) => void;
  sendMessage: (text: string, attachment?: MessageAttachment) => Promise<void>;
}

type AiChatStore = AiChatState & AiChatActions;

/** Server-sent runtime events, mirrored from lib/agent/runtime.ts RuntimeEvent. */
type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean }
  | { type: 'done'; stopReason: string | null }
  | { type: 'error'; message: string };

let abortController: AbortController | null = null;

/** How many automatic review passes to run after a user turn. */
const MAX_REVIEW_DEPTH = 1;

/** Instruction sent alongside the screenshot during an auto-review pass. */
const REVIEW_PROMPT =
  'Here is a screenshot of the current page after your changes. Critically review it against my request and good design principles — layout, spacing, alignment, contrast, overflow, readability, and visual hierarchy. If anything looks wrong or low quality, fix it with the tools. If it already looks good, just briefly confirm you are done (do not make changes for the sake of it).';

const READONLY_TOOL_PREFIXES = ['get_', 'list_', 'export_', 'search_'];

/** Tools that change data/settings but not the current page's visual layout. */
const NON_VISUAL_TOOLS = new Set([
  'publish',
  'update_page_settings',
  'update_page',
  'create_page',
  'update_form_settings',
  'update_form_submission_status',
  'add_redirect',
  'update_redirect',
  'delete_redirect',
  'set_setting',
  'set_translation',
  'set_rich_text_translation',
  'batch_set_translations',
  'create_locale',
]);

/** Whether a tool call likely changed how the current page looks. */
function isVisualMutation(name: string): boolean {
  if (READONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (NON_VISUAL_TOOLS.has(name)) return false;
  return true;
}

/** Capture the current page's layers as a base64 image for the agent to review. */
async function captureCurrentPageImage(): Promise<ImageAttachment | null> {
  const pageId = useEditorStore.getState().currentPageId;
  if (!pageId) return null;
  const layers = usePagesStore.getState().draftsByPageId[pageId]?.layers;
  if (!layers || layers.length === 0) return null;

  try {
    const { captureLayersImage } = await import('@/lib/client/thumbnail-capture');
    const components = useComponentsStore.getState().components;
    const shot = await captureLayersImage(layers, components);
    if (!shot) return null;
    return { mediaType: shot.mediaType, data: shot.data, dataUrl: shot.dataUrl };
  } catch (error) {
    console.error('Visual review capture failed:', error);
    return null;
  }
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useAiChatStore = create<AiChatStore>()(
  persist(
    (set, get) => {
      /**
   * Stream a single agent turn into a new assistant message. After a turn that
   * makes visual edits, optionally captures the page and recurses for one
   * automatic self-review pass (bounded by MAX_REVIEW_DEPTH).
   */
      const runTurn = async (
        text: string,
        attachment: MessageAttachment | undefined,
        reviewDepth: number,
      ): Promise<void> => {
        const trimmed = text.trim();
        const images = attachment?.images ?? [];
        if (!trimmed && images.length === 0) return;

        const isReview = reviewDepth > 0;
        const promptText = trimmed || 'Use the attached image(s) as a reference for what to build.';

        const userMessage: ChatMessage = {
          id: newId(),
          role: 'user',
          text: promptText,
          toolCalls: [],
          images: images.length > 0 ? images.map((img) => ({ id: newId(), dataUrl: img.dataUrl })) : undefined,
          review: isReview || undefined,
        };
        const assistantMessage: ChatMessage = { id: newId(), role: 'assistant', text: '', toolCalls: [] };

        // History: prior turns as text. Assistant turns that only ran tools still
        // contribute a placeholder so user/assistant roles keep alternating.
        const history = get()
          .messages.map((message) => ({
            role: message.role,
            content:
          message.text.trim() ||
          (message.role === 'assistant' && message.toolCalls.length > 0 ? '(made the requested edits)' : ''),
          }))
          .filter((message) => message.content.length > 0);

        set((state) => ({ messages: [...state.messages, userMessage, assistantMessage], error: null }));

        const editor = useEditorStore.getState();
        abortController = new AbortController();
        const signal = abortController.signal;

        const userContent =
      images.length > 0
        ? [
          { type: 'text' as const, text: promptText },
          ...images.map((img) => ({ type: 'image' as const, mediaType: img.mediaType, data: img.data })),
        ]
        : promptText;

        const patchAssistant = (updater: (message: ChatMessage) => ChatMessage) => {
          set((state) => ({
            messages: state.messages.map((message) =>
              message.id === assistantMessage.id ? updater(message) : message,
            ),
          }));
        };

        try {
          const response = await fetch('/ycode/api/ai/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: [...history, { role: 'user', content: userContent }],
              pageId: editor.currentPageId,
              selectedLayers: attachment?.selectedLayers ?? [],
              mentions: attachment?.mentions ?? [],
              referenceUrls: attachment?.referenceUrls ?? [],
              model: get().model ?? undefined,
            }),
            signal,
          });

          if (!response.ok || !response.body) {
            const message = await safeErrorMessage(response);
            patchAssistant((m) => ({ ...m, text: m.text || message }));
            set({ error: message });
            return;
          }

          await consumeSse(response.body, (event) => applyEvent(event, patchAssistant, set));
        } catch (error) {
          if ((error as Error).name === 'AbortError') return;
          set({ error: error instanceof Error ? error.message : 'Something went wrong' });
          return;
        }

        // Visual self-review: if this turn changed the page, screenshot it and let
        // the agent critique and fix its own work (one pass).
        if (get().autoReview && reviewDepth < MAX_REVIEW_DEPTH && !signal.aborted) {
          const completed = get().messages.find((m) => m.id === assistantMessage.id);
          const changedVisuals = completed?.toolCalls.some((call) => isVisualMutation(call.name)) ?? false;
          if (changedVisuals) {
            const shot = await captureCurrentPageImage();
            if (shot && !signal.aborted) {
              await runTurn(REVIEW_PROMPT, { images: [shot] }, reviewDepth + 1);
            }
          }
        }
      };

      return {
        isOpen: false,
        messages: [],
        status: 'idle',
        error: null,
        autoReview: true,
        model: null,

        open: () => set({ isOpen: true }),
        close: () => set({ isOpen: false }),
        toggle: () => set((state) => ({ isOpen: !state.isOpen })),

        setAutoReview: (value: boolean) => set({ autoReview: value }),
        setModel: (model: string | null) => set({ model }),

        clear: () => {
          get().stop();
          set({ messages: [], error: null });
        },

        stop: () => {
          abortController?.abort();
          abortController = null;
          set({ status: 'idle' });
        },

        sendMessage: async (text: string, attachment?: MessageAttachment) => {
          const hasContent = text.trim().length > 0 || (attachment?.images?.length ?? 0) > 0;
          if (!hasContent || get().status !== 'idle') return;

          set({ status: 'streaming', error: null });
          try {
            await runTurn(text, attachment, 0);
          } finally {
            abortController = null;
            set({ status: 'idle' });
          }
        },
      };
    },
    {
      name: 'ycode-ai-chat',
      version: 1,
      storage: createJSONStorage(() =>
        typeof window !== 'undefined'
          ? window.localStorage
          : { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      ),
      // Persist only the durable, lightweight bits. Image data and per-turn revert
      // checkpoints are intentionally dropped to stay under localStorage quota.
      partialize: (state) => ({
        isOpen: state.isOpen,
        autoReview: state.autoReview,
        model: state.model,
        messages: state.messages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          toolCalls: message.toolCalls,
          review: message.review,
        })),
      }),
    },
  ),
);

function applyEvent(
  event: RuntimeEvent,
  patchAssistant: (updater: (message: ChatMessage) => ChatMessage) => void,
  set: (partial: Partial<AiChatState>) => void,
): void {
  switch (event.type) {
    case 'text':
      patchAssistant((m) => ({ ...m, text: m.text + event.text }));
      break;
    case 'tool_call':
      patchAssistant((m) => ({ ...m, toolCalls: [...m.toolCalls, { id: event.id, name: event.name }] }));
      break;
    case 'tool_result':
      patchAssistant((m) => ({
        ...m,
        toolCalls: m.toolCalls.map((call) => (call.id === event.id ? { ...call, ok: event.ok } : call)),
      }));
      break;
    case 'error':
      set({ error: event.message });
      break;
    case 'done':
    default:
      break;
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: RuntimeEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';

    for (const chunk of chunks) {
      const line = chunk.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onEvent(JSON.parse(payload) as RuntimeEvent);
      } catch {
        // Ignore malformed frames.
      }
    }
  }
}

async function safeErrorMessage(response: Response): Promise<string> {
  try {
    const data = await response.json();
    return typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}
