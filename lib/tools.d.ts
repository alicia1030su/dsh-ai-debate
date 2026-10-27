/**
 * The nine agent tools.
 *
 * Each tool is a thin, honest wrapper: it validates its arguments, calls the
 * pipeline, and returns a JSON object that also renders as a readable card. No
 * tool decides policy on its own — that lives in `safety.ts` and `publisher.ts`
 * so a prompt-injection attempt cannot talk a tool into loosening a rule.
 */
import type { PluginContext, ToolDefinition } from './host.js';
import { type Runtime } from './runtime.js';
/** Build every tool definition. */
export declare function buildTools(runtime: Runtime, ctx: PluginContext): readonly ToolDefinition[];
//# sourceMappingURL=tools.d.ts.map