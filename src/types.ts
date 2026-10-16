// Wire types for the two protocols, trimmed to the fields the bridge maps.

// ---------- Anthropic Messages ----------

export type AnthropicTextBlock = { type: "text"; text: string };
export type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature: string;
};
export type AnthropicRedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};
export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicMessageRequest = {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?:
    | { type: "auto" }
    | { type: "any" }
    | { type: "none" }
    | { type: "tool"; name: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  thinking?: {
    type?: "enabled" | "adaptive" | "disabled" | "between_tools";
    budget_tokens?: number;
  };
  output_config?: {
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
  };
};

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicMessageResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
};

// ---------- Gemini generateContent ----------

export type GeminiTextPart = {
  text: string;
  thought?: boolean;
  thoughtSignature?: string;
};
export type GeminiFunctionCallPart = {
  functionCall: { id?: string; name: string; args: Record<string, unknown> };
  thoughtSignature?: string;
};
export type GeminiFunctionResponsePart = {
  functionResponse: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
};
export type GeminiThoughtPart = {
  thought: true;
  thoughtSignature: string;
};
export type GeminiPart =
  | GeminiTextPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiThoughtPart;

export type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

export type GeminiRequest = {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  tools?: {
    functionDeclarations: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }[];
  }[];
  toolConfig?: {
    functionCallingConfig: {
      mode: "AUTO" | "ANY" | "NONE";
      allowedFunctionNames?: string[];
    };
  };
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
    candidateCount?: number;
    thinkingConfig?: {
      thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
      thinkingBudget?: number;
    };
  };
};

export type GeminiCandidate = {
  content: { role: "model"; parts: GeminiPart[] };
  finishReason?: string;
  finishMessage?: string;
  index?: number;
};

export type GeminiResponse = {
  candidates: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    promptTokensDetails?: { modality: string; tokenCount: number }[];
    candidatesTokensDetails?: { modality: string; tokenCount: number }[];
  };
  modelVersion?: string;
  responseId?: string;
};
