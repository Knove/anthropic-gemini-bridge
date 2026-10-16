// thought_signature round-trip preservation.
//
// Gemini attaches a `thoughtSignature` to parts (functionCall parts require it
// on every subsequent turn — dropping it is a hard 400). Anthropic carries the
// same blob on `thinking` blocks as `signature`. The two are not positionally
// 1:1, so the bridge keeps a side cache keyed by tool_use id, mirroring the
// thoughtSignatureCacheScope approach in @the-next-ai/ai-gateway.

type SigEntry = { signature: string; at: number };

export class SignatureStore {
  private byToolUseId = new Map<string, SigEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = opts.maxEntries ?? 2000;
  }

  /** Record a signature observed on an outgoing model turn. */
  put(toolUseId: string, signature: string): void {
    if (!toolUseId || !signature) return;
    this.byToolUseId.set(toolUseId, { signature, at: Date.now() });
    this.evict();
  }

  /**
   * Resolve the signature to re-attach to a functionCall part.
   * Priority: explicit value carried on the block itself, then the cache.
   */
  resolve(toolUseId: string, inline?: string | undefined): string | undefined {
    if (inline) return inline;
    const entry = this.byToolUseId.get(toolUseId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.byToolUseId.delete(toolUseId);
      return undefined;
    }
    return entry.signature;
  }

  private evict(): void {
    if (this.byToolUseId.size <= this.maxEntries) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, v] of this.byToolUseId) {
      if (v.at < cutoff) this.byToolUseId.delete(k);
    }
    // Still oversized: drop oldest third.
    if (this.byToolUseId.size > this.maxEntries) {
      const entries = [...this.byToolUseId.entries()].sort(
        (a, b) => a[1].at - b[1].at,
      );
      const drop = Math.ceil(entries.length / 3);
      for (let i = 0; i < drop; i++) this.byToolUseId.delete(entries[i][0]);
    }
  }

  get size(): number {
    return this.byToolUseId.size;
  }
}
