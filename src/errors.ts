// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
/** imapflow "connection is gone" errors (half-open TCP, close, logout, socket timeout). */
export function isConnectionGone(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === 'NoConnection' ||
    code === 'EConnectionClosed' ||
    code === 'StateLogout' ||
    code === 'ETIMEOUT'
  ) {
    return true;
  }
  return err.message.includes('Connection not available');
}

/**
 * imapflow collapses server rejections into `Error('Command failed')`.
 * The reason lives in responseStatus/serverResponseCode/responseText - surface it.
 */
export function formatImapError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & {
    responseStatus?: string;
    serverResponseCode?: string;
    responseText?: string;
    response?: unknown;
  };
  const parts: string[] = [e.message];
  if (e.responseStatus) parts.push(`status=${e.responseStatus}`);
  if (e.serverResponseCode) parts.push(`code=${e.serverResponseCode}`);
  const text =
    (typeof e.responseText === 'string' && e.responseText.trim()) ||
    (typeof e.response === 'string' && e.response.trim()) ||
    '';
  if (text) parts.push(`server: ${text.replace(/\s+/g, ' ').trim()}`);
  return parts.join(' | ');
}
