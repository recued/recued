/** Interactive stdin password prompt with echo suppressed.
 *
 *  Uses Node's tty raw mode to read characters without displaying them.
 *  Handles Ctrl+C, backspace, and Enter. Falls back to plain line read
 *  when stdin isn't a tty (e.g., piping a password via stdin — useful
 *  for automation).
 *
 *  Writes the prompt label to stderr so that stdout stays usable for
 *  piping the result if ever needed.
 */

import { createInterface } from 'node:readline';

const writePrompt = (text: string): void => {
  process.stderr.write(text);
};

const writeNewline = (): void => {
  process.stderr.write('\n');
};

/** Read a secret line from stdin. Hides input when stdin is a tty. */
export const promptSecret = async (label: string): Promise<string> => {
  writePrompt(label);

  if (!process.stdin.isTTY) {
    // Non-interactive — read until newline or EOF.
    return new Promise<string>((resolve, reject) => {
      const rl = createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        rl.close();
        resolve(line);
      });
      rl.once('close', () => resolve(''));
      rl.once('error', reject);
    });
  }

  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      try { stdin.setRawMode(false); } catch { /* ignore */ }
      stdin.pause();
      stdin.removeListener('data', onData);
    };

    const onData = (data: string) => {
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 0x03) {
          // Ctrl+C
          cleanup();
          writeNewline();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          writeNewline();
          resolve(chars.join(''));
          return;
        }
        if (code === 0x7f || code === 0x08) {
          // Backspace / Delete
          if (chars.length > 0) chars.pop();
          continue;
        }
        chars.push(ch);
      }
    };

    stdin.on('data', onData);
  });
};

/** Read a plain (echoed) line. Used for the recovery-key prompt where
 *  users want to see what they're typing (mnemonic words). */
export const promptLine = async (label: string): Promise<string> => {
  writePrompt(label);
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
    rl.once('close', () => resolve(''));
    rl.once('error', reject);
  });
};
