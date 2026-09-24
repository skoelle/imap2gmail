// Copyright (c) 2026 Stefan Koelle (https://stefankoelle.de)
// Licensed under the MIT License. See LICENSE file in project root for details.
/** imapflow "connection is gone" errors (half-open TCP, close, logout). */
export function isConnectionGone(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'NoConnection' || code === 'EConnectionClosed' || code === 'StateLogout') {
    return true;
  }
  return err.message.includes('Connection not available');
}
