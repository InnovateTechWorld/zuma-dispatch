import type { Config } from '../config';
import { fetchJson, traceLabel, type HttpResult } from '../lib/http';
import { ToolError } from '../mcp/tooling';

/**
 * Minimal Paystack client (test mode only; the config refuses non sk_test_ keys).
 * Docs: https://paystack.com/docs/api/transaction/ (mirrors cited in notes/best-practices.md)
 */
const BASE = 'https://api.paystack.co';
const TIMEOUT_MS = 8000;

export interface InitializeInput {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
}

export type InitializeResult =
  | { kind: 'created'; authorizationUrl: string; accessCode: string }
  | { kind: 'duplicate_reference' }
  | { kind: 'timeout' };

export type TransferResult =
  | { kind: 'created'; bankName: string; accountNumber: string; accountName: string; expiresAt: number }
  | { kind: 'duplicate_reference' }
  | { kind: 'timeout' };

/**
 * "Pay with Transfer" through the Charge API: Paystack issues a temporary account for this exact
 * amount and reference. Verified later with the same transaction/verify call as card payments.
 * Test mode returns "Test Bank" details; no real account is created.
 */
export async function chargeBankTransfer(
  input: Omit<InitializeInput, 'callbackUrl'> & { expiresAt: number },
  config: Config,
  trace: string[],
): Promise<TransferResult> {
  const r = await fetchJson<{
    status?: boolean;
    data?: { status?: string; account_number?: string; account_name?: string; bank?: { name?: string }; account_expires_at?: string };
  }>(`${BASE}/charge`, {
    method: 'POST',
    timeoutMs: TIMEOUT_MS,
    headers: headers(config),
    body: {
      email: input.email,
      amount: input.amountKobo,
      reference: input.reference,
      metadata: input.metadata,
      bank_transfer: { account_expires_at: new Date(input.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z') },
    },
  });
  trace.push(traceLabel('paystack-transfer', r, r.ok ? (r.data.data?.status ?? '') : ''));
  const d = r.ok ? r.data.data : undefined;
  if (d?.account_number && d.bank?.name) {
    return {
      kind: 'created',
      bankName: d.bank.name,
      accountNumber: d.account_number,
      accountName: d.account_name ?? 'Paystack',
      expiresAt: Date.parse(d.account_expires_at ?? '') || input.expiresAt,
    };
  }
  if (!r.ok && r.failure === 'timeout') return { kind: 'timeout' };
  if (!r.ok && r.status === 400 && /duplicate_reference|Duplicate Transaction Reference/i.test(r.body ?? '')) return { kind: 'duplicate_reference' };
  return unavailable(r);
}

export interface VerifyData {
  status: string;
  amount: number;
  currency: string;
  reference: string;
  id?: number;
  channel?: string;
  gateway_response?: string;
  paid_at?: string | null;
}

export type VerifyResult = { kind: 'found'; data: VerifyData } | { kind: 'not_found' };

function headers(config: Config) {
  return { Authorization: `Bearer ${config.paystackSecretKey}` };
}

/** Maps transport-level failures to agent-actionable errors. */
function unavailable(r: HttpResult<unknown>): never {
  if (!r.ok && r.status === 429) {
    const reset = r.headers?.get('x-ratelimit-reset');
    throw new ToolError(
      'PAYMENT_PROVIDER_BUSY',
      `Paystack is rate limiting us${reset ? ` for about ${reset} seconds` : ''}.`,
      'Tell the customer the payment system is busy and ask them to message again in a minute. Do not retry in a loop.',
      true,
    );
  }
  throw new ToolError(
    'PAYMENT_PROVIDER_UNAVAILABLE',
    'Paystack did not respond properly.',
    'Apologise, wait a moment and try once more. If it fails again, hand the conversation to a human dispatcher.',
    true,
  );
}

export async function initializeTransaction(input: InitializeInput, config: Config, trace: string[]): Promise<InitializeResult> {
  const r = await fetchJson<{ status?: boolean; data?: { authorization_url?: string; access_code?: string } }>(
    `${BASE}/transaction/initialize`,
    {
      method: 'POST',
      timeoutMs: TIMEOUT_MS,
      headers: headers(config),
      body: {
        email: input.email,
        amount: input.amountKobo,
        currency: 'NGN',
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      },
    },
  );
  trace.push(traceLabel('paystack-init', r));
  if (r.ok && r.data.status && r.data.data?.authorization_url && r.data.data.access_code) {
    return { kind: 'created', authorizationUrl: r.data.data.authorization_url, accessCode: r.data.data.access_code };
  }
  if (!r.ok && r.failure === 'timeout') return { kind: 'timeout' };
  if (!r.ok && r.status === 400 && /duplicate_reference|Duplicate Transaction Reference/i.test(r.body ?? '')) {
    return { kind: 'duplicate_reference' };
  }
  return unavailable(r);
}

export async function verifyTransaction(reference: string, config: Config, trace: string[]): Promise<VerifyResult> {
  const r = await fetchJson<{ status?: boolean; message?: string; data?: VerifyData }>(
    `${BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    { timeoutMs: TIMEOUT_MS, headers: headers(config) },
  );
  trace.push(traceLabel('paystack-verify', r, r.ok ? (r.data.data?.status ?? '') : ''));
  if (r.ok && r.data.data) return { kind: 'found', data: r.data.data };
  // Paystack answers 400 "Transaction reference not found" for references it never created.
  if (!r.ok && (r.status === 404 || (r.status === 400 && /not found/i.test(r.body ?? '')))) return { kind: 'not_found' };
  return unavailable(r);
}
