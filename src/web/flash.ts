import type { Env } from '../env';
import { sha256Hex } from './session';

/**
 * The one-line message shown after an action travels in the redirect URL, signed with a key derived
 * from BOARD_TOKEN. A crafted link (?msg=Approved…) therefore cannot put words on the signed-in board.
 */
async function flashSig(secret: string, msg: string, error: boolean): Promise<string> {
  return (await sha256Hex(`zuma-board-flash:${secret}:${error ? 'e' : 'i'}:${msg}`)).slice(0, 24);
}

/** The verified flash message for this page, or null if absent or unsigned. */
export async function readFlash(url: URL, secret: string): Promise<{ msg: string; error: boolean } | null> {
  const msg = url.searchParams.get('msg');
  const sig = url.searchParams.get('sig');
  if (!msg || !sig || msg.length > 300) return null;
  const error = url.searchParams.get('tone') === 'error';
  return sig === (await flashSig(secret, msg, error)) ? { msg, error } : null;
}

export async function backTo(url: URL, env: Env, path: string, msg: string, error: boolean): Promise<Response> {
  const target = new URL(path, url.origin);
  const text = msg.slice(0, 300);
  target.searchParams.set('msg', text);
  if (error) target.searchParams.set('tone', 'error');
  target.searchParams.set('sig', await flashSig(env.BOARD_TOKEN?.trim() ?? '', text, error));
  return Response.redirect(target.toString(), 303);
}

