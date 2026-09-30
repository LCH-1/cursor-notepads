import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse, ParseError } from 'jsonc-parser';
import { NOTE_ICON_PARENT } from './noteFileSystem';

export const NOTE_THEME_SLOT_COUNT = 16;

export function themeId(slot: number): string {
  return `cnp-notepad-icons-${slot}`;
}

type ThemeSetting = string | null;
type SettingsTarget = 'global' | 'workspace';
type OriginalValue = { defined: boolean; value?: ThemeSetting };
type ThemeSelection = { slot: number; original: OriginalValue };
type SlotState = {
  version: 1;
  slots: Record<string, number>;
};
type ThemeDefinition = Record<string, any>;
type ThemeContribution = { id: string; path: string };
type CachedTheme = { source: ThemeSetting; fingerprint: string; definition: ThemeDefinition };

const WORKSPACE_SELECTION_KEY = 'noteIconTheme.selection';
const GLOBAL_SELECTION_KEY = 'noteIconTheme.globalSelection';
const OWN_ICON_ID = '_cnp_notepad';
const THEME_SETTING = 'workbench.iconTheme';
const NOTE_ICON_SETTING = 'cursorNotepads.noteTabIcon';

function ownSlot(value: ThemeSetting): number | undefined {
  if (typeof value !== 'string') { return undefined; }
  const match = /^cnp-notepad-icons-(\d+)$/.exec(value);
  if (!match) { return undefined; }
  const slot = Number(match[1]);
  return slot >= 0 && slot < NOTE_THEME_SLOT_COUNT ? slot : undefined;
}

function isFileError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function captureValue(value: ThemeSetting | undefined): OriginalValue {
  return value === undefined ? { defined: false } : { defined: true, value };
}

function restoredValue(original: OriginalValue): ThemeSetting | undefined {
  return original.defined ? original.value : undefined;
}

export class NoteIconThemeController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private active = false;
  private disposed = false;
  private cachedTheme: CachedTheme | undefined;
  private readonly writtenThemes = new Map<number, ThemeDefinition>();
  private sourceUri: string | undefined;
  private sourceWatchers: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly report: (message: string) => void,
  ) { }

  public async start(): Promise<void> {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(NOTE_ICON_SETTING) || event.affectsConfiguration(THEME_SETTING)) {
        void this.enqueue(async () => {
          if (!this.enabled()) {
            await this.restoreTheme();
          } else if (event.affectsConfiguration(NOTE_ICON_SETTING) || this.active) {
            await this.activateTheme();
          }
        }).catch(error => this.reportError(error));
      }
    }));
    this.disposables.push(vscode.extensions.onDidChange(() => this.scheduleRefresh()));

    await this.enqueue(async () => {
      if (ownSlot(this.currentTheme()) === undefined) { return; }
      if (!this.enabled()) {
        await this.restoreTheme();
        return;
      }
      await this.activateTheme();
    }).catch(error => this.reportError(error));
  }

  public async ensureEnabled(): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.enabled()) {
        await this.restoreTheme();
        return false;
      }
      return this.activateTheme();
    }).catch(error => {
      this.reportError(error);
      return false;
    });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    for (const watcher of this.sourceWatchers) { watcher.dispose(); }
    for (const disposable of this.disposables) { disposable.dispose(); }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(operation, operation);
    this.pending = next.catch(() => undefined);
    return next;
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('cursorNotepads').get<boolean>('noteTabIcon', true);
  }

  private currentTheme(): ThemeSetting {
    return vscode.workspace.getConfiguration('workbench').get<ThemeSetting>('iconTheme') ?? null;
  }

  private settingsTarget(): { target: SettingsTarget; original: OriginalValue } {
    const setting = vscode.workspace.getConfiguration('workbench').inspect<ThemeSetting>('iconTheme');
    if (setting?.workspaceValue !== undefined) {
      return { target: 'workspace', original: captureValue(setting.workspaceValue) };
    }
    return { target: 'global', original: captureValue(setting?.globalValue) };
  }

  private async activateTheme(attempt = 0): Promise<boolean> {
    if (this.disposed || !this.enabled()) { return false; }
    const selected = this.currentTheme();
    const selectedSlot = ownSlot(selected);
    if (selectedSlot !== undefined) {
      const source = await this.withLock(async state => this.sourceForSlot(state, selectedSlot));
      const definition = await this.buildTheme(source);
      if (this.writtenThemes.get(selectedSlot) !== definition) {
        await this.withLock(async () => this.writeTheme(selectedSlot, definition));
      }
      this.active = true;
      return true;
    }

    const selection = this.settingsTarget();
    const definition = await this.buildTheme(selected);
    if (this.currentTheme() !== selected) {
      if (attempt >= 2) { throw new Error('아이콘 테마가 계속 변경되어 노트 아이콘 적용을 건너뛰었습니다.'); }
      return this.activateTheme(attempt + 1);
    }

    const slot = await this.withLock(async state => {
      const key = JSON.stringify(selected);
      let allocated = state.slots[key];
      if (allocated === undefined) {
        const occupied = new Set(Object.values(state.slots));
        for (let candidate = 0; candidate < NOTE_THEME_SLOT_COUNT; candidate++) {
          if (!occupied.has(candidate)) { allocated = candidate; break; }
        }
        if (allocated === undefined) {
          throw new Error('노트 아이콘용 테마 슬롯이 모두 사용 중이므로 원본 테마를 유지합니다.');
        }
        state.slots[key] = allocated;
      }
      await this.writeTheme(allocated, definition);
      await this.writeState(state);
      return allocated;
    });

    if (selection.target === 'workspace') {
      await this.context.workspaceState.update(WORKSPACE_SELECTION_KEY, {
        slot,
        original: selection.original,
      } satisfies ThemeSelection);
    } else {
      await this.context.globalState.update(GLOBAL_SELECTION_KEY, {
        slot,
        original: selection.original,
      } satisfies ThemeSelection);
    }
    if (this.disposed || !this.enabled() || this.currentTheme() !== selected) { return false; }

    await vscode.workspace.getConfiguration('workbench').update(
      'iconTheme',
      themeId(slot),
      selection.target === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
    );
    this.active = true;
    // The workbench installs its theme watcher only after selecting the contributed theme.
    await this.withLock(async () => this.writeTheme(slot, definition));
    return true;
  }

  private async restoreTheme(): Promise<void> {
    this.active = false;
    const configuration = vscode.workspace.getConfiguration('workbench');
    const setting = configuration.inspect<ThemeSetting>('iconTheme');
    const workspaceSelection = this.context.workspaceState.get<ThemeSelection>(WORKSPACE_SELECTION_KEY);
    if (workspaceSelection) {
      if (setting?.workspaceValue === themeId(workspaceSelection.slot)) {
        await configuration.update('iconTheme', restoredValue(workspaceSelection.original), vscode.ConfigurationTarget.Workspace);
      }
      await this.context.workspaceState.update(WORKSPACE_SELECTION_KEY, undefined);
    }

    const globalSelection = this.context.globalState.get<ThemeSelection>(GLOBAL_SELECTION_KEY);
    if (globalSelection) {
      const current = vscode.workspace.getConfiguration('workbench').inspect<ThemeSetting>('iconTheme');
      if (current?.globalValue === themeId(globalSelection.slot)) {
        await configuration.update('iconTheme', restoredValue(globalSelection.original), vscode.ConfigurationTarget.Global);
      }
      await this.context.globalState.update(GLOBAL_SELECTION_KEY, undefined);
    }
  }

  private sourceForSlot(state: SlotState, slot: number): ThemeSetting {
    for (const [source, allocated] of Object.entries(state.slots)) {
      if (allocated === slot) {
        const value: unknown = JSON.parse(source);
        if (typeof value === 'string' || value === null) { return value; }
      }
    }
    throw new Error('노트 아이콘 테마의 원본 정보를 찾지 못했습니다. 원본 아이콘 테마를 다시 선택해 주세요.');
  }

  private themeDirectory(): string {
    if (this.context.extensionUri.scheme !== 'file') {
      throw new Error('이 설치 위치에서는 노트 아이콘 테마를 생성할 수 없습니다.');
    }
    return path.join(this.context.extensionUri.fsPath, 'themes');
  }

  private async buildTheme(source: ThemeSetting): Promise<ThemeDefinition> {
    let definition: ThemeDefinition;
    let fingerprint: string;
    let sourceUri: vscode.Uri | undefined;
    if (source === null) {
      fingerprint = 'null';
      if (this.cachedTheme?.source === null && this.cachedTheme.fingerprint === fingerprint) {
        return this.cachedTheme.definition;
      }
      definition = { showLanguageModeIcons: false };
    } else {
      const contribution = this.findTheme(source);
      if (!contribution) { throw new Error('원본 아이콘 테마 확장을 찾지 못해 기존 테마를 유지합니다.'); }
      const uri = vscode.Uri.joinPath(contribution.extension.extensionUri, contribution.theme.path);
      if (uri.scheme !== 'file') { throw new Error('이 원본 아이콘 테마의 파일 위치는 지원하지 않습니다.'); }
      sourceUri = uri;
      const stat = await fs.stat(uri.fsPath);
      fingerprint = `${uri.toString()}:${contribution.extension.packageJSON.version}:${stat.mtimeMs}:${stat.size}`;
      if (this.cachedTheme?.source === source && this.cachedTheme.fingerprint === fingerprint) {
        return this.cachedTheme.definition;
      }
      const errors: ParseError[] = [];
      const parsed: unknown = parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), errors, {
        allowTrailingComma: true,
      });
      if (errors.length || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('원본 아이콘 테마를 읽지 못해 기존 테마를 유지합니다.');
      }
      definition = parsed as ThemeDefinition;
      await this.rewriteAssets(definition, path.dirname(uri.fsPath));
    }

    if (definition.showLanguageModeIcons === undefined) {
      definition.showLanguageModeIcons = [definition, definition.light, definition.highContrast, definition.highContrastLight]
        .filter(Boolean)
        .some(variant => ['fileNames', 'fileExtensions', 'languageIds'].some(key => Object.keys(variant[key] ?? {}).length > 0));
    }
    definition.iconDefinitions = { ...definition.iconDefinitions, [OWN_ICON_ID]: { iconPath: '../notepad.png' } };
    const association = `${NOTE_ICON_PARENT}/note`;
    definition.fileNames = { ...definition.fileNames, [association]: OWN_ICON_ID };
    for (const variant of ['light', 'highContrast', 'highContrastLight']) {
      if (variant === 'highContrastLight' && !definition[variant]) { continue; }
      definition[variant] = { ...definition[variant], fileNames: { ...definition[variant]?.fileNames, [association]: OWN_ICON_ID } };
    }
    this.cachedTheme = { source, fingerprint, definition };
    this.watchSource(sourceUri);
    return definition;
  }

  private watchSource(uri: vscode.Uri | undefined): void {
    if (uri?.toString() === this.sourceUri) { return; }
    for (const watcher of this.sourceWatchers) { watcher.dispose(); }
    this.sourceWatchers = [];
    this.sourceUri = uri?.toString();
    if (!uri) { return; }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)),
    );
    this.sourceWatchers.push(
      watcher,
      watcher.onDidChange(() => this.scheduleRefresh()),
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh()),
    );
  }

  private scheduleRefresh(): void {
    this.cachedTheme = undefined;
    if (this.disposed || !this.active || !this.enabled()) { return; }
    if (this.refreshTimer) { clearTimeout(this.refreshTimer); }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.enqueue(() => this.activateTheme()).catch(error => this.reportError(error));
    }, 100);
  }

  private findTheme(source: string): { extension: vscode.Extension<unknown>; theme: ThemeContribution } | undefined {
    for (const extension of vscode.extensions.all) {
      const themes = extension.packageJSON?.contributes?.iconThemes;
      if (!Array.isArray(themes)) { continue; }
      const theme = themes.find((candidate: ThemeContribution) => candidate.id === source);
      if (theme && typeof theme.path === 'string') { return { extension, theme }; }
    }
    return undefined;
  }

  private async rewriteAssets(definition: ThemeDefinition, sourceDirectory: string): Promise<void> {
    const destination = this.themeDirectory();
    const assets = new Set<string>();
    const rewrite = (original: string): string => {
      if (/^[a-z][a-z\d+.-]*:/i.test(original) && !path.isAbsolute(original)) {
        throw new Error('원본 아이콘 테마에 지원하지 않는 외부 이미지 경로가 있습니다.');
      }
      const absolute = path.resolve(sourceDirectory, original);
      if (path.parse(absolute).root.toLowerCase() !== path.parse(destination).root.toLowerCase()) {
        throw new Error('원본 아이콘 테마와 노트 아이콘 테마는 같은 드라이브에 있어야 합니다.');
      }
      assets.add(absolute);
      return path.relative(destination, absolute).replace(/\\/g, '/');
    };

    for (const icon of Object.values(definition.iconDefinitions ?? {}) as Record<string, unknown>[]) {
      if (typeof icon.iconPath === 'string') { icon.iconPath = rewrite(icon.iconPath); }
    }
    for (const font of definition.fonts ?? []) {
      for (const entry of font.src ?? []) {
        if (typeof entry.path === 'string') { entry.path = rewrite(entry.path); }
      }
    }
    const pending = [...assets];
    await Promise.all(Array.from({ length: Math.min(16, pending.length) }, async () => {
      while (pending.length) {
        const asset = pending.pop()!;
        try {
          await fs.access(asset);
        } catch {
          throw new Error('원본 아이콘 테마의 이미지 파일이 없어 기존 테마를 유지합니다.');
        }
      }
    }));
  }

  private async writeTheme(slot: number, definition: ThemeDefinition): Promise<void> {
    const destination = path.join(this.themeDirectory(), `notepads-${slot}.json`);
    await this.writeAtomic(destination, JSON.stringify(definition));
    this.writtenThemes.set(slot, definition);
  }

  private storageDirectory(): string {
    const uri = this.context.globalStorageUri;
    const localUserData = uri.scheme === 'vscode-userdata' && !uri.authority && path.isAbsolute(uri.fsPath);
    if (uri.scheme !== 'file' && !localUserData) {
      throw new Error('이 저장 위치에서는 노트 아이콘 테마를 기록할 수 없습니다.');
    }
    return uri.fsPath;
  }

  private async readState(): Promise<SlotState> {
    const file = path.join(this.storageDirectory(), 'theme-slots.json');
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as SlotState;
      if (state.version !== 1 || typeof state.slots !== 'object' || state.slots === null || Array.isArray(state.slots)) {
        throw new Error('노트 아이콘 테마의 저장 정보가 올바르지 않습니다.');
      }
      const allocated = Object.values(state.slots);
      if (allocated.some(slot => !Number.isInteger(slot) || slot < 0 || slot >= NOTE_THEME_SLOT_COUNT)
        || new Set(allocated).size !== allocated.length) {
        throw new Error('노트 아이콘 테마 슬롯 정보가 올바르지 않습니다.');
      }
      return { version: 1, slots: state.slots };
    } catch (error) {
      if (isFileError(error, 'ENOENT')) { return { version: 1, slots: {} }; }
      throw error;
    }
  }

  private async writeState(state: SlotState): Promise<void> {
    await this.writeAtomic(path.join(this.storageDirectory(), 'theme-slots.json'), JSON.stringify({ version: 1, slots: state.slots }));
  }

  private async writeAtomic(destination: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, destination);
    } finally {
      try { await fs.unlink(temporary); } catch (error) {
        if (!isFileError(error, 'ENOENT')) { throw error; }
      }
    }
  }

  private async withLock<T>(operation: (state: SlotState) => Promise<T>): Promise<T> {
    const directory = this.storageDirectory();
    await fs.mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, 'theme-slots.lock');
    const started = Date.now();
    let lock: fs.FileHandle;
    for (;;) {
      try {
        lock = await fs.open(lockPath, 'wx');
        try {
          await lock.writeFile(String(process.pid), 'utf8');
        } catch (error) {
          await lock.close();
          await fs.unlink(lockPath);
          throw error;
        }
        break;
      } catch (error) {
        if (!isFileError(error, 'EEXIST')) { throw error; }
        await this.removeAbandonedLock(lockPath);
        if (Date.now() - started >= 5000) {
          throw new Error('다른 창에서 노트 아이콘 테마를 처리 중이므로 이번 적용을 건너뛰었습니다.');
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try {
      return await operation(await this.readState());
    } finally {
      try { await lock.close(); } finally { await fs.unlink(lockPath); }
    }
  }

  private async removeAbandonedLock(lockPath: string): Promise<void> {
    const recoveryPath = `${lockPath}.recovery`;
    let recovery: fs.FileHandle;
    try {
      recovery = await fs.open(recoveryPath, 'wx');
    } catch (error) {
      if (isFileError(error, 'EEXIST')) { return; }
      throw error;
    }
    try {
      let owner: number;
      try { owner = Number(await fs.readFile(lockPath, 'utf8')); } catch (error) {
        if (isFileError(error, 'ENOENT')) { return; }
        throw error;
      }
      if (!Number.isSafeInteger(owner) || owner <= 0) {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs >= 30000) { await fs.unlink(lockPath); }
        return;
      }
      try {
        process.kill(owner, 0);
      } catch (error) {
        if (isFileError(error, 'ESRCH')) { await fs.unlink(lockPath); }
      }
    } finally {
      try { await recovery.close(); } finally { await fs.unlink(recoveryPath); }
    }
  }

  private reportError(error: unknown): void {
    this.report(error instanceof Error ? error.message : '노트 아이콘 테마 적용에 실패했습니다.');
  }
}
