/** Bindings and variables available to the Worker. See wrangler.jsonc and .env.example. */
export interface Env {
  DB: D1Database;

  // Non-secret vars (wrangler.jsonc "vars")
  BUSINESS_NAME: string;
  BUSINESS_CITY: string;
  GEOCODER_CHAIN: string;
  GEOCODER_MODE: string;
  ROUTER_CHAIN: string;
  QUOTE_TTL_MINUTES: string;
  PROVIDER_TIMEOUT_MS: string;

  // Secrets
  PAYSTACK_TEST_SECRET_KEY?: string;
  NIPOST_API_KEY?: string;
  OPENROUTE_BASIC_KEY?: string;
  GOOGLE_MAPS_API_KEY?: string;
  MCP_BEARER_TOKEN?: string;
  BOARD_TOKEN?: string;
  /** Signing secret of the Chord webhook registration (Admin -> Developer -> Webhooks). Optional. */
  CHORD_WEBHOOK_SECRET?: string;
  /** Google Sheets mirror (optional): spreadsheet id and a service-account JSON key with access to it. */
  GOOGLE_SHEET_ID?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  SHEET_MIRROR_ALLOW_LOCAL?: string;
  /** Chord API (optional): pushes "payment received" into the customer's conversation. Needs scopes
   *  thread:read and teammate:update. See docs/FEATURES.md §5a. */
  CHORD_API_KEY?: string;
  CHORD_API_BASE?: string;
  CHORD_WORKSPACE_ID?: string;
  CHORD_TEAMMATE_ID?: string;
  /** "direct_line" (default: write into the Chord thread by id) or "channel" (send via the WhatsApp connector). */
  CHORD_NOTICE_ROUTE?: string;
  /** Leave unset. "1" lets a LOCAL dev server send chat notices (it would post into real conversations). */
  CHORD_NOTICES_ALLOW_LOCAL?: string;
}
