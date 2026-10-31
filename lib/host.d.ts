/**
 * Minimal structural types for the Host services this plugin uses.
 *
 * They are declared here rather than imported from `@deepseek-ai/dsh-*` so the
 * package compiles and packs without depending on a specific Harness build,
 * while still being exact about what is called. Anything not declared here is
 * not used.
 */
/** A content block the chat can render. */
export type ContentBlock = {
    readonly type: 'text';
    readonly text: string;
} | {
    readonly type: 'reasoning';
    readonly text: string;
};
/** A JSON Schema node, as the tool registry accepts it. */
export interface JsonSchemaNode {
    type?: string;
    description?: string;
    enum?: readonly (string | number | boolean)[];
    items?: JsonSchemaNode;
    properties?: Record<string, JsonSchemaNode>;
    required?: readonly string[];
    additionalProperties?: boolean;
    default?: unknown;
    minimum?: number;
    maximum?: number;
    oneOf?: readonly JsonSchemaNode[];
}
/** The context handed to a tool's `execute`. */
export interface ToolRunContext {
    readonly signal?: AbortSignal;
    readonly callId?: string;
    deferContext?: (context: unknown) => void;
    concludeTurn?: () => void;
}
/** A tool definition, matching the Harness contract. */
export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchemaNode;
    readonly output: {
        readonly schema: JsonSchemaNode;
        render(args: unknown, value: unknown): ContentBlock[];
        presentationMeta?(args: unknown, value: unknown): unknown;
    };
    execute(args: unknown, context: ToolRunContext): Promise<unknown>;
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): unknown;
    presentResult?(args: unknown, result: unknown): unknown;
}
/** The `tools` service. */
export interface ToolsService {
    register(definition: ToolDefinition): () => void;
}
/** The `systemPrompt` service. */
export interface SystemPromptService {
    section(options: {
        name: string;
        order: number;
        text: string;
    }): () => void;
}
/** A logger compatible with the Harness logger. */
export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}
/** The `webServer` route shape (structural: only `register` is used). */
export interface WebServerService {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: unknown, res: unknown) => void | Promise<void>;
    }): () => void;
}
/**
 * A scope handed to `ctx.inject(deps, fn)`.
 *
 * Inside it the named services are guaranteed active, so `get` is a plain lookup
 * rather than a may-be-undefined probe. `effect` ties cleanup to that scope, which
 * is what makes "register routes when the webserver appears, drop them when it
 * goes away" a one-liner instead of a lifecycle the plugin has to track itself.
 */
export interface InjectableScope {
    get?: (name: string) => unknown;
    effect?: (execute: () => (() => void) | void, label?: string) => () => void;
}
/** The plugin context this plugin actually uses. */
export interface PluginContext {
    readonly tools: ToolsService;
    readonly systemPrompt: SystemPromptService;
    readonly logger?: (name: string) => Logger;
    readonly effect?: (execute: () => (() => void) | void, label?: string) => () => void;
    /** Present on recent Harness builds; used when the plugin is mounted in a scope. */
    readonly get?: (name: string) => unknown;
    /**
     * Scoped injection: runs `fn` once every named service is active, and again if
     * one is replaced. Present on the Cordis builds this plugin targets.
     */
    readonly inject?: (deps: string[], fn: (scope: InjectableScope) => void) => unknown;
}
/** Read a logger from a context, tolerating contexts without one. */
export declare function loggerOf(ctx: PluginContext, name: string): Logger;
//# sourceMappingURL=host.d.ts.map