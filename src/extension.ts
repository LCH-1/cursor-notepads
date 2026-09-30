import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import initSqlJs, { SqlJsStatic } from 'sql.js';
import { ManagedNote, NOTE_SCHEME, NoteFileSystem } from './noteFileSystem';
import { NoteIconThemeController } from './noteIconTheme';

let VERBOSE = false;
let outputChannel: vscode.OutputChannel;

function log(...args: any[]) {
  if (outputChannel) {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    outputChannel.appendLine(`[LOG] ${message}`);
  }
}

function warn(...args: any[]) {
  if (outputChannel) {
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    outputChannel.appendLine(`[WARN] ${message}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.stat(file); return true; } catch { return false; }
}

async function findWorkspaceMappingIdFromStorageUri(ctx: vscode.ExtensionContext): Promise<{ id: string; dir: string } | undefined> {
  if (!ctx.storageUri) {
    log('[storageUri] not available');
    return undefined;
  }

  const storagePath = ctx.storageUri.fsPath;
  log('[storageUri] path=', storagePath);



  const workspaceIdDir = path.dirname(storagePath);
  const workspaceId = path.basename(workspaceIdDir);

  log('[storageUri] extracted id=', workspaceId);


  const workspaceJson = path.join(workspaceIdDir, 'workspace.json');
  if (!(await exists(workspaceJson))) {
    warn('[storageUri] workspace.json not found at', workspaceJson);
    return undefined;
  }

  log('[storageUri] ✓ found workspace id=', workspaceId);
  return { id: workspaceId, dir: workspaceIdDir };
}

async function openStateDb(SQL: SqlJsStatic, idDir: string): Promise<import('sql.js').Database | undefined> {
  const primary = path.join(idDir, 'state.vscdb');
  const backup = path.join(idDir, 'state.vscdb.backup');
  const dbfile = (await exists(primary)) ? primary : (await exists(backup)) ? backup : '';
  if (!dbfile) { warn('[open] no db in', idDir); return undefined; }

  const bytes = new Uint8Array(await fs.readFile(dbfile));
  log('[open] db=', dbfile, 'size=', bytes.byteLength);
  try { return new SQL.Database(bytes); }
  catch (e) { warn('[open] failed to open db', e); return undefined; }
}

function decodeBlob(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    if (value instanceof Uint8Array) return new TextDecoder('utf-8').decode(value);
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (typeof value === 'object' && Array.isArray(value.data)) return Buffer.from(value.data).toString('utf8');
  } catch { }
  return undefined;
}

type Notepad = ManagedNote;

function generateNoteId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

const MAX_SUMMARY_LENGTH = 60;
const SUMMARY_TRUNCATE_LENGTH = 57;
const NOTEPADS_FILENAME = 'notepads.json';


async function getNotepadsJsonPath(ctx: vscode.ExtensionContext): Promise<string | undefined> {
  if (!ctx.storageUri) {
    warn('[getNotepadsJsonPath] storageUri not available');
    return undefined;
  }

  const storagePath = ctx.storageUri.fsPath;
  const workspaceIdDir = path.dirname(storagePath);

  // {workspaceStorage}/{workspace-id}/notepads.json
  return path.join(workspaceIdDir, NOTEPADS_FILENAME);
}

async function readNotepadsFromJson(ctx: vscode.ExtensionContext): Promise<Notepad[]> {
  const jsonPath = await getNotepadsJsonPath(ctx);
  if (!jsonPath) return [];

  if (!(await exists(jsonPath))) {
    return [];
  }

  try {
    const content = await fs.readFile(jsonPath, 'utf-8');
    const data = JSON.parse(content);

    // Support both old object format and new array format
    let notes: Notepad[] = [];

    if (Array.isArray(data)) {
      let needsIdMigration = false;
      notes = data.map(n => {
        if (typeof n.id === 'string') {
          return {
            id: n.id,
            name: typeof n.name === 'string' ? n.name : '(untitled)',
            text: typeof n.text === 'string' ? n.text : ''
          };
        }
        needsIdMigration = true;
        return {
          id: generateNoteId(),
          name: typeof n.name === 'string' ? n.name : '(untitled)',
          text: typeof n.text === 'string' ? n.text : ''
        };
      });
      if (needsIdMigration) {
        await writeNotepadsToJson(ctx, notes);
        log('[readNotepadsFromJson] assigned missing ids and persisted');
      }
    } else if (data.notepads && typeof data.notepads === 'object') {
      // Old object format - migrate to array
      for (const key of Object.keys(data.notepads)) {
        const n = data.notepads[key];
        if (!n) continue;
        notes.push({
          id: typeof n.id === 'string' ? n.id : key,
          name: typeof n.name === 'string' ? n.name : '(untitled)',
          text: typeof n.text === 'string' ? n.text : ''
        });
      }
      // Auto-save in new format
      if (notes.length > 0) {
        await writeNotepadsToJson(ctx, notes);
        log('[readNotepadsFromJson] migrated old object format to new array format');
      }
    }

    return notes;
  } catch (e) {
    warn('[readNotepadsFromJson] failed', e);
    return [];
  }
}

async function writeNotepadsToJson(ctx: vscode.ExtensionContext, notes: Notepad[]): Promise<boolean> {
  const jsonPath = await getNotepadsJsonPath(ctx);
  if (!jsonPath) {
    warn('[writeNotepadsToJson] no storage path available');
    return false;
  }

  try {
    // Ensure directory exists
    const dirPath = path.dirname(jsonPath);
    await fs.mkdir(dirPath, { recursive: true });

    // Save as array format (simpler structure)
    const tmpPath = jsonPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(notes, null, 2), 'utf-8');
    await fs.rename(tmpPath, jsonPath);
    log('[writeNotepadsToJson] saved', notes.length, 'notes to', jsonPath);
    return true;
  } catch (e) {
    warn('[writeNotepadsToJson] failed', e);
    return false;
  }
}

function extractNotepadsFromJson(jsonText: string): Notepad[] {
  try {
    const obj = JSON.parse(jsonText);
    const store = obj?.notepads;
    if (!store || typeof store !== 'object') return [];
    const out: Notepad[] = [];
    for (const key of Object.keys(store)) {
      const n = store[key];
      if (!n) continue;
      const id = typeof n.id === 'string' ? n.id : key;
      const name = typeof n.name === 'string' ? n.name : '(untitled)';
      const text = typeof n.text === 'string' ? n.text : '';
      out.push({ id, name, text });
    }
    return out;
  } catch { return []; }
}

function querySingleTextByKey(db: import('sql.js').Database, key: string): string | undefined {
  const tables = new Set<string>();
  try {
    const t = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    if (t && t[0]) {
      for (const r of t[0].values as any[][]) {
        tables.add(String(r[0]));
      }
    }
  } catch { }

  const candidateTables = ['ItemTable', 'cursorDiskKV'].filter(t => tables.has(t));
  if (candidateTables.length === 0) return undefined;

  for (const table of candidateTables) {
    try {
      const res = db.exec(`SELECT value FROM ${table} WHERE key = $key LIMIT 1`, { $key: key });
      if (res && res[0] && res[0].values && res[0].values.length) {
        const raw = res[0].values[0]?.[0];
        const s = decodeBlob(raw);
        if (s != null) return s;
      }
    } catch (e) { log('[query]', table, 'failed', e); }
  }
  return undefined;
}



async function updateOpenNoteTabLabel(files: NoteFileSystem, noteId: string, label: string): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputText && files.noteIdForUri(input.uri) === noteId) {
        await vscode.commands.executeCommand('vscode.open', input.uri, {
          preview: false,
          preserveFocus: true,
          viewColumn: group.viewColumn,
        }, label);
      }
    }
  }
}

function summarizeText(text: string): string {
  const firstLine = (text || '').split(/\r?\n/)[0] ?? '';
  const trimmed = firstLine.trim();
  return trimmed.length <= MAX_SUMMARY_LENGTH ? trimmed : trimmed.slice(0, SUMMARY_TRUNCATE_LENGTH) + '...';
}

class NotepadItem extends vscode.TreeItem {
  constructor(public readonly note: Notepad) {
    super(note.name, vscode.TreeItemCollapsibleState.None);
    this.description = summarizeText(note.text);
    this.tooltip = `${note.name}\n\n${note.text}`;
    this.contextValue = 'notepadItem';
    this.iconPath = new vscode.ThemeIcon('note');
    this.command = {
      command: 'cnp.openNote',
      title: 'Open Notepad',
      arguments: [note]
    };
  }
}

class NotepadTreeProvider implements vscode.TreeDataProvider<NotepadItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private items: NotepadItem[] = [];
  private notepads: Notepad[] = [];
  private mutations: Promise<void> = Promise.resolve();
  constructor(private readonly ctx: vscode.ExtensionContext) { }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation);
    this.mutations = result.then(() => {}, () => {});
    return result;
  }

  // Drag and drop support
  dragMimeTypes = ['application/vnd.code.tree.cnp-notepad'];
  dropMimeTypes = ['application/vnd.code.tree.cnp-notepad'];

  async handleDrag(source: readonly NotepadItem[], dataTransfer: vscode.DataTransfer): Promise<void> {
    dataTransfer.set('application/vnd.code.tree.cnp-notepad', new vscode.DataTransferItem(source));
  }

  async handleDrop(target: NotepadItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    return this.mutate(async () => {
      const transferItem = dataTransfer.get('application/vnd.code.tree.cnp-notepad');
      if (!transferItem) return;

      const source = transferItem.value as NotepadItem[];
      if (!source || source.length === 0) return;

      const sourceIndex = this.notepads.findIndex(n => n.id === source[0].note.id);
      if (sourceIndex === -1) return;
      const sourceNote = this.notepads[sourceIndex];

      if (target && target.note.id === sourceNote.id) {
        return;
      }

      // Remove from original position
      this.notepads.splice(sourceIndex, 1);

      if (target) {
        const targetIndex = this.notepads.findIndex(n => n.id === target.note.id);
        if (targetIndex === -1) {
          this.notepads.push(sourceNote);
        } else {
          this.notepads.splice(targetIndex, 0, sourceNote);
        }
      } else {
        // Drop at end
        this.notepads.push(sourceNote);
      }

      await writeNotepadsToJson(this.ctx, this.notepads);
      await this.scanAndNotify();
    });
  }

  async init(): Promise<void> { await this.rescan(); }
  rescan(): Promise<void> {
    return this.mutate(() => this.scanAndNotify());
  }

  private async scanAndNotify(): Promise<void> {
    try { await this.scanCurrentWorkspace(); }
    finally { this._onDidChangeTreeData.fire(); }
  }

  getTreeItem(element: NotepadItem): vscode.TreeItem { return element; }
  getChildren(): vscode.ProviderResult<NotepadItem[]> { return this.items; }

  getNoteById(id: string): Notepad | undefined {
    return this.notepads.find(n => n.id === id);
  }

  async addNote(name: string, text: string): Promise<boolean> {
    return this.mutate(async () => {
      const newNote: Notepad = {
        id: generateNoteId(),
        name,
        text
      };
      this.notepads.push(newNote);
      const success = await writeNotepadsToJson(this.ctx, this.notepads);
      if (success) {
        await this.scanAndNotify();
      }
      return success;
    });
  }

  async updateNote(id: string, name: string, text: string): Promise<boolean> {
    return this.mutate(async () => {
      const note = this.notepads.find(n => n.id === id);
      if (!note) return false;

      note.name = name;
      note.text = text;
      const success = await writeNotepadsToJson(this.ctx, this.notepads);
      if (success) {
        await this.scanAndNotify();
      }
      return success;
    });
  }

  async deleteNote(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const index = this.notepads.findIndex(n => n.id === id);
      if (index === -1) return false;

      this.notepads.splice(index, 1);
      const success = await writeNotepadsToJson(this.ctx, this.notepads);
      if (success) {
        await this.scanAndNotify();
      }
      return success;
    });
  }

  async updateNoteText(id: string, text: string): Promise<boolean> {
    return this.mutate(async () => {
      const note = this.notepads.find(candidate => candidate.id === id);
      if (!note) return false;
      note.text = text;
      const success = await writeNotepadsToJson(this.ctx, this.notepads);
      if (success) await this.scanAndNotify();
      return success;
    });
  }

  async updateNoteName(id: string, name: string): Promise<boolean> {
    return this.mutate(async () => {
      const note = this.notepads.find(candidate => candidate.id === id);
      if (!note) return false;
      note.name = name;
      const success = await writeNotepadsToJson(this.ctx, this.notepads);
      if (success) await this.scanAndNotify();
      return success;
    });
  }

  getNoteByLegacyDirectory(directory: string): Notepad | undefined {
    return this.notepads.find(note => (note.id.replace(/[\\\/:\*\?"<>\|]/g, '_').slice(0, 80) || 'note') === directory);
  }

  private async scanCurrentWorkspace(): Promise<void> {
    VERBOSE = !!vscode.workspace.getConfiguration('cursorNotepads').get('verbose', false);

    const jsonPath = await getNotepadsJsonPath(this.ctx);

    if (jsonPath && await exists(jsonPath)) {
      log('[scan] notepads.json exists - reading from JSON file');
      this.notepads = await readNotepadsFromJson(this.ctx);
      log('[scan] loaded', this.notepads.length, 'notes from JSON');
      this.items = this.notepads.map(n => new NotepadItem(n));
      return;
    }

    log('[scan] notepads.json not found - migrating from DB');

    const mapping = await findWorkspaceMappingIdFromStorageUri(this.ctx);
    if (!mapping) {
      log('[scan] no workspace mapping found');
      this.notepads = [];
      this.items = [];
      return;
    }

    const SQL = await initSqlJs({
      locateFile: (f: string) =>
        vscode.Uri.joinPath(this.ctx.extensionUri, 'out', 'sql-wasm.wasm').fsPath
    });

    const db = await openStateDb(SQL as SqlJsStatic, mapping.dir);
    if (!db) {
      this.notepads = [];
      this.items = [];
      return;
    }

    try {
      const npJson = querySingleTextByKey(db, 'notepadData');
      if (!npJson) {
        log('[scan] no notepadData in DB');
        this.notepads = [];
        this.items = [];
        return;
      }

      const notes = extractNotepadsFromJson(npJson);
      log('[scan] found', notes.length, 'notes in DB - migrating to JSON');

      if (jsonPath && notes.length > 0) {
        const migrated = await writeNotepadsToJson(this.ctx, notes);
        if (migrated) {
          log('[scan] migration successful -', notes.length, 'notes saved to', jsonPath);
          vscode.window.showInformationMessage(
            `Notepads: Successfully migrated ${notes.length} note(s) to notepads.json`
          );
        }
      }

      this.notepads = notes;
      this.items = notes.map(n => new NotepadItem(n));
    } finally {
      try { db.close(); } catch { }
    }
  }
}

export async function activate(ctx: vscode.ExtensionContext) {

  outputChannel = vscode.window.createOutputChannel('Notepads');
  ctx.subscriptions.push(outputChannel);

  VERBOSE = !!vscode.workspace.getConfiguration('cursorNotepads').get('verbose', false);


  if (vscode.env.remoteName) {
    log('[remote] detected remote environment:', vscode.env.remoteName);
    log('[remote] extension should run on UI (host) side - check extensionKind setting');
  } else {
    log('[local] running on local/UI environment');
  }


  const provider = new NotepadTreeProvider(ctx);
  const view = vscode.window.createTreeView('cnp.view', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    canSelectMany: false
  });
  ctx.subscriptions.push(view);

  await provider.init();

  const workspaceId = ctx.storageUri ? path.basename(path.dirname(ctx.storageUri.fsPath)) : 'no-workspace';
  const files = new NoteFileSystem(workspaceId, id => provider.getNoteById(id), (id, text) => provider.updateNoteText(id, text));
  const icons = new NoteIconThemeController(ctx, message => warn('[icons]', message));
  ctx.subscriptions.push(files, icons, vscode.workspace.registerFileSystemProvider(NOTE_SCHEME, files, {
    isCaseSensitive: true,
    isReadonly: false,
  }));

  const setNoteLanguage = async (doc: vscode.TextDocument) => {
    if (files.noteIdForUri(doc.uri) && doc.languageId !== 'markdown') {
      await vscode.languages.setTextDocumentLanguage(doc, 'markdown');
    }
  };
  ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => {
    void setNoteLanguage(doc).catch(error => warn('Failed to restore note language', String(error)));
  }));
  for (const doc of vscode.workspace.textDocuments) {
    await setNoteLanguage(doc);
  }
  await icons.start();

  const legacyNoteId = (uri: vscode.Uri): string | undefined => {
    if (uri.scheme !== 'file') return undefined;
    const relative = path.relative(ctx.globalStorageUri.fsPath, uri.fsPath);
    const segments = relative.split(path.sep);
    if (path.isAbsolute(relative) || segments.length !== 2 || segments[0] === '..') return undefined;
    return provider.getNoteByLegacyDirectory(segments[0])?.id;
  };

  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async savedDoc => {
      const legacyId = legacyNoteId(savedDoc.uri);
      const noteId = files.noteIdForUri(savedDoc.uri) ?? legacyId;
      if (!noteId) {
        return;
      }
      const current = provider.getNoteById(noteId);
      if (!current) {
        return;
      }
      if (legacyId) {
        if (!await provider.updateNoteText(noteId, savedDoc.getText())) {
          vscode.window.showErrorMessage('Failed to save note to notepads.json');
          return;
        }
        files.notifyChanged(noteId);
      }
      if (VERBOSE) {
        vscode.window.showInformationMessage(`Note "${current.name}" saved`);
      }
    })
  );

  ctx.subscriptions.push(vscode.commands.registerCommand('cnp.openNote', async (note: Notepad) => {
    try {
      const current = provider.getNoteById(note.id);
      if (!current) {
        throw vscode.FileSystemError.FileNotFound();
      }
      const legacyDirty = vscode.workspace.textDocuments.find(document => document.isDirty && legacyNoteId(document.uri) === current.id);
      if (legacyDirty) {
        await vscode.window.showTextDocument(legacyDirty, { preview: false });
        return;
      }
      await icons.ensureEnabled();
      const uri = files.uriForNote(current.id);
      const openedDoc = await vscode.workspace.openTextDocument(uri);
      await setNoteLanguage(openedDoc);
      await vscode.commands.executeCommand('vscode.open', uri, { preview: false }, current.name);
    } catch (e) {
      warn('openNote failed', e);
      vscode.window.showErrorMessage('Failed to open note');
    }
  }));

  ctx.subscriptions.push(vscode.commands.registerCommand('cnp.newNote', async () => {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter note name',
      placeHolder: 'e.g. Meeting Notes',
      value: 'New Notepad'
    });

    if (!name) return;

    const success = await provider.addNote(name, '');
    if (success) {
      if (VERBOSE) {
        vscode.window.showInformationMessage(`Note "${name}" created`);
      }
    } else {
      vscode.window.showErrorMessage('Failed to create note - Make sure a workspace folder is open');
    }
  }));


  ctx.subscriptions.push(vscode.commands.registerCommand('cnp.deleteNote', async (item: NotepadItem) => {
    if (!item) {
      vscode.window.showWarningMessage('Please right-click on a notepad item to delete it');
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete note "${item.note.name}"?`,
      { modal: true },
      'Delete'
    );

    if (confirm === 'Delete') {
      const success = await provider.deleteNote(item.note.id);
      if (success) {
        files.notifyChanged(item.note.id);
        if (VERBOSE) {
          vscode.window.showInformationMessage(`Note "${item.note.name}" deleted`);
        }
      } else {
        vscode.window.showErrorMessage('Failed to delete note');
      }
    }
  }));


  ctx.subscriptions.push(vscode.commands.registerCommand('cnp.renameNote', async (item: NotepadItem) => {
    if (!item) {
      vscode.window.showWarningMessage('Please right-click on a notepad item to rename it');
      return;
    }

    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new name',
      value: item.note.name
    });

    if (!newName || newName === item.note.name) return;

    const current = provider.getNoteById(item.note.id);
    if (!current) return;
    const success = await provider.updateNoteName(current.id, newName);
    if (success) {
      await updateOpenNoteTabLabel(files, item.note.id, newName);
      if (VERBOSE) {
        vscode.window.showInformationMessage(`Note renamed to "${newName}"`);
      }
    } else {
      vscode.window.showErrorMessage('Failed to rename note');
    }
  }));

  // Refresh
  ctx.subscriptions.push(vscode.commands.registerCommand('cnp.refresh', () => provider.rescan()));
  ctx.subscriptions.push(vscode.commands.registerCommand('cnp.restoreOriginalIconTheme', async () => {
    const configuration = vscode.workspace.getConfiguration('cursorNotepads');
    const target = configuration.inspect<boolean>('noteTabIcon')?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await configuration.update('noteTabIcon', false, target);
    await icons.ensureEnabled();
  }));

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.rescan()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cursorNotepads.verbose')) {
        VERBOSE = !!vscode.workspace.getConfiguration('cursorNotepads').get('verbose', false);
        log('verbose changed ->', VERBOSE);
      }
    })
  );
  return { notes: provider, files, icons };
}

export function deactivate() { }
