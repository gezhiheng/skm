import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ApplyResult, OperationPlan } from './types.js';
import { ensureDirectory, errorMessage, exclusiveWrite, fingerprint, guard, inside, lstatOptional, missing, removeOwned, treeHash } from './filesystem.js';

interface Undo {
  index: number;
  target: string;
  boundary: string;
  before: string;
  after: string;
  backup: string;
  stage: string;
  reservationInode?: number;
}
export interface Journal { planId: string; entries: Undo[]; directories: { path: string; boundary: string }[] }
export interface TransactionStore {
  writeJournal(journal: Journal): Promise<void>;
  deleteJournal(id: string): Promise<void>;
  saveResult(result: ApplyResult): Promise<void>;
}

async function cleanup(journal: Journal): Promise<void> {
  for (const entry of journal.entries) {
    for (const [target, expected] of [[entry.stage, entry.after], [entry.backup, entry.before]]) {
      const current = await fingerprint(target, entry.boundary);
      if (current === 'missing') continue;
      if (current !== expected) throw new Error(`Preserved changed transaction file: ${target}; inspect it before retrying cleanup.`);
      await removeOwned(target, entry.boundary);
    }
  }
}

async function removeStage(entry: Undo): Promise<void> {
  const current = await fingerprint(entry.stage, entry.boundary);
  if (current === 'missing') return;
  if (current !== entry.after) throw new Error(`Preserved changed transaction stage: ${entry.stage}; inspect it before retrying.`);
  await removeOwned(entry.stage, entry.boundary);
}

async function rollback(journal: Journal): Promise<void> {
  for (const entry of [...journal.entries].reverse()) {
    await guard(entry.target, entry.boundary, true);
    await guard(entry.backup, entry.boundary, true);
    const backupExists = Boolean(await lstatOptional(entry.backup));
    const current = await fingerprint(entry.target, entry.boundary);
    if (!backupExists && current === entry.before) { await removeStage(entry); continue; }
    const stat = await lstatOptional(entry.target);
    const ownReservation = stat?.isDirectory() && stat.ino === entry.reservationInode && (await fs.readdir(entry.target)).length === 0;
    if (current !== entry.after && current !== 'missing' && !ownReservation) throw new Error(`Rollback preserved a changed path: ${entry.target}. Its backup remains at ${entry.backup}; inspect it before retrying.`);
    if (current !== 'missing') await removeOwned(entry.target, entry.boundary);
    if (backupExists) {
      if (await fingerprint(entry.backup, entry.boundary) !== entry.before) throw new Error(`Rollback backup has changed: ${entry.backup}`);
      await fs.rename(entry.backup, entry.target);
    } else if (entry.before !== 'missing') throw new Error(`Rollback backup is missing: ${entry.backup}`);
    await removeStage(entry);
  }
  for (const directory of [...journal.directories].reverse()) {
    await guard(directory.path, directory.boundary);
    await fs.rmdir(directory.path).catch(error => {
      if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
    });
  }
}

function temporaryPaths(plan: OperationPlan, index: number, target: string) {
  return { backup: `${target}.skm-${plan.id}-${index}.backup`, stage: `${target}.skm-${plan.id}-${index}.stage` };
}

export async function recoverTransaction(journal: Journal, plan: OperationPlan, committed: boolean, store: TransactionStore, boundaryFor: (target: string) => string): Promise<void> {
  if (journal.planId !== plan.id || !Array.isArray(journal.entries) || !Array.isArray(journal.directories)) throw new Error('Invalid operation recovery journal');
  for (const entry of journal.entries) {
    const step = plan.steps[entry.index];
    if (!step || step.path !== entry.target || entry.boundary !== boundaryFor(entry.target) || !inside(entry.boundary, entry.target) || entry.before !== step.expected) throw new Error('Recovery journal does not match its saved plan');
    const names = temporaryPaths(plan, entry.index, entry.target);
    if (entry.backup !== names.backup || entry.stage !== names.stage) throw new Error('Recovery journal contains an invalid backup path');
  }
  for (const directory of journal.directories) {
    if (directory.boundary !== boundaryFor(directory.path) || !plan.steps.some(step => step.path && boundaryFor(step.path) === directory.boundary && inside(directory.path, step.path))) throw new Error('Recovery journal contains an unauthorized created directory');
  }
  if (committed) await cleanup(journal);
  else {
    await rollback(journal);
    await cleanup(journal);
    await store.saveResult({ planId: plan.id, success: false, completed: [], failed: { step: 'recovery', error: 'An interrupted operation was rolled back. Retry the saved plan or create a new plan.' }, rolledBack: true, retryable: true });
  }
  await store.deleteJournal(plan.id);
}

export async function runTransaction(plan: OperationPlan, boundaryFor: (target: string) => string, store: TransactionStore): Promise<ApplyResult> {
  const journal: Journal = { planId: plan.id, entries: [], directories: [] };
  const completed: string[] = [];
  let currentStep = 'operation';
  await store.writeJournal(journal);
  try {
    for (const [index, step] of plan.steps.entries()) {
      currentStep = step.description;
      if (!step.path || step.expected === undefined) throw new Error('Executable plan step must have a path and expected fingerprint');
      const target = step.path, boundary = boundaryFor(target);
      await ensureDirectory(path.dirname(target), boundary, async directory => {
        journal.directories.push({ path: directory, boundary });
        await store.writeJournal(journal);
      });
      await guard(target, boundary, step.action === 'remove-link');
      const before = await fingerprint(target, boundary);
      if (before !== step.expected) throw new Error(`Path changed after plan validation: ${target}`);
      const names = temporaryPaths(plan, index, target);
      if (await lstatOptional(names.stage) || await lstatOptional(names.backup)) throw new Error(`Transaction staging path already exists for ${target}; inspect it before retrying.`);
      let after = 'missing';
      if (step.action === 'copy' || step.action === 'replace-copy') {
        if (!step.source) throw new Error('Copy step lacks a source');
        const sourceBoundary = boundaryFor(step.source);
        await guard(step.source, sourceBoundary);
        const hash = await treeHash(step.source, sourceBoundary);
        after = `dir:${hash}`;
      } else if (step.action === 'symlink') {
        if (!step.source) throw new Error('Symlink step lacks a source');
        after = `link:${step.source}`;
      } else if (step.action === 'write') {
        // Know the staged content before creation so interrupted writes can be checked safely.
        after = `file:${createHash('sha256').update(step.content ?? '').digest('hex')}`;
      }
      const entry: Undo = { index, target, boundary, before, after, ...names };
      journal.entries.push(entry);
      await store.writeJournal(journal);
      if (step.action === 'copy' || step.action === 'replace-copy') {
        await fs.cp(step.source!, entry.stage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
        if (await fingerprint(entry.stage, boundary) !== after) throw new Error(`Staged copy verification failed: ${target}`);
      } else if (step.action === 'write') {
        await exclusiveWrite(entry.stage, step.content ?? '', boundary);
        if (await fingerprint(entry.stage, boundary) !== entry.after) throw new Error(`Staged write verification failed: ${target}`);
      }
      await guard(target, boundary, step.action === 'remove-link');
      if (await fingerprint(target, boundary) !== before) throw new Error(`Path changed while preparing ${target}`);
      if (before !== 'missing') {
        if (step.action === 'copy' || step.action === 'symlink') throw new Error(`Destination already exists: ${target}`);
        if (step.action === 'remove-link' && !(await fs.lstat(target)).isSymbolicLink()) throw new Error(`Expected a managed symbolic link: ${target}`);
        if (step.action !== 'remove-link' && (await fs.lstat(target)).isSymbolicLink()) throw new Error(`Refusing to replace or recursively remove a symlink: ${target}`);
        await fs.rename(target, entry.backup);
      }
      if (step.action === 'copy' || step.action === 'replace-copy') {
        await fs.mkdir(target, { mode: 0o700 });
        entry.reservationInode = (await fs.lstat(target)).ino;
        await store.writeJournal(journal);
        if ((await fs.lstat(target)).ino !== entry.reservationInode || (await fs.readdir(target)).length) throw new Error(`Directory reservation changed: ${target}`);
        await fs.rename(entry.stage, target);
      } else if (step.action === 'write') {
        await fs.link(entry.stage, target);
        await fs.unlink(entry.stage);
      } else if (step.action === 'symlink') {
        await fs.symlink(step.source!, target, 'dir');
      }
      if (await fingerprint(target, boundary) !== entry.after) throw new Error(`Filesystem verification failed: ${target}`);
      if (step.action === 'symlink' && !(await fs.stat(target).catch(() => undefined))?.isDirectory()) throw new Error(`Installed symlink is broken: ${target}`);
      completed.push(step.description);
    }
    const result: ApplyResult = { planId: plan.id, success: true, completed };
    await store.saveResult(result);
    try { await cleanup(journal); await store.deleteJournal(plan.id); }
    catch (error) { result.warnings = [`Operation committed, but recovery files require attention: ${errorMessage(error)}`]; await store.saveResult(result); }
    return result;
  } catch (error) {
    let rolledBack = false, rollbackError = '';
    try { await rollback(journal); rolledBack = true; await cleanup(journal); await store.deleteJournal(plan.id); }
    catch (failure) { rollbackError = ` ${errorMessage(failure)}`; }
    const result: ApplyResult = { planId: plan.id, success: false, completed, failed: { step: currentStep, error: `${errorMessage(error)}${rollbackError}` }, rolledBack, retryable: rolledBack };
    await store.saveResult(result);
    return result;
  }
}
