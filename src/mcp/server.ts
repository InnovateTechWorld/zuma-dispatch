import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  JSONRPCMessageSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import type { Config } from '../config';
import type { Env } from '../env';
import { ALL_TOOLS } from '../tools';
import { callTool, compileTools, type ToolContext, type ToolDefinition } from './tooling';

export const SERVER_VERSION = '0.1.0';

// Built at module load, i.e. once per isolate. Work done here counts toward Worker
// startup time (generous limit) instead of per-request CPU time (10 ms on the free
// plan). Measured: a cold isolate's first request fell from ~25 ms CPU to a few ms.
const compiled = compileTools(ALL_TOOLS as unknown as readonly ToolDefinition[]);
const listing: { tools: Tool[] } = { tools: [...compiled.values()].map((t) => t.listing) };
warmUpSchemas();

/** Runs the SDK's zod schemas once so their lazy initialisation happens at startup. */
function warmUpSchemas(): void {
  const init = {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'warmup', version: '0' } },
  };
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_job_status', arguments: { job_id: 'ZD-00000' } } };
  JSONRPCMessageSchema.safeParse(init);
  JSONRPCMessageSchema.safeParse(call);
  InitializeRequestSchema.safeParse(init);
  CallToolRequestSchema.safeParse(call);
  ListToolsRequestSchema.safeParse({ method: 'tools/list' });
  for (const t of compiled.values()) t.parser.safeParse({});
}

/**
 * Handles one MCP request statelessly: a fresh low-level server and transport per
 * request, no session ids, JSON responses (no SSE). Chord sends one JSON POST per call,
 * so there is no session state worth keeping.
 *
 * The low-level Server is used instead of McpServer for CPU reasons: McpServer converts
 * every zod schema to JSON Schema on each tools/list, and the default Ajv validator is
 * expensive to construct. Here schemas are compiled once and the Workers-native
 * cfworker validator is used. See docs/FIELD_NOTES_FULL.md (#2, "CPU time on the free plan").
 */
export async function handleMcp(
  request: Request,
  env: Env,
  config: Config,
  execCtx: ExecutionContext,
  requestId: string,
): Promise<Response> {
  const server = new Server(
    { name: 'zuma-dispatch', title: `${config.businessName} dispatch tools`, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions: `Tools for ${config.businessName}, a courier in ${config.businessCity}. Order: resolve_address (pickup, drop-off) -> quote_delivery -> customer says yes -> create_dispatch_job -> create_payment_link -> verify_payment.`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => listing);
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const ctx: ToolContext = {
      env,
      config,
      db: env.DB,
      requestId,
      now: () => Date.now(),
      waitUntil: (p) => execCtx.waitUntil(p),
      publicOrigin: new URL(request.url).origin,
      trace: [],
    };
    return callTool(compiled.get(req.params.name), req.params.name, req.params.arguments, ctx);
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    execCtx.waitUntil(server.close());
  }
}
