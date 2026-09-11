/** Host process identity. No program is executed to prepare this description.
 * File versions include inode/creation/change identity as well as content, so
 * delete/recreate and edit/restore cannot inherit an earlier review. */
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';
import { preapprovalHash } from './preapproval-invocations.js';

const fingerprints = new Map<string, { hash: string; shebang: string | null }>();
const version = (stat: BigIntStats) => ({ device: String(stat.dev), inode: String(stat.ino),
  created_ns: String(stat.birthtimeNs), changed_ns: String(stat.ctimeNs), modified_ns: String(stat.mtimeNs), size: String(stat.size) });
const fileIdentity = (path: string) => {
  const real = realpathSync(path);
  const stat = statSync(real, { bigint: true });
  if (!stat.isFile() || stat.size > 268_435_456n) throw new Error('The executable or script is not a bounded regular file.');
  const stamp = version(stat);
  const key = preapprovalHash([real, stamp]);
  let cached = fingerprints.get(key);
  if (!cached) {
    const fd = openSync(real, constants.O_RDONLY);
    try {
      const hash = createHash('sha256'); const buffer = Buffer.alloc(65_536);
      let position = 0; let shebang: string | null = null;
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, position);
        if (!count) break;
        if (position === 0 && buffer[0] === 35 && buffer[1] === 33) {
          shebang = buffer.subarray(2, Math.min(count, 512)).toString('utf8').split('\n', 1)[0]!.trim();
        }
        position += count; hash.update(buffer.subarray(0, count));
      }
      if (preapprovalHash(version(fstatSync(fd, { bigint: true }))) !== preapprovalHash(stamp)
        || preapprovalHash(version(statSync(real, { bigint: true }))) !== preapprovalHash(stamp)) {
        throw new Error('The executable or script changed while its identity was read.');
      }
      cached = { hash: hash.digest('hex'), shebang };
      if (fingerprints.size >= 64) fingerprints.delete(fingerprints.keys().next().value!);
      fingerprints.set(key, cached);
    } finally { closeSync(fd); }
  }
  return { path: real, ...stamp, sha256: cached.hash, shebang: cached.shebang };
};

const findExecutable = (command: string, cwd: string, environment: NodeJS.ProcessEnv): string => {
  const candidates = command.includes('/') || isAbsolute(command) ? [resolve(cwd, command)]
    : (environment.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(cwd, dir || '.', command));
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return realpathSync(candidate); }
    catch { /* Try the next path entry. */ }
  }
  throw new Error('The enrolled executable cannot be resolved on this host.');
};

export const describeProcessBinding = (input: { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }) => {
  const environment = input.env ?? process.env;
  const cwd = realpathSync(input.cwd ?? process.cwd());
  const dir = statSync(cwd, { bigint: true });
  if (!dir.isDirectory()) throw new Error('The process working scope is unavailable.');
  const executable = fileIdentity(findExecutable(input.command, cwd, environment));
  const name = basename(input.command).toLowerCase();
  if (['npx', 'npm', 'pnpm', 'yarn', 'uv', 'uvx', 'pipx', 'bunx'].includes(name)) {
    throw new Error('A package launcher cannot freeze a future executable; use the installed executable or script.');
  }
  const interpreters = [];
  if (executable.shebang) {
    const words = executable.shebang.split(/\s+/);
    let interpreter = words[0]!;
    if (basename(interpreter) === 'env') {
      if (words.length !== 2 || words[1]!.startsWith('-')) throw new Error('The script interpreter cannot be resolved without execution.');
      interpreter = words[1]!;
    }
    interpreters.push(fileIdentity(findExecutable(interpreter, cwd, environment)));
  }
  const scripts = [];
  if (/^(node(?:js)?|python[\d.]*|ruby[\d.]*|perl[\d.]*|bash|dash|sh|zsh)$/.test(name)) {
    const args = input.args;
    // Eval input is already immutable argv. Module/package discovery is a
    // mutable binding and must be resolved before requesting review.
    if (args.some(arg => ['-m', '-r', '--require', '--import', '--loader', '--experimental-loader'].includes(arg)
      || ['--require=', '--import=', '--loader='].some(prefix => arg.startsWith(prefix)))) {
      throw new Error('The interpreter module binding is unresolved.');
    }
    if (!args.some(arg => ['-e', '--eval', '-p', '--print', '-c'].includes(arg) || arg.startsWith('--eval='))) {
      const script = args.find(arg => !arg.startsWith('-'));
      if (script) scripts.push(fileIdentity(resolve(cwd, script)));
    }
  }
  return { executable, interpreters, scripts,
    cwd: { path: cwd, device: String(dir.dev), inode: String(dir.ino), created_ns: String(dir.birthtimeNs) },
    environment_hash: preapprovalHash(Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined))) };
};
