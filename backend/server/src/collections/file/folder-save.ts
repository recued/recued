/** D-318 follow-up 11 — chat files an emailed attachment into a folder the
 *  owner names: *"ask: put this in my Receipts folder"*.
 *
 *  An email chat turn already carries the email's attachments as its files
 *  (D-318 §8.6), and the model sees each by its record id. Two kernel ops
 *  finish the job, behind two chat tools ("My folders", "Save a file to a
 *  folder"):
 *
 *  - `file-folders` (read): the owner's connected folders (file instances),
 *    whether each takes a file now, and the folders inside each that hold
 *    files.
 *  - `file-save-to-folder` (write): save one stored file into the folder the
 *    owner named, found the way they would say it (`resolveFolder`).
 *
 *  This module is the pure part: finding the folder, and the name to save as.
 *  The handlers that read the instances and write are in `dispatcher.ts`,
 *  beside the gates they share with `file-put-ref`.
 *
 *  ⛔ NEVER OVER ANOTHER FILE. A folder adapter writes in place (`fs` is
 *  `writeFile`), so saving under a taken name would replace the owner's file.
 *  A taken name gets a number, as a desktop does: `scan.pdf`, `scan (2).pdf`.
 *
 *  ⛔ A NAME THAT FITS TWO FOLDERS SAVES NOTHING. "Receipts" inside two
 *  connected folders is the owner's to choose, so the refusal names both. A
 *  name that fits none names the folders there are. */

/** Files read per connected folder to find the folders inside it. */
export const FILE_FOLDERS_SCAN_MAX = 5_000;
/** Folders inside one connected folder that are listed and matched. */
export const FILE_FOLDERS_SUBFOLDER_MAX = 50;
/** Numbered names tried before a save gives up: `scan (2).pdf` … */
export const FILE_SAVE_NAME_TRIES = 100;
/** The longest file name a save takes. */
export const FILE_SAVE_NAME_MAX = 200;

/** One connected folder, as chat reads it. */
export interface FileFolderView {
  /** The connected folder's name (its file instance's slug). */
  readonly folder: string;
  /** The adapter behind it: `fs` for a folder on this machine, `s3`, … */
  readonly adapter: string;
  /** For a folder on this machine, its own name on disk (the root's last part,
   *  never the whole path), so "my Receipts folder" finds a folder connected as
   *  `docs` from `…/Receipts`. `null` otherwise. */
  readonly root_name: string | null;
  /** Whether a file can be saved into it now: its adapter writes, its sign-in
   *  is healthy, and it is running. */
  readonly writable: boolean;
  /** The folders inside it that hold files, as paths from it, sorted. At most
   *  `FILE_FOLDERS_SUBFOLDER_MAX`. An empty folder holds no file, so it is not
   *  here: name it by its path (`docs/Receipts`) and the save creates it. */
  readonly subfolders: readonly string[];
  /** The same, as one line for a table: `Receipts, Taxes/2026`. */
  readonly inside: string;
}

/** The folders inside a connected folder that hold files, from the paths of the
 *  files it holds: `a/b/c.pdf` gives `a` and `a/b`. */
export const subfoldersOf = (paths: readonly string[]): string[] => {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, FILE_FOLDERS_SUBFOLDER_MAX);
};

export type FolderResolution =
  | { readonly kind: 'found'; readonly folder: string; readonly dir: string }
  /** More than one fits; each as `folder/dir`. */
  | { readonly kind: 'ambiguous'; readonly matches: readonly string[] }
  | { readonly kind: 'none' }
  /** A `.` or `..` in the name: never a folder. */
  | { readonly kind: 'invalid' };

const words = (text: string): string => text.trim().toLowerCase();
const segmentsOf = (text: string): string[] =>
  text.split(/[\\/]+/).map((part) => part.trim()).filter((part) => part.length > 0);

/** The folder the owner named, as they would say it:
 *  1. a connected folder, by its name or its own name on disk, with a path
 *     inside it if they gave one (`Receipts`, `docs/Receipts/2026`). The path
 *     need not exist yet: the owner named it, and the save creates it;
 *  2. else a folder inside a connected one, by its own name or its last parts
 *     (`Receipts`, `Finance/Receipts`), which must hold a file already.
 *  A connected folder of that name wins over a folder inside another. */
export const resolveFolder = (folders: readonly FileFolderView[], said: string): FolderResolution => {
  const segments = segmentsOf(said);
  if (segments.length === 0) return { kind: 'none' };
  if (segments.some((part) => part === '.' || part === '..')) return { kind: 'invalid' };

  const first = words(segments[0]!);
  const named = folders.filter((folder) =>
    words(folder.folder) === first || (folder.root_name !== null && words(folder.root_name) === first));
  if (named.length > 1) return { kind: 'ambiguous', matches: named.map((folder) => folder.folder) };
  if (named.length === 1) {
    const folder = named[0]!;
    const rest = segments.slice(1).join('/');
    // The folder's own spelling when it is already there.
    const existing = folder.subfolders.find((dir) => words(dir) === words(rest));
    return { kind: 'found', folder: folder.folder, dir: existing ?? rest };
  }

  const tail = segments.map(words).join('/');
  const matches = folders.flatMap((folder) => folder.subfolders
    .filter((dir) => words(dir) === tail || words(dir).endsWith(`/${tail}`))
    .map((dir) => ({ folder: folder.folder, dir })));
  if (matches.length === 1) return { kind: 'found', folder: matches[0]!.folder, dir: matches[0]!.dir };
  if (matches.length > 1) return { kind: 'ambiguous', matches: matches.map((match) => `${match.folder}/${match.dir}`) };
  return { kind: 'none' };
};

/** A file name to save as, or `null` for one that is not a plain name: empty,
 *  `.` or `..`, or carrying a path. Control characters go; a long name keeps
 *  its extension. */
export const safeFileName = (raw: string): string | null => {
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0 || name === '.' || name === '..' || /[\\/]/.test(name)) return null;
  if (name.length <= FILE_SAVE_NAME_MAX) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  return `${name.slice(0, FILE_SAVE_NAME_MAX - ext.length)}${ext}`;
};

/** The `n`th name for `name` when it is taken: `scan (2).pdf`. */
export const numberedName = (name: string, n: number): string => {
  if (n <= 1) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

/** Where a saved file is, as the owner reads it: `docs/Receipts`. */
export const folderWords = (folder: string, dir: string): string => (dir.length > 0 ? `${folder}/${dir}` : folder);

/** Why nothing was saved, in words the model can pass on. */
export const folderRefusal = (
  said: string,
  resolution: Exclude<FolderResolution, { kind: 'found' }>,
  folders: readonly FileFolderView[],
): string => {
  if (resolution.kind === 'invalid') return `"${said}" is not a folder name: it may not hold "." or "..".`;
  if (resolution.kind === 'ambiguous') {
    return `"${said}" fits more than one folder: ${resolution.matches.join(', ')}. Ask the owner which.`;
  }
  const writable = folders.filter((folder) => folder.writable).map((folder) => folder.folder);
  return writable.length === 0
    ? `There is no folder called "${said}", and no connected folder Recued can save into.`
      + ' The owner can connect one in Connections, under Files.'
    : `There is no folder called "${said}". The folders Recued can save into: ${writable.join(', ')}.`;
};
