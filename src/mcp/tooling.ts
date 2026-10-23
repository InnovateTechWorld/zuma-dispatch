import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from '../config';
import type { Env } from '../env';
import { log } from '../lib/log';

/**
 * An error the agent can act on. `code` is stable and machine-readable; `hint` tells
 * the model what to do next in plain language (ask the customer, retry, escalate).
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly retryable = false,
    /** Extra structured fields for the agent, e.g. which inputs were wrong. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ToolContext {
  env: Env;
  config: Config;
  db: D1Database;
  requestId: string;
  now: () => number;
  waitUntil: (p: Promise<unknown>) => void;
  /** https://host of this Worker, for Paystack callback URLs. */
  publicOrigin: string;
  /** Provider path for this call, e.g. ["nominatim:timeout", "photon:ok"]. Logged, never shown to customers. */
  trace: string[];
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  annotations: ToolAnnotations;
  /** Extra guidance appended to argument-validation errors for specific fields. */
  fieldHints?: Partial<Record<keyof Shape & string, string>>;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<Record<string, unknown>>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return def;
}

interface CompiledTool {
  def: ToolDefinition;
  parser: z.ZodObject<z.ZodRawShape>;
  listing: Tool;
}

/**
 * Compiles tool definitions once per isolate. Converting zod schemas to JSON Schema
 * is the most expensive thing an MCP request does, and Workers free plan allows
 * 10 ms CPU per request, so it must not happen on every tools/list.
 */
export function compileTools(defs: readonly ToolDefinition[]): Map<string, CompiledTool> {
  const compiled = new Map<string, CompiledTool>();
  for (const def of defs) {
    const parser = z.object(def.inputSchema).strict();
    const inputSchema = z.toJSONSchema(z.object(def.inputSchema), { target: 'draft-7', io: 'input' }) as Tool['inputSchema'];
    delete (inputSchema as Record<string, unknown>)['$schema'];
    compiled.set(def.name, {
      def,
      parser,
      listing: { name: def.name, title: def.title, description: def.description, inputSchema, annotations: def.annotations },
    });
  }
  return compiled;
}

/**
 * Chord shows the model only the TEXT of earlier turns, never their tool calls (FIELD_NOTES_FULL #9, #18).
 * Without this note the model sees a fresh tool result and decides its earlier answers were unchecked:
 * in live tests it retracted a correct quote ("I quoted ₦2,850 without checking … ignore it").
 * Putting the fact in every result means it is in front of the model at the moment it reasons.
 */
export const HISTORY_NOTE =
  // 23 Oct 2026: "never … re-run tools" here was read as "don't call tools", and Zuma answered "where is the rider"
  // with an invented position and link, and promised a person without calling hand_to_team. Each new request
  // needs its tool; only re-checking an earlier answer is pointless.
  'Context only, never mention it: what you told the customer earlier came from tools and is correct. Do not correct, retract or comment on it, and never mention checks. Reuse ids from the chat. ' +
  'Every new request still needs its tool in that turn: where the rider or package is → get_job_status; a refund, complaint or wanting a person → hand_to_team; any payment claim → verify_payment. ' +
  'Never answer those from earlier messages, never say a person will take over unless hand_to_team returned ok, and never write a link no tool gave you. ' +
  'Write your reply after your last tool call (text before a later tool call never reaches the customer), and never mention memory or saving.';

function ok(data: Record<string, unknown>): CallToolResult {
  data = { ...data, history_note: HISTORY_NOTE };
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function fail(err: ToolError, extra: Record<string, unknown> = {}): CallToolResult {
  const data = { error: { code: err.code, message: err.message, what_to_do: err.hint, retryable: err.retryable, ...extra } };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** Validates arguments, runs the handler, maps errors, logs the call. Never throws. */
export async function callTool(
  tool: CompiledTool | undefined,
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const started = Date.now();
  let result: CallToolResult;
  let errorCode: string | null = null;

  if (!tool) {
    errorCode = 'UNKNOWN_TOOL';
    result = fail(new ToolError('UNKNOWN_TOOL', `There is no tool called "${name}".`, 'Use only the tools listed by this server.'));
  } else {
    const parsed = tool.parser.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      errorCode = 'INVALID_ARGUMENTS';
      const fields = parsed.error.issues.map((i) => {
        const field = i.path.join('.') || '(arguments)';
        const hint =
          tool.def.fieldHints?.[field as never] ??
          (i.code === 'unrecognized_keys'
            ? 'Remove these fields. Prices, amounts and coordinates are worked out by the server, never passed in.'
            : undefined);
        return { field, problem: i.message, ...(hint ? { what_to_do: hint } : {}) };
      });
      result = fail(
        new ToolError(
          'INVALID_ARGUMENTS',
          'Some arguments were missing or invalid.',
          'Fix the fields listed in "fields" and call the tool again. Ask the customer for anything you do not have; never make values up.',
        ),
        { fields },
      );
    } else {
      try {
        result = ok(await tool.def.handler(parsed.data, ctx));
      } catch (e) {
        const err =
          e instanceof ToolError
            ? e
            : new ToolError(
                'INTERNAL_ERROR',
                'Something went wrong on our side.',
                'Apologise briefly and hand the conversation to a human dispatcher. Do not guess an answer.',
              );
        if (!(e instanceof ToolError)) {
          log('error', 'tool_unhandled_error', {
            tool: name,
            request_id: ctx.requestId,
            message: e instanceof Error ? e.message : String(e),
          });
        }
        errorCode = err.code;
        result = fail(err, err.details);
      }
    }
  }

  const latency = Date.now() - started;
  const trace = ctx.trace.join('>') || null;
  log(errorCode ? 'warn' : 'info', 'tool_call', {
    tool: name,
    request_id: ctx.requestId,
    ok: !errorCode,
    error_code: errorCode,
    latency_ms: latency,
    trace,
  });
  ctx.waitUntil(
    ctx.db
      .prepare('INSERT INTO tool_calls (request_id, tool, ok, error_code, latency_ms, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(ctx.requestId, name.slice(0, 64), errorCode ? 0 : 1, errorCode, latency, trace, ctx.now())
      .run()
      .catch((e: unknown) => log('warn', 'tool_call_log_failed', { message: String(e) })),
  );
  return result;
}
