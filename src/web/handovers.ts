import { chord, chordError, noticeConfig, sendsAllowed, type NoticeConfig } from '../chord/notices';
import type { Config } from '../config';
import type { Env } from '../env';
import { normalizeNigerianPhone } from '../lib/phone';
import { escapeHtml as h } from '../lib/text';
import { log } from '../lib/log';
import { backTo, readFlash } from './flash';
import { boardBar, footLine, notice, page, time } from './layout';
import { crossSite } from './session';

/**
 * The dispatcher's side of a human handover, on the board:
 * - /board/handovers               every chat waiting for a person (live from Chord) plus recent handovers
 * - /board/handovers/{threadId}    the whole conversation (customer, Zuma, team, Chord notices) and a reply box
 *
 * Replies and control changes go through Chord's operator API (thread:read, thread:write):
 * POST /v1/threads/{id}/messages | take-over | hand-back | resume. Chord delivers a reply down the chat's
 * own channel and reports delivery at once. A person's reply runs no AI, so it costs no model credits.
 *
 * No JavaScript (the CSP forbids it): every action is a form. A server-issued nonce on each form makes a
 * double click or a refresh unable to send the same reply twice.
 */

export const OPERATOR_ID = 'zuma-board-dispatcher';
/** Appended to every board reply. Chord shows operator messages to the AI as if it had written them; in a
 *  live test Zuma "corrected" a dispatcher's reply as its own mistake and re-escalated (FIELD_NOTES #21).
 *  A signature tells the customer and the AI that a person wrote it. */
export const TEAM_SIGNATURE = '— Zuma Dispatch team';
/** Posted just before a hand-back: tells the customer who answers next, and tells the AI the person is done. */
export const HANDBACK_LINE = 'Thanks for your patience. Zuma, our booking assistant, will help you from here.';

/** The text actually sent: the reply, signed unless the person already signed it. */
export function signed(text: string): string {
  return /zuma dispatch team/i.test(text) ? text : `${text}\n${TEAM_SIGNATURE}`;
}
export const MAX_REPLY = 4000; // Chord's limit for an operator message
const THREAD_RE = /^[0-9a-f]{24}$/;
const TIMEOUT_MS = 5000;

interface Thread {
  id: string;
  channel_id?: string;
  channel_participant_id?: string;
  control_state?: string;
  status?: string;
  last_turn_at?: number;
  last_turn_preview?: string;
  last_turn_direction?: string;
  last_handoff_at?: number | null;
  remote_participant_metadata?: { display_name?: string } | null;
}
interface Turn {
  id?: string;
  direction?: string;
  sender?: { kind?: string; operator_user_id?: string } | null;
  content?: { text?: string } | null;
  timestamp?: number;
  delivery_status?: string | null;
  delivery_error?: string | null;
}

// ------------------------------------------------------------------ pure helpers (tested)
export type Speaker = 'customer' | 'agent' | 'team' | 'notice';

/** Who said it, for the transcript. Our own automated posts (handover note, payment notice) are notices. */
export function speakerOf(t: Turn): Speaker {
  const kind = t.sender?.kind;
  if (t.direction === 'inbound' || kind === 'remote') return 'customer';
  if (kind === 'system') return 'notice';
  if (kind === 'human_operator') {
    const text = t.content?.text ?? '';
    if (t.sender?.operator_user_id === OPERATOR_ID) return 'team';
    return /^(You're now connected to the Zuma Dispatch support team|Payment received:|Thanks for your patience\. Zuma, our booking assistant)/.test(text) ? 'notice' : 'team';
  }
  return 'agent';
}

export const SPEAKER_LABEL: Record<Speaker, string> = { customer: 'Customer', agent: 'Zuma (AI)', team: 'Team', notice: 'Notice' };

export type ControlState = 'human_active' | 'agent_active' | 'paused' | 'unknown';
export function controlState(raw: string | undefined): ControlState {
  return raw === 'human_active' || raw === 'agent_active' || raw === 'paused' ? raw : 'unknown';
}
export const STATE_LABEL: Record<ControlState, string> = {
  human_active: 'Waiting for you',
  agent_active: 'Back with Zuma',
  paused: 'Paused',
  unknown: 'Unknown',
};

/** Validates a reply before anything is sent. Returns the cleaned text or the problem. */
export function checkReply(raw: unknown): { ok: true; text: string } | { ok: false; problem: string } {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return { ok: false, problem: 'Write a message first.' };
  if (text.length + TEAM_SIGNATURE.length + 1 > MAX_REPLY) return { ok: false, problem: `That message is ${text.length} characters; with the team signature Chord accepts up to ${MAX_REPLY - TEAM_SIGNATURE.length - 1}.` };
  return { ok: true, text };
}

/** The newest job id mentioned in the conversation (agent or customer), to link the job page. */
export function jobIdIn(turns: Turn[], reasons: (string | null)[]): string | null {
  for (const s of [...reasons, ...[...turns].reverse().map((t) => t.content?.text ?? '')]) {
    const m = /\bZD-[0-9A-Z]{5}\b/.exec(s ?? '');
    if (m) return m[0];
  }
  return null;
}

// ------------------------------------------------------------------ pages
const CSS = `
.ho-head{padding-block:var(--space-lg) var(--space-md);display:flex;flex-direction:column;gap:var(--space-3xs)}
.ho-list{list-style:none;margin:0 0 var(--space-lg);padding:0;display:grid;gap:var(--space-xs)}
.ho-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-2xs) var(--space-md);align-items:start;padding:var(--space-sm);border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
.ho-card{color:inherit}
.ho-card:hover{border-color:var(--color-rule-2)}
.ho-card__who{font:600 var(--text-md)/1.3 var(--font-display);color:var(--color-ink)}
.ho-card__reason{font-size:var(--text-sm);color:var(--color-ink-2);overflow-wrap:anywhere;margin-top:var(--space-3xs)}
.ho-card__meta{font-size:var(--text-xs);color:var(--color-muted);margin-top:var(--space-3xs)}
.ho-card__end{display:flex;flex-direction:column;align-items:flex-end;gap:var(--space-2xs)}
.state{display:inline-flex;align-items:center;gap:var(--space-3xs);height:1.5rem;padding:0 var(--space-2xs);border:1px solid currentColor;border-radius:999px;font:500 var(--text-xs)/1 var(--font-body);white-space:nowrap}
.state::before{content:"";width:.375rem;height:.375rem;border-radius:50%;background:currentColor}
.state--human_active{color:var(--color-accent-text)}
.state--agent_active{color:var(--color-muted)}
.state--paused{color:var(--st-payment_failed)}
.state--unknown{color:var(--color-muted)}
.convo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,20rem);gap:var(--space-lg) var(--space-xl);align-items:start;padding-bottom:var(--space-lg)}
.convo__side{position:sticky;top:var(--space-md);display:grid;gap:var(--space-sm)}
.facts-mini{display:grid;grid-template-columns:minmax(0,7rem) minmax(0,1fr);gap:var(--space-3xs) var(--space-xs);margin:0;font-size:var(--text-sm)}
.facts-mini dt{font:500 var(--text-2xs)/1.9 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted)}
.facts-mini dd{margin:0;color:var(--color-ink);overflow-wrap:anywhere}
.chat{display:flex;flex-direction:column;gap:var(--space-xs);padding:var(--space-sm);border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-paper-2);min-height:12rem}
.msg{max-width:min(36rem,85%);padding:var(--space-xs) var(--space-sm);border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
.msg--customer{align-self:flex-start}
.msg--agent{align-self:flex-end}
.msg--team{align-self:flex-end;background:var(--color-accent-wash);border-color:var(--color-accent)}
.msg--notice{align-self:center;max-width:min(30rem,95%);background:transparent;border-style:dashed}
.msg--notice .msg__text{color:var(--color-muted);font-size:var(--text-sm)}
.msg--failed{border-color:var(--color-bad)}
.msg__meta{display:flex;flex-wrap:wrap;gap:var(--space-3xs) var(--space-xs);margin-bottom:var(--space-3xs);font:500 var(--text-2xs)/1.4 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted)}
.msg__text{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--color-ink);font-size:var(--text-base)}
.msg__bad{display:block;margin-top:var(--space-3xs);font-size:var(--text-xs);color:var(--color-bad)}
.earlier{align-self:center;font-size:var(--text-sm)}
.composer{display:grid;gap:var(--space-2xs);margin-top:var(--space-sm)}
.textarea{height:auto;min-height:6.5rem;padding:var(--space-xs);line-height:1.5;resize:vertical}
.composer__row{display:flex;flex-wrap:wrap;gap:var(--space-2xs);align-items:center;justify-content:space-between}
.composer__hint{font-size:var(--text-xs);color:var(--color-muted)}
.lock{padding:var(--space-sm);border:1px dashed var(--color-rule-2);border-radius:var(--radius-lg);font-size:var(--text-sm);color:var(--color-ink-2);display:grid;gap:var(--space-xs);margin-top:var(--space-sm)}
@media (max-width:64rem){.convo{grid-template-columns:minmax(0,1fr)}.convo__side{position:static;order:-1}}
@media (max-width:48rem){.ho-card{grid-template-columns:minmax(0,1fr)}.ho-card__end{align-items:flex-start;flex-direction:row}.msg{max-width:92%}}
`;

function stateChip(s: ControlState): string {
  return `<span class="state state--${s}">${STATE_LABEL[s]}</span>`;
}

function displayName(t: Thread): string {
  return t.remote_participant_metadata?.display_name?.trim() || 'Customer';
}

function contact(t: Thread): string {
  const p = normalizeNigerianPhone(t.channel_participant_id ?? '');
  return p.ok ? p.masked : t.channel_id === 'whatsapp' ? 'WhatsApp' : t.channel_id === 'external_chat' ? 'Test chat (simulator)' : t.channel_id ?? '';
}

function notConfigured(config: Config, signedIn: boolean, why: string): Response {
  return page({
    title: 'Handovers',
    css: CSS,
    body: `${boardBar(config.businessName, signedIn)}<main class="wrap ho-head"><p class="label"><a href="/board">← Board</a></p><h1>Handovers</h1>
<p class="muted">${h(why)}</p></main>`,
  });
}

/** GET /board/handovers */
async function inbox(url: URL, env: Env, config: Config, signedIn: boolean): Promise<Response> {
  const cfg = noticeConfig(env);
  if (!cfg) return notConfigured(config, signedIn, 'Replying from the board needs CHORD_API_KEY (scopes thread:read and thread:write). Until then, reply in Chord → Teammates → Zuma → Escalated.');
  const [live, recent] = await Promise.all([
    chord<{ threads?: Thread[] }>(cfg, `/v1/threads?${new URLSearchParams({ workspace_id: cfg.workspaceId, control_state: 'human_active,paused', limit: '50' })}`, TIMEOUT_MS),
    env.DB.prepare(`SELECT thread_id, initiator, reason, received_at FROM chord_events WHERE type = 'conversation.escalated' AND thread_id IS NOT NULL ORDER BY received_at DESC LIMIT 40`).all<{
      thread_id: string; initiator: string | null; reason: string | null; received_at: number;
    }>(),
  ]);
  const flash = await readFlash(url, config.boardToken);
  const waiting = live.ok ? (live.data.threads ?? []).filter((t) => THREAD_RE.test(t.id)) : [];
  const waitingIds = new Set(waiting.map((t) => t.id));
  // Latest real handover per thread (ignore our own momentary take-overs).
  const latest = new Map<string, { reason: string | null; initiator: string | null; received_at: number }>();
  for (const e of recent.results) {
    if ((e.reason ?? '').startsWith('zuma-dispatch automated notice')) continue;
    if (!latest.has(e.thread_id)) latest.set(e.thread_id, e);
  }
  const card = (id: string, who: string, state: ControlState, reason: string | null, when: number | null, sub: string) => `<li><a class="ho-card" href="/board/handovers/${h(id)}#reply" style="text-decoration:none">
<div><div class="ho-card__who">${h(who)}</div>${reason ? `<p class="ho-card__reason">${h(reason.slice(0, 220))}${reason.length > 220 ? '…' : ''}</p>` : ''}<p class="ho-card__meta">${h(sub)}</p></div>
<div class="ho-card__end">${stateChip(state)}<span class="ho-card__meta">${when ? time(when) : ''}</span></div></a></li>`;
  const waitingHtml = waiting.length
    ? `<ul class="ho-list">${waiting
        .map((t) => {
          const e = latest.get(t.id);
          return card(t.id, displayName(t), controlState(t.control_state), e?.reason ?? null, t.last_handoff_at ?? e?.received_at ?? t.last_turn_at ?? null, `${contact(t)} · last message: ${(t.last_turn_preview ?? '').slice(0, 80)}`);
        })
        .join('')}</ul>`
    : `<p class="muted" style="margin-bottom:var(--space-lg)">${live.ok ? 'Nobody is waiting for a person right now.' : `Could not reach Chord (${h(chordError(live))}). Recent handovers below come from the webhook log.`}</p>`;
  const earlier = [...latest.entries()].filter(([id]) => !waitingIds.has(id)).slice(0, 20);
  const earlierHtml = earlier.length
    ? `<ul class="ho-list">${earlier.map(([id, e]) => card(id, 'Earlier handover', live.ok ? 'agent_active' : 'unknown', e.reason, e.received_at, e.initiator === 'human_operator' ? 'taken over by a person' : 'handed over by Zuma')).join('')}</ul>`
    : '<p class="muted">None yet.</p>';
  return page({
    title: `Handovers · ${config.businessName}`,
    css: CSS,
    body: `${boardBar(config.businessName, signedIn)}
<main class="wrap">
<div class="ho-head"><p class="label"><a href="/board">← Board</a></p><h1>Handovers</h1><p class="muted">Chats Zuma handed to a person. Open one to read the whole conversation, reply as the team, and hand it back.</p></div>
${flash ? `<div style="margin-bottom:var(--space-md)">${notice(flash.msg, flash.error ? 'error' : 'info')}</div>` : ''}
<section aria-labelledby="w-h"><div class="section__head"><h2 id="w-h">Waiting for a person (${waiting.length})</h2></div>${waitingHtml}</section>
<section class="section" aria-labelledby="e-h"><div class="section__head"><h3 id="e-h">Earlier handovers</h3><p class="muted">Back with Zuma, or closed.</p></div>${earlierHtml}</section>
</main>
${footLine(`${h(config.businessName)} · replies from people cost no AI credits · times in WAT`)}`,
  });
}

/** GET /board/handovers/{id} */
async function conversation(threadId: string, url: URL, env: Env, config: Config, signedIn: boolean): Promise<Response> {
  const cfg = noticeConfig(env);
  if (!cfg) return notConfigured(config, signedIn, 'Reading and replying needs CHORD_API_KEY (scopes thread:read and thread:write).');
  const before = url.searchParams.get('before') ?? '';
  const turnsPath = `/v1/threads/${threadId}/turns?${new URLSearchParams({ limit: '40', ...(before && /^[A-Za-z0-9_=-]{1,200}$/.test(before) ? { cursor: before } : {}) })}`;
  const [th, tu, events] = await Promise.all([
    chord<Thread>(cfg, `/v1/threads/${threadId}`, TIMEOUT_MS),
    chord<{ turns?: Turn[]; next_cursor?: string; has_more?: boolean }>(cfg, turnsPath, TIMEOUT_MS),
    env.DB.prepare(`SELECT reason, initiator, received_at, ack FROM chord_events WHERE thread_id = ? AND type = 'conversation.escalated' ORDER BY received_at DESC LIMIT 5`).bind(threadId).all<{
      reason: string | null; initiator: string | null; received_at: number; ack: string | null;
    }>(),
  ]);
  if (!th.ok) {
    const status = th.failure === 'http' && th.status === 404 ? 404 : 502;
    return page({
      title: 'Conversation',
      status,
      css: CSS,
      body: `${boardBar(config.businessName, signedIn)}<main class="wrap ho-head"><p class="label"><a href="/board/handovers">← Handovers</a></p><h1>${status === 404 ? 'No such conversation' : 'Could not reach Chord'}</h1><p class="muted">${h(chordError(th))}</p></main>`,
    });
  }
  const t = th.data;
  const state = controlState(t.control_state);
  const turns = tu.ok ? tu.data.turns ?? [] : [];
  const reasons = events.results.map((e) => e.reason).filter((r) => r && !r.startsWith('zuma-dispatch automated notice'));
  const jobId = jobIdIn(turns, reasons);
  const flash = await readFlash(url, config.boardToken);
  const nonce = crypto.randomUUID();
  const self = `/board/handovers/${threadId}`;
  const hidden = (action: string) => `<input type="hidden" name="nonce" value="${nonce}-${action}"><input type="hidden" name="action" value="${action}">`;

  const bubbles = turns
    .map((x) => {
      const who = speakerOf(x);
      const failed = x.delivery_status === 'failed';
      const opener = x.sender?.operator_user_id === OPERATOR_ID ? 'Team (board)' : SPEAKER_LABEL[who];
      return `<div class="msg msg--${who}${failed ? ' msg--failed' : ''}"><div class="msg__meta"><span>${h(opener)}</span><span>${x.timestamp ? time(x.timestamp) : ''}</span></div><div class="msg__text">${h(x.content?.text ?? '(no text)')}</div>${
        failed ? `<span class="msg__bad">Not delivered${x.delivery_error ? `: ${h(x.delivery_error)}` : ''}</span>` : ''
      }</div>`;
    })
    .join('');
  const earlierLink = tu.ok && tu.data.has_more && tu.data.next_cursor
    ? `<a class="earlier" href="${h(`${self}?before=${encodeURIComponent(tu.data.next_cursor)}`)}">Show earlier messages</a>`
    : '';
  const newestLink = before ? `<a class="earlier" href="${h(self)}">Back to the latest messages</a>` : '';

  const composer = state === 'human_active'
    ? `<form class="composer" id="reply" method="post" action="${h(self)}">
<input type="hidden" name="nonce" value="${nonce}-reply">
<label class="field"><span class="label">Reply as the Zuma Dispatch team</span>
<textarea class="input textarea" name="text" maxlength="${MAX_REPLY}" required placeholder="Hi, this is the Zuma Dispatch team…"></textarea></label>
<div class="composer__row"><span class="composer__hint">Signed “${TEAM_SIGNATURE}”. Handing back also posts “${HANDBACK_LINE}”. People's replies use no AI credits.</span>
<div class="actions"><button class="btn" type="submit" name="action" value="reply_handback">Send and hand back</button><button class="btn btn--primary" type="submit" name="action" value="reply">Send</button></div></div>
</form>
<form class="inline" method="post" action="${h(self)}" style="display:block;margin-top:var(--space-xs)">${hidden('handback')}<button class="btn btn--ghost" type="submit">Hand back to Zuma without replying</button></form>`
    : `<div class="lock" id="reply"><span>${state === 'agent_active' ? 'Zuma (the AI) is answering this chat. To reply yourself, take it over: the customer will see “connecting you with a teammate”, and Zuma stops replying until you hand it back.' : state === 'paused' ? 'This chat is paused: nobody replies. Take it over to reply, or resume Zuma.' : 'Chord did not report who holds this chat.'}</span>
<div class="actions"><form class="inline" method="post" action="${h(self)}">${hidden('takeover')}<button class="btn btn--primary" type="submit">Take over</button></form>${
        state === 'paused' ? `<form class="inline" method="post" action="${h(self)}">${hidden('resume')}<button class="btn" type="submit">Resume Zuma</button></form>` : ''
      }</div></div>`;

  const side = `<aside class="convo__side" aria-label="About this chat">
<div>${stateChip(state)}</div>
<dl class="facts-mini"><dt>Customer</dt><dd>${h(displayName(t))}</dd><dt>Channel</dt><dd>${h(contact(t))}</dd>
<dt>Job</dt><dd>${jobId ? `<a class="mono" href="/board/jobs/${h(jobId)}">${h(jobId)}</a>` : '—'}</dd>
<dt>Handed over</dt><dd>${events.results[0] ? time(events.results[0].received_at) : t.last_handoff_at ? time(t.last_handoff_at) : '—'}</dd>
<dt>Customer told</dt><dd>${events.results[0]?.ack === 'sent' ? 'yes' : h(events.results[0]?.ack ?? '—')}</dd></dl>
${reasons[0] ? `<div><p class="label">Why Zuma handed over</p><p style="font-size:var(--text-sm);overflow-wrap:anywhere">${h(reasons[0])}</p></div>` : ''}
<p class="muted" style="font-size:var(--text-xs)"><a href="${h(self)}">Refresh</a> to see new customer messages.</p>
</aside>`;

  return page({
    title: `${displayName(t)} · Handover`,
    css: CSS,
    body: `${boardBar(config.businessName, signedIn)}
<main class="wrap">
<div class="ho-head"><p class="label"><a href="/board/handovers">← Handovers</a></p><h1>${h(displayName(t))}</h1></div>
<div class="convo">
<section aria-label="Conversation"><div class="chat">${earlierLink}${newestLink}${bubbles || `<p class="muted">${tu.ok ? 'No messages.' : `Could not load messages (${h(chordError(tu))}).`}</p>`}</div>${flash ? `<div style="margin-top:var(--space-sm)">${notice(flash.msg, flash.error ? 'error' : 'info')}</div>` : ''}${composer}</section>
${side}
</div>
</main>
${footLine(`${h(config.businessName)} · conversation from Chord · times in WAT`)}`,
  });
}

// ------------------------------------------------------------------ actions
const ACTIONS = ['reply', 'reply_handback', 'handback', 'takeover', 'resume'] as const;
type Action = (typeof ACTIONS)[number];

/** Claims the form's nonce; false means this exact form was already submitted (double click, refresh). */
async function claimNonce(db: D1Database, nonce: string, threadId: string, action: Action, now: number): Promise<boolean> {
  const r = await db
    .prepare('INSERT INTO board_replies (nonce, thread_id, action, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (nonce) DO NOTHING')
    .bind(nonce, threadId, action, now)
    .run();
  return r.meta.changes === 1;
}

async function record(db: D1Database, nonce: string, outcome: string, turnId?: string): Promise<void> {
  await db.prepare('UPDATE board_replies SET outcome = ?, turn_id = ? WHERE nonce = ?').bind(outcome.slice(0, 300), turnId ?? null, nonce).run().catch(() => undefined);
}

/** Plain-language meaning of Chord's answers for a dispatcher. */
function explain(step: string, r: { ok: boolean; status?: number | null; failure?: string } & Record<string, unknown>, err: string): string {
  if (r.failure === 'http' && r.status === 409) {
    return step === 'reply'
      ? 'Not sent: Zuma is holding this chat (or it is paused). Take it over first.'
      : step === 'handback'
        ? 'It is not with a person any more (already handed back).'
        : step === 'takeover'
          ? 'A person already holds this chat.'
          : 'This chat is not paused.';
  }
  if (r.failure === 'http' && r.status === 403) return 'The Chord API key lacks thread:write. Use a key with that scope.';
  if (r.failure === 'http' && r.status === 404) return 'Chord does not know this conversation.';
  return `Chord did not accept it (${err}). Nothing was changed; try again.`;
}

async function act(request: Request, url: URL, env: Env, threadId: string): Promise<Response> {
  const self = `/board/handovers/${threadId}#reply`; // land on the reply box, where the result is shown
  if (crossSite(request, url)) return backTo(url, env, self, 'Blocked: that form came from another site.', true);
  const cfg = noticeConfig(env);
  if (!cfg) return backTo(url, env, self, 'CHORD_API_KEY is not set.', true);
  if (!sendsAllowed(env, url.origin)) return backTo(url, env, self, 'This is a local test server: it does not post into real chats (set CHORD_NOTICES_ALLOW_LOCAL=1 to allow).', true);
  const form = await request.formData().catch(() => new FormData());
  const action = String(form.get('action')) as Action;
  if (!ACTIONS.includes(action)) return backTo(url, env, self, 'Unknown action.', true);
  const nonce = String(form.get('nonce') ?? '');
  if (!/^[0-9a-f-]{36}-[a-z_]+$/.test(nonce)) return backTo(url, env, self, 'This page is out of date. Reload it and try again.', true);
  const now = Date.now();
  if (!(await claimNonce(env.DB, nonce, threadId, action, now))) return backTo(url, env, self, 'Already done: that form was submitted twice, so it was not sent again.', false);

  let text = '';
  if (action === 'reply' || action === 'reply_handback') {
    const c = checkReply(form.get('text'));
    if (!c.ok) {
      await record(env.DB, nonce, `rejected: ${c.problem}`);
      return backTo(url, env, self, c.problem, true);
    }
    text = c.text;
  }
  const result = await perform(cfg, threadId, action, text);
  await record(env.DB, nonce, result.ok ? 'ok' : result.message, result.turnId);
  log(result.ok ? 'info' : 'warn', 'board_handover_action', { thread_id: threadId, action, ok: result.ok });
  return backTo(url, env, self, result.message, !result.ok);
}

async function perform(cfg: NoticeConfig, threadId: string, action: Action, text: string): Promise<{ ok: boolean; message: string; turnId?: string }> {
  const who = { operator_user_id: OPERATOR_ID };
  if (action === 'reply' || action === 'reply_handback') {
    const r = await chord<{ id?: string; delivery_status?: string; delivery_error?: string | null }>(cfg, `/v1/threads/${threadId}/messages`, TIMEOUT_MS, { text: signed(text), ...who });
    if (!r.ok) return { ok: false, message: explain('reply', r as never, chordError(r)) };
    if (r.data.delivery_status === 'failed') {
      return { ok: false, message: `Chord recorded the reply but the chat did not accept it${r.data.delivery_error ? ` (${r.data.delivery_error})` : ''}. It shows as “Not delivered”.`, turnId: r.data.id };
    }
    if (action === 'reply') return { ok: true, message: 'Sent to the customer.', turnId: r.data.id };
    const back = await handBack(cfg, threadId);
    return back.ok || (back.failure === 'http' && back.status === 409)
      ? { ok: true, message: 'Sent, and handed back to Zuma.', turnId: r.data.id }
      : { ok: false, message: `Sent, but hand-back failed: ${explain('handback', back as never, chordError(back))}`, turnId: r.data.id };
  }
  const path = action === 'handback' ? 'hand-back' : action === 'takeover' ? 'take-over' : 'resume';
  const reason = action === 'handback' ? 'Resolved on the board' : action === 'takeover' ? 'Taken over from the board' : 'Resumed from the board';
  const r = action === 'handback' ? await handBack(cfg, threadId) : await chord<Thread>(cfg, `/v1/threads/${threadId}/${path}`, TIMEOUT_MS, { ...who, reason });
  if (!r.ok) return { ok: false, message: explain(action, r as never, chordError(r)) };
  const now = controlState(r.data.control_state);
  return {
    ok: true,
    message: action === 'handback' ? 'Handed back: Zuma answers this chat again.' : action === 'takeover' ? `You hold this chat now (${STATE_LABEL[now]}). Zuma stays quiet until you hand it back.` : 'Zuma is answering again.',
  };
}

/** Posts the closing line (best effort: a failure never blocks the hand-back), then hands back. */
async function handBack(cfg: NoticeConfig, threadId: string) {
  await chord(cfg, `/v1/threads/${threadId}/messages`, TIMEOUT_MS, { text: HANDBACK_LINE, operator_user_id: OPERATOR_ID });
  return chord<Thread>(cfg, `/v1/threads/${threadId}/hand-back`, TIMEOUT_MS, { operator_user_id: OPERATOR_ID, reason: 'Resolved on the board' });
}

// ------------------------------------------------------------------ router
export async function handovers(request: Request, url: URL, env: Env, config: Config, session: { signedIn: boolean }): Promise<Response | null> {
  if (url.pathname === '/board/handovers' || url.pathname === '/board/handovers/') {
    return request.method === 'GET' || request.method === 'HEAD' ? inbox(url, env, config, session.signedIn) : null;
  }
  const m = /^\/board\/handovers\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  const id = m[1]!;
  if (!THREAD_RE.test(id)) {
    return page({ title: 'Not found', status: 404, css: CSS, body: `${boardBar(config.businessName, session.signedIn)}<main class="wrap ho-head"><h1>No such conversation</h1><p class="muted"><a href="/board/handovers">Back to handovers</a></p></main>` });
  }
  if (request.method === 'POST') return act(request, url, env, id);
  return conversation(id, url, env, config, session.signedIn);
}
