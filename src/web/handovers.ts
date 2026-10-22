import { chord, chordError, noticeConfig, sendsAllowed, type NoticeConfig } from '../chord/notices';
import type { Config } from '../config';
import type { Env } from '../env';
import { normalizeNigerianPhone } from '../lib/phone';
import { escapeHtml as h } from '../lib/text';
import { log } from '../lib/log';
import { backTo } from './flash';
import { notice, time } from './layout';
import { blank, pageHead, shell, type BoardSession } from './shell';
import { readSignals } from './signals';
import { HANDOVER_REASON_PREFIX } from '../chord/handover';
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
 *  live test Zuma "corrected" a dispatcher's reply as its own mistake and re-escalated (FIELD_NOTES_FULL #21).
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
.state--paused{color:var(--color-warn)}
.state--unknown{color:var(--color-muted)}
.convo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,19rem);gap:var(--space-lg);align-items:start;padding-bottom:var(--space-md)}
.thread{display:flex;flex-direction:column;border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface);overflow:hidden;min-width:0}
.thread__bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2xs) var(--space-sm);padding:var(--space-xs) var(--space-sm);border-bottom:1px solid var(--color-rule);font-size:var(--text-sm)}
.thread__bar a{white-space:nowrap}
.convo__side{position:sticky;top:var(--space-md);display:grid;gap:var(--space-sm);padding:var(--space-sm);border:1px solid var(--color-rule);border-radius:var(--radius-lg);background:var(--color-surface)}
.facts-mini{display:grid;grid-template-columns:minmax(0,7rem) minmax(0,1fr);gap:var(--space-3xs) var(--space-xs);margin:0;font-size:var(--text-sm)}
.facts-mini dt{font:500 var(--text-2xs)/1.9 var(--font-mono);letter-spacing:.06em;text-transform:uppercase;color:var(--color-muted)}
.facts-mini dd{margin:0;color:var(--color-ink);overflow-wrap:anywhere}
/* The message list scrolls inside a fixed-height panel. It is a reversed column (newest first in the
   markup), so with no script it opens scrolled to the newest message. */
.chat{display:flex;flex-direction:column-reverse;gap:var(--space-xs);padding:var(--space-sm);background:var(--color-paper-2);height:clamp(16rem,calc(100dvh - 28rem),44rem);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.chat:focus-visible{outline:2px solid var(--color-focus);outline-offset:-2px}
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
.earlier{align-self:center;font-size:var(--text-sm);padding:var(--space-3xs) 0}
.chat__empty{margin:auto;color:var(--color-muted);font-size:var(--text-sm)}
.composer{display:grid;gap:var(--space-2xs);padding:var(--space-sm);border-top:1px solid var(--color-rule);background:var(--color-surface)}
.composer .label{display:block;margin-bottom:var(--space-3xs)}
.textarea{height:auto;min-height:4.5rem;max-height:12rem;padding:var(--space-xs);line-height:1.5;resize:vertical}
.composer__end{display:flex;flex-wrap:wrap;gap:var(--space-2xs);align-items:center;justify-content:space-between}
.composer__end form{margin:0}
.composer__row{display:flex;flex-wrap:wrap;gap:var(--space-2xs);align-items:center;justify-content:space-between}
.composer__hint{font-size:var(--text-xs);color:var(--color-muted)}
.lock{padding:var(--space-sm);border-top:1px solid var(--color-rule);font-size:var(--text-sm);color:var(--color-ink-2);display:grid;gap:var(--space-xs);background:var(--color-surface)}
.side-sm{display:none}
@media (max-width:64rem){.convo{grid-template-columns:minmax(0,1fr)}.convo__side{display:none}.side-sm{display:block;border-bottom:1px solid var(--color-rule)}.side-sm>summary{padding:0 var(--space-sm);font-size:var(--text-sm)}.side-sm .facts-mini{padding:0 var(--space-sm) var(--space-sm)}.chat{height:clamp(16rem,calc(100dvh - 26rem),36rem)}}
@media (max-width:48rem){.ho-card{grid-template-columns:minmax(0,1fr)}.ho-card__end{align-items:flex-start;flex-direction:row}.msg{max-width:92%}.chat{height:clamp(13rem,calc(100dvh - 31rem),26rem)}.thread__bar .muted{display:none}.composer__hint{display:none}}
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

function notConfigured(url: URL, env: Env, config: Config, session: BoardSession, why: string): Promise<Response> {
  return shell({
    env, config, session, url, active: 'handovers', title: 'Handovers', css: CSS,
    body: `${pageHead('Handovers')}${blank('Handovers are not connected.', ` ${h(why)}`)}`,
  });
}

/** The reason as a dispatcher reads it (our internal prefix removed). */
export const shownReason = (r: string) => (r.startsWith(HANDOVER_REASON_PREFIX) ? r.slice(HANDOVER_REASON_PREFIX.length) : r);

/** Cuts at a word boundary and marks the cut, so a preview never ends mid-word. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** Earlier handovers come from the webhook log, which has no customer name: name them by job, else by chat id. */
export function earlierTitle(threadId: string, reason: string | null, thread?: Thread | 'gone'): string {
  if (thread === 'gone') return `Chat no longer in Chord (…${threadId.slice(-6)})`;
  const name = thread?.remote_participant_metadata?.display_name?.trim();
  const job = /\bZD-[0-9A-Z]{5}\b/.exec(reason ?? '')?.[0];
  if (name) return job ? `${name} · ${job}` : name;
  if (thread) return job ? `${contact(thread)} · ${job}` : contact(thread) || `Chat …${threadId.slice(-6)}`;
  return job ? `Chat about ${job}` : `Chat …${threadId.slice(-6)}`;
}

/** GET /board/handovers */
async function inbox(url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const cfg = noticeConfig(env);
  if (!cfg) return notConfigured(url, env, config, session, 'Replying from the board needs CHORD_API_KEY (scopes thread:read and thread:write). Until then, reply in Chord → Teammates → Zuma → Escalated.');
  const sigP = readSignals(env, Date.now()).catch(() => null);
  const [live, recent] = await Promise.all([
    chord<{ threads?: Thread[] }>(cfg, `/v1/threads?${new URLSearchParams({ workspace_id: cfg.workspaceId, control_state: 'human_active,paused', limit: '50' })}`, TIMEOUT_MS),
    env.DB.prepare(`SELECT thread_id, initiator, reason, received_at FROM chord_events WHERE type = 'conversation.escalated' AND thread_id IS NOT NULL ORDER BY received_at DESC LIMIT 40`).all<{
      thread_id: string; initiator: string | null; reason: string | null; received_at: number;
    }>(),
  ]);
  const waiting = live.ok ? (live.data.threads ?? []).filter((t) => THREAD_RE.test(t.id)) : [];
  const waitingIds = new Set(waiting.map((t) => t.id));
  // Latest real handover per thread (ignore our own momentary take-overs).
  const latest = new Map<string, { reason: string | null; initiator: string | null; received_at: number }>();
  for (const e of recent.results) {
    if ((e.reason ?? '').startsWith('zuma-dispatch automated notice')) continue;
    if (!latest.has(e.thread_id)) latest.set(e.thread_id, e);
  }
  const card = (id: string, who: string, state: ControlState, reason: string | null, when: number | null, sub: string) => `<li><a class="ho-card" href="/board/handovers/${h(id)}" style="text-decoration:none">
<div><div class="ho-card__who">${h(who)}</div>${reason ? `<p class="ho-card__reason">${h(clip(shownReason(reason), 220))}</p>` : ''}<p class="ho-card__meta">${h(sub)}</p></div>
<div class="ho-card__end">${stateChip(state)}<span class="ho-card__meta">${when ? time(when) : ''}</span></div></a></li>`;
  const waitingHtml = waiting.length
    ? `<ul class="ho-list">${waiting
        .map((t) => {
          const e = latest.get(t.id);
          return card(t.id, displayName(t), controlState(t.control_state), e?.reason ?? null, t.last_handoff_at ?? e?.received_at ?? t.last_turn_at ?? null, `${contact(t)} · last message: ${clip(t.last_turn_preview ?? '', 80)}`);
        })
        .join('')}</ul>`
    : `<div style="margin-bottom:var(--space-lg)">${live.ok ? blank('Nobody is waiting for a person.', ' When Zuma hands a customer over, the chat appears here with the reason.') : notice(`Could not reach Chord (${chordError(live)}). Recent handovers below come from the webhook log.`, 'error')}</div>`;
  const earlier = [...latest.entries()].filter(([id]) => !waitingIds.has(id)).slice(0, 20);
  // The webhook log has no customer name: ask Chord for each earlier chat (in parallel, 2.5 s cap; reads cost no credits).
  const names = new Map<string, Thread | 'gone'>();
  if (live.ok && earlier.length) {
    const found = await Promise.race([
      Promise.all(earlier.map(([id]) => chord<Thread>(cfg, `/v1/threads/${id}`, 2000).then((r) => (r.ok ? ([id, r.data] as const) : r.failure === 'http' && r.status === 404 ? ([id, 'gone'] as const) : null)).catch(() => null))),
      new Promise<null[]>((r) => setTimeout(() => r([]), 2500)),
    ]);
    for (const f of found) if (f) names.set(f[0], f[1]);
  }
  const earlierHtml = earlier.length
    ? `<ul class="ho-list">${earlier.map(([id, e]) => card(id, earlierTitle(id, e.reason, names.get(id)), live.ok ? 'agent_active' : 'unknown', e.reason, e.received_at, e.initiator === 'human_operator' && !(e.reason ?? '').startsWith(HANDOVER_REASON_PREFIX) ? 'taken over by a person' : 'handed over by Zuma')).join('')}</ul>`
    : '<p class="muted">None yet.</p>';
  return shell({
    env, config, session, url, active: 'handovers', title: 'Handovers', css: CSS, signals: await sigP,
    foot: `${h(config.businessName)} · replies from people cost no AI credits · times in WAT`,
    body: `${pageHead('Handovers', 'Chats Zuma handed to a person. Open one to read the whole conversation, reply as the team, and hand it back.', `<a href="/board/handovers">Refresh</a>`)}
<section aria-labelledby="w-h"><div class="section__head"><h2 id="w-h">Waiting for a person <span class="muted num">(${waiting.length})</span></h2></div>${waitingHtml}</section>
<section class="section" aria-labelledby="e-h"><div class="section__head"><h2 id="e-h">Earlier handovers</h2><p class="muted">Back with Zuma, or closed.</p></div>${earlierHtml}</section>`,
  });
}

/** GET /board/handovers/{id} */
async function conversation(threadId: string, url: URL, env: Env, config: Config, session: BoardSession): Promise<Response> {
  const cfg = noticeConfig(env);
  if (!cfg) return notConfigured(url, env, config, session, 'Reading and replying needs CHORD_API_KEY (scopes thread:read and thread:write).');
  const before = url.searchParams.get('before') ?? '';
  const turnsPath = `/v1/threads/${threadId}/turns?${new URLSearchParams({ limit: '40', ...(before && /^[A-Za-z0-9_=-]{1,200}$/.test(before) ? { cursor: before } : {}) })}`;
  const sigP = readSignals(env, Date.now()).catch(() => null);
  const [th, tu, events] = await Promise.all([
    chord<Thread>(cfg, `/v1/threads/${threadId}`, TIMEOUT_MS),
    chord<{ turns?: Turn[]; next_cursor?: string; has_more?: boolean }>(cfg, turnsPath, TIMEOUT_MS),
    env.DB.prepare(`SELECT reason, initiator, received_at, ack FROM chord_events WHERE thread_id = ? AND type = 'conversation.escalated' ORDER BY received_at DESC LIMIT 5`).bind(threadId).all<{
      reason: string | null; initiator: string | null; received_at: number; ack: string | null;
    }>(),
  ]);
  if (!th.ok) {
    const status = th.failure === 'http' && th.status === 404 ? 404 : 502;
    return shell({
      env, config, session, url, active: 'handovers', title: 'Conversation', status, css: CSS, signals: await sigP,
      body: `${pageHead(status === 404 ? 'No such conversation' : 'Could not reach Chord', '', '', '<a class="crumb" href="/board/handovers">← Handovers</a>')}${blank(status === 404 ? 'Chord has no conversation with this id.' : 'The conversation could not be loaded.', ` ${h(chordError(th))}. <a href="${h(`/board/handovers/${threadId}`)}">Try again</a>.`)}`,
    });
  }
  const t = th.data;
  const state = controlState(t.control_state);
  const turns = tu.ok ? tu.data.turns ?? [] : [];
  const reasons = events.results.map((e) => e.reason).filter((r) => r && !r.startsWith('zuma-dispatch automated notice'));
  const jobId = jobIdIn(turns, reasons);
  const nonce = crypto.randomUUID();
  const self = `/board/handovers/${threadId}`;
  const hidden = (action: string) => `<input type="hidden" name="nonce" value="${nonce}-${action}"><input type="hidden" name="action" value="${action}">`;

  // Newest first: the panel is a reversed column, so this shows oldest at the top and opens at the newest.
  const bubbles = [...turns]
    .reverse()
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
<label for="reply-text" class="label">Reply as the Zuma Dispatch team</label>
<textarea class="input textarea" id="reply-text" name="text" rows="3" maxlength="${MAX_REPLY}" required placeholder="Hi, this is the Zuma Dispatch team…"></textarea>
<div class="composer__end"><span class="composer__hint">Signed “${TEAM_SIGNATURE}”. No AI credits used.</span>
<div class="actions"><button class="btn" type="submit" name="action" value="reply_handback">Send and hand back</button><button class="btn btn--primary" type="submit" name="action" value="reply">Send</button></div></div>
</form>
<div class="lock" style="border-top:0;padding-top:0"><form class="inline" method="post" action="${h(self)}">${hidden('handback')}<button class="btn btn--sm btn--ghost" type="submit">Hand back to Zuma without replying</button></form></div>`
    : `<div class="lock" id="reply"><span>${state === 'agent_active' ? 'Zuma (the AI) is answering this chat. To reply yourself, take it over: the customer will see “connecting you with a teammate”, and Zuma stops replying until you hand it back.' : state === 'paused' ? 'This chat is paused: nobody replies. Take it over to reply, or resume Zuma.' : 'Chord did not report who holds this chat.'}</span>
<div class="actions"><form class="inline" method="post" action="${h(self)}">${hidden('takeover')}<button class="btn btn--primary" type="submit">Take over</button></form>${
        state === 'paused' ? `<form class="inline" method="post" action="${h(self)}">${hidden('resume')}<button class="btn" type="submit">Resume Zuma</button></form>` : ''
      }</div></div>`;

  const facts = `<dl class="facts-mini"><dt>Customer</dt><dd>${h(displayName(t))}</dd><dt>Channel</dt><dd>${h(contact(t))}</dd>
<dt>Job</dt><dd>${jobId ? `<a class="mono" href="/board/jobs/${h(jobId)}">${h(jobId)}</a>` : '—'}</dd>
<dt>Handed over</dt><dd>${events.results[0] ? time(events.results[0].received_at) : t.last_handoff_at ? time(t.last_handoff_at) : '—'}</dd>
<dt>Customer told</dt><dd>${events.results[0]?.ack === 'sent' ? 'yes' : h(events.results[0]?.ack ?? '—')}</dd>
${reasons[0] ? `<dt>Why</dt><dd>${h(shownReason(reasons[0]))}</dd>` : ''}</dl>`;
  const side = `<aside class="convo__side" aria-label="About this chat"><h2 style="font-size:var(--text-md)">About this chat</h2>${facts}</aside>`;
  const sideSmall = `<details class="side-sm"><summary>About this chat${jobId ? ` · ${h(jobId)}` : ''}</summary>${facts}</details>`;

  return shell({
    env, config, session, url, active: 'handovers', title: `${displayName(t)} · Handover`, css: CSS, signals: await sigP,
    foot: `${h(config.businessName)} · conversation from Chord · times in WAT`,
    body: `${pageHead(h(displayName(t)), '', stateChip(state), '<a class="crumb" href="/board/handovers">← Handovers</a>')}
<div class="convo">
<section class="thread" aria-label="Conversation">
<div class="thread__bar"><span class="muted">${turns.length} message${turns.length === 1 ? '' : 's'}${before ? ' (earlier page)' : ''} · newest at the bottom</span><a href="${h(self)}">Refresh</a></div>
${sideSmall}
<div class="chat" role="log" aria-label="Messages, oldest first" tabindex="0">${bubbles || `<p class="chat__empty">${tu.ok ? 'No messages yet.' : `Could not load messages (${h(chordError(tu))}).`}</p>`}${newestLink}${earlierLink}</div>
${composer}
</section>
${side}
</div>`,
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
  const self = `/board/handovers/${threadId}`; // the result shows at the top; the chat panel opens at the newest message
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
export async function handovers(request: Request, url: URL, env: Env, config: Config, session: BoardSession): Promise<Response | null> {
  if (url.pathname === '/board/handovers' || url.pathname === '/board/handovers/') {
    return request.method === 'GET' || request.method === 'HEAD' ? inbox(url, env, config, session) : null;
  }
  const m = /^\/board\/handovers\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  const id = m[1]!;
  if (!THREAD_RE.test(id)) {
    return shell({ env, config, session, url, active: 'handovers', title: 'Not found', status: 404, css: CSS, noSignals: true, body: `${pageHead('No such conversation', '', '', '<a class="crumb" href="/board/handovers">← Handovers</a>')}${blank('That is not a Chord conversation id.', ' <a href="/board/handovers">Back to handovers</a>.')}` });
  }
  if (request.method === 'POST') return act(request, url, env, id);
  return conversation(id, url, env, config, session);
}
