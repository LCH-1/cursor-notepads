import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import initSqlJs, { SqlJsStatic } from 'sql.js';

let DEBUG = false;
let outputChannel: vscode.OutputChannel;

function log(...args: any[]) {
  if (DEBUG && outputChannel) {
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

  // storageUri 경로는 {workspaceStorage}/{workspace-id}/{extension-id}/ 형태
  // workspace-id를 추출하기 위해 상위 디렉토리로 이동
  const workspaceIdDir = path.dirname(storagePath);
  const workspaceId = path.basename(workspaceIdDir);

  log('[storageUri] extracted id=', workspaceId);

  // workspace.json이 있는지 확인하여 유효성 검증
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

type Notepad = { id: string; name: string; text: string };

// ---------- Constants ----------
const MAX_FILENAME_LENGTH = 80;
const MAX_SUMMARY_LENGTH = 60;
const SUMMARY_TRUNCATE_LENGTH = 57;

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

// ---------- Readonly virtual doc provider ----------
class NotepadDocProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'cnp-notepad';
  private notes = new Map<string, Notepad>();

  set(note: Notepad) { this.notes.set(note.id, note); }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const id = uri.query.replace(/^id=/, '');
    const note = this.notes.get(id);
    return note ? note.text : '';
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\\/:\*\?"<>\|]/g, '_').slice(0, MAX_FILENAME_LENGTH) || 'note';
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
  constructor(private readonly ctx: vscode.ExtensionContext) { }

  async init(): Promise<void> { await this.rescan(); }
  async rescan(): Promise<void> {
    try { await this.scanCurrentWorkspace(); }
    finally { this._onDidChangeTreeData.fire(); }
  }

  getTreeItem(element: NotepadItem): vscode.TreeItem { return element; }
  getChildren(): vscode.ProviderResult<NotepadItem[]> { return this.items; }

  private async scanCurrentWorkspace(): Promise<void> {
    DEBUG = !!vscode.workspace.getConfiguration('cursorNotepads').get('debugLogs', false);

    // ExtensionContext.storageUri를 통해 workspace ID 추출
    const mapping = await findWorkspaceMappingIdFromStorageUri(this.ctx);

    if (!mapping) {
      log('[result] workspace id not found via storageUri - no notepads to display');
      this.items = [];
      return;
    }

    const SQL = await initSqlJs({
      locateFile: (f: string) =>
        vscode.Uri.joinPath(this.ctx.extensionUri, 'out', 'sql-wasm.wasm').fsPath
    });

    const db = await openStateDb(SQL as SqlJsStatic, mapping.dir);
    if (!db) { this.items = []; return; }

    try {
      const npJson = querySingleTextByKey(db, 'notepadData');
      if (!npJson) { log('[hit] mappingId=', mapping.id, 'but no notepadData key'); this.items = []; return; }
      const notes = extractNotepadsFromJson(npJson);
      log('[hit] notepads=', notes.length);
      this.items = notes.map(n => new NotepadItem(n));
    } finally { try { db.close(); } catch { } }
  }
}

export async function activate(ctx: vscode.ExtensionContext) {
  // Output 채널 생성
  outputChannel = vscode.window.createOutputChannel('Cursor Notepads');
  ctx.subscriptions.push(outputChannel);

  DEBUG = !!vscode.workspace.getConfiguration('cursorNotepads').get('debugLogs', false);

  // Remote 환경 감지 및 로깅
  if (vscode.env.remoteName) {
    log('[remote] detected remote environment:', vscode.env.remoteName);
    log('[remote] extension should run on UI (host) side - check extensionKind setting');
  } else {
    log('[local] running on local/UI environment');
  }

  // register readonly provider
  const docProvider = new NotepadDocProvider();
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(NotepadDocProvider.scheme, docProvider));

  // command to open note
  ctx.subscriptions.push(vscode.commands.registerCommand('cnp.openNote', async (note: Notepad) => {
    try {
      docProvider.set(note);
      const file = sanitizeFileName(note.name || note.id) + '.md';
      const uri = vscode.Uri.parse(`${NotepadDocProvider.scheme}:/${file}?id=${encodeURIComponent(note.id)}`);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      // 언어 모드 마크다운으로
      try { await vscode.languages.setTextDocumentLanguage(doc, 'markdown'); } catch { }
    } catch (e) {
      warn('openNote failed', e);
      vscode.window.showErrorMessage('Failed to open note');
    }
  }));

  // tree view
  const provider = new NotepadTreeProvider(ctx);
  const view = vscode.window.createTreeView('cnp.view', { treeDataProvider: provider });
  ctx.subscriptions.push(view);

  await provider.init();

  // re-scan triggers
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.rescan()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cursorNotepads.debugLogs')) {
        DEBUG = !!vscode.workspace.getConfiguration('cursorNotepads').get('debugLogs', false);
        log('debugLogs changed ->', DEBUG);
        provider.rescan();
      }
    })
  );
}

export function deactivate() { }
