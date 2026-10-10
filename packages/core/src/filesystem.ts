import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export function inside(root: string, target: string, allowRoot = false) {
  const relative = path.relative(root, target);
  return (allowRoot || relative !== '') && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function nonemptyPath(input: unknown, label: string): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error(`${label} must be a nonempty filesystem path`);
  return path.resolve(input);
}
export async function canonicalDirectory(input: unknown, label: string): Promise<string> {
  const resolved = nonemptyPath(input, label);
  const canonical = await fs.realpath(resolved).catch(error => { throw new Error(`${label} directory does not exist: ${resolved} (${errorMessage(error)})`); });
  if (!(await fs.lstat(canonical)).isDirectory()) throw new Error(`${label} must be a directory: ${resolved}`);
  return canonical;
}

// Canonicalize system/home prefixes, while rejecting user-controlled symlink parents.
export async function storageDirectory(input: unknown): Promise<string> {
  const resolved = nonemptyPath(input, 'Data directory');
  const boundaries = [os.tmpdir(), process.cwd(), os.homedir()].map(p => path.resolve(p)).filter(p => inside(p, resolved, true)).sort((a, b) => b.length - a.length);
  const boundary = boundaries[0] ?? path.parse(resolved).root;
  const canonicalBoundary = await fs.realpath(boundary);
  const relative = path.relative(boundary, resolved);
  let current = canonicalBoundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe data directory parent; expected a real directory: ${current}`);
  }
  return current;
}

export async function lstatOptional(target: string) {
  try { return await fs.lstat(target); } catch (error) { if (missing(error)) return undefined; throw error; }
}

export async function parentIdentities(target: string, boundary: string): Promise<{ path: string; fingerprint: string }[]> {
  if (!inside(boundary, target, true)) throw new Error(`Path escapes its authorized directory: ${target}`);
  const result: { path: string; fingerprint: string }[] = [];
  const relative = path.relative(boundary, path.dirname(target));
  let current = boundary;
  const parents = [boundary];
  if (target !== boundary) for (const segment of relative.split(path.sep).filter(Boolean)) { current = path.join(current, segment); parents.push(current); }
  for (const parent of parents) {
    const stat = await lstatOptional(parent);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error(`Unsafe symlink or non-directory parent: ${parent}`);
    result.push({ path: parent, fingerprint: stat ? `parent:${stat.dev}:${stat.ino}` : 'parent:missing' });
  }
  return result;
}

export async function guard(target: string, boundary: string, allowLeafSymlink = false): Promise<void> {
  await parentIdentities(target, boundary);
  const stat = await lstatOptional(target);
  if (!allowLeafSymlink && stat?.isSymbolicLink()) throw new Error(`Refusing to follow a symlink file or directory: ${target}`);
}

export async function ensureDirectory(directory: string, boundary: string, created?: (p: string) => Promise<void>): Promise<void> {
  if (!inside(boundary, directory, true)) throw new Error(`Directory escapes its authorized root: ${directory}`);
  await guard(boundary, boundary);
  const segments = path.relative(boundary, directory).split(path.sep).filter(Boolean);
  let current = boundary;
  for (const segment of segments) {
    current = path.join(current, segment);
    await guard(current, boundary);
    const stat = await lstatOptional(current);
    if (stat && !stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
    if (!stat) {
      await fs.mkdir(current, { mode: 0o700 });
      await created?.(current);
    }
  }
}

export async function readBytes(target: string, boundary: string): Promise<Buffer> {
  await guard(target, boundary);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Expected a regular file: ${target}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}

export async function readFile(target: string, boundary: string): Promise<string> {
  return (await readBytes(target, boundary)).toString('utf8');
}

export async function treeHash(target: string, boundary: string): Promise<string> {
  await guard(target, boundary);
  const hash = createHash('sha256');
  async function visit(current: string, relative = ''): Promise<void> {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported special file in managed resource: ${current}`);
    hash.update(`${relative}\0${stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'}\0`);
    if (stat.isSymbolicLink()) hash.update(await fs.readlink(current));
    else if (stat.isFile()) hash.update(await readBytes(current, boundary));
    else for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name), path.join(relative, name));
  }
  await visit(target);
  return hash.digest('hex');
}

export async function fingerprint(target: string, boundary: string): Promise<string> {
  await guard(target, boundary, true);
  const stat = await lstatOptional(target);
  if (!stat) return 'missing';
  if (stat.isSymbolicLink()) return `link:${await fs.readlink(target)}`;
  if (stat.isFile()) return `file:${createHash('sha256').update(await readBytes(target, boundary)).digest('hex')}`;
  if (stat.isDirectory()) return `dir:${await treeHash(target, boundary)}`;
  throw new Error(`Unsupported special file: ${target}`);
}

export async function exclusiveWrite(target: string, content: string, boundary: string): Promise<void> {
  await ensureDirectory(path.dirname(target), boundary);
  await guard(target, boundary);
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWrite(target: string, content: string, boundary: string): Promise<void> {
  await ensureDirectory(path.dirname(target), boundary);
  await guard(target, boundary);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await exclusiveWrite(temporary, content, boundary);
    await guard(target, boundary);
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
}

export async function removeOwned(target: string, boundary: string): Promise<void> {
  await guard(target, boundary, true);
  const stat = await lstatOptional(target);
  if (!stat) return;
  if (stat.isSymbolicLink() || stat.isFile()) await fs.unlink(target);
  else if (stat.isDirectory()) await fs.rm(target, { recursive: true });
  else throw new Error(`Refusing to remove special file: ${target}`);
}
