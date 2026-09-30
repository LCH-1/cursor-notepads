import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';
import * as vscode from 'vscode';

type ThemeSetting = string | null | undefined;
type Settings = Map<string, unknown>;
type Controller = vscode.Disposable & {
  start(): Promise<void>;
  ensureEnabled(): Promise<boolean>;
  shutdown(): Promise<void>;
};
type ControllerConstructor = new (context: vscode.ExtensionContext, report: (message: string) => void) => Controller;
type SettingWrite = { window: string; key: string; value: unknown; target: vscode.ConfigurationTarget };

const ORIGINAL_THEME = 'fixture-icons';
const ALTERNATE_THEME = 'fixture-alternate-icons';
const THEME_KEY = 'workbench.iconTheme';
const FEATURE_KEY = 'cursorNotepads.noteTabIcon';
const SOURCE_KEY = 'cursorNotepads.noteIconThemeSource';

function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

class MemoryMemento implements vscode.Memento {
  constructor(private readonly values = new Map<string, unknown>()) { }

  keys(): readonly string[] { return [...this.values.keys()]; }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? copy(this.values.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) { this.values.delete(key); } else { this.values.set(key, copy(value)); }
  }

  setKeysForSync(): void { }
}

class Profile {
  readonly global = new Map<string, unknown>([[THEME_KEY, ORIGINAL_THEME]]);
  readonly state = new MemoryMemento();
  readonly writes: SettingWrite[] = [];
  readonly windows: TestWindow[] = [];
  readonly defaults = new Map<string, unknown>([[THEME_KEY, ORIGINAL_THEME], [FEATURE_KEY, true]]);
  readonly extensions: { id: string; extensionUri: vscode.Uri; packageJSON: unknown }[] = [];

  constructor(readonly directory: string) { }

  setGlobal(key: string, value: unknown): void {
    this.set(this.global, key, value);
    this.windows.forEach(window => window.changed(key));
  }

  set(settings: Settings, key: string, value: unknown): void {
    if (value === undefined) { settings.delete(key); } else { settings.set(key, copy(value)); }
  }

  async addTheme(id: string, fileIcon: string): Promise<void> {
    const directory = path.join(this.directory, id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'file.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="none" stroke="blue" d="M2 2h12v12H2z"/></svg>');
    await fs.writeFile(path.join(directory, 'icons.json'), JSON.stringify({
      iconDefinitions: { [fileIcon]: { iconPath: './file.svg' } },
      file: fileIcon,
      folder: fileIcon,
      fileExtensions: { ts: fileIcon },
      languageIds: { markdown: fileIcon },
    }));
    this.extensions.push({
      id: `test.${id}`,
      extensionUri: vscode.Uri.file(directory),
      packageJSON: { version: '1.0.0', contributes: { iconThemes: [{ id, path: './icons.json' }] } },
    });
  }
}

class TestWindow {
  workspacePresent = true;
  readonly settings = new Map<string, unknown>();
  readonly state = new MemoryMemento();
  readonly reports: string[] = [];
  private readonly configurationChanges = new vscode.EventEmitter<vscode.ConfigurationChangeEvent>();
  private readonly extensionChanges = new vscode.EventEmitter<void>();
  private readonly watchers: { pattern: vscode.RelativePattern; changes: vscode.EventEmitter<vscode.Uri>; disposed: boolean }[] = [];
  readonly controllers: Controller[] = [];

  constructor(readonly profile: Profile, readonly id: string) {
    profile.windows.push(this);
  }

  changed(key: string): void {
    this.configurationChanges.fire({
      affectsConfiguration: section => section === key || key.startsWith(`${section}.`) || section.startsWith(`${key}.`),
    });
  }

  setWorkspace(key: string, value: unknown): void {
    this.profile.set(this.settings, key, value);
    this.changed(key);
  }

  effective<T>(key: string): T | undefined {
    for (const settings of [this.settings, this.profile.global, this.profile.defaults]) {
      if (settings.has(key)) { return copy(settings.get(key) as T); }
    }
    return undefined;
  }

  fileChanged(uri: vscode.Uri): void {
    for (const watcher of this.watchers) {
      if (!watcher.disposed && path.dirname(uri.fsPath) === watcher.pattern.base
        && (watcher.pattern.pattern === '*' || watcher.pattern.pattern === path.basename(uri.fsPath))) {
        watcher.changes.fire(uri);
      }
    }
  }

  async controller(): Promise<Controller> {
    const extensionDirectory = path.join(this.profile.directory, 'notepads-extension');
    await fs.mkdir(path.join(extensionDirectory, 'themes'), { recursive: true });
    const workspaceDirectory = path.join(this.profile.directory, this.id);
    const context = {
      extensionUri: vscode.Uri.file(extensionDirectory),
      extensionPath: extensionDirectory,
      globalStorageUri: vscode.Uri.file(path.join(this.profile.directory, 'global-storage')),
      storageUri: vscode.Uri.file(path.join(workspaceDirectory, 'storage')),
      globalState: this.profile.state,
      workspaceState: this.state,
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;
    const configuration = (section: string) => ({
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const value = this.effective<T>(`${section}.${key}`);
        return value === undefined ? defaultValue : value;
      },
      inspect: <T>(key: string) => ({
        key: `${section}.${key}`,
        defaultValue: copy(this.profile.defaults.get(`${section}.${key}`) as T),
        globalValue: copy(this.profile.global.get(`${section}.${key}`) as T),
        workspaceValue: copy(this.settings.get(`${section}.${key}`) as T),
      }),
      update: async (key: string, value: unknown, target: vscode.ConfigurationTarget) => {
        const fullKey = `${section}.${key}`;
        this.profile.writes.push({ window: this.id, key: fullKey, value: copy(value), target });
        if (target === vscode.ConfigurationTarget.Global) { this.profile.setGlobal(fullKey, value); }
        else { this.setWorkspace(fullKey, value); }
      },
    });
    const fakeVscode = {
      Uri: vscode.Uri,
      Disposable: vscode.Disposable,
      RelativePattern: vscode.RelativePattern,
      ConfigurationTarget: vscode.ConfigurationTarget,
      workspace: {
        workspaceFolders: this.workspacePresent ? [{ name: this.id, index: 0, uri: vscode.Uri.file(workspaceDirectory) }] : undefined,
        getConfiguration: configuration,
        onDidChangeConfiguration: this.configurationChanges.event,
        fs: { readFile: async (uri: vscode.Uri) => new Uint8Array(await fs.readFile(uri.fsPath)) },
        createFileSystemWatcher: (pattern: vscode.RelativePattern) => {
          const watcher = { pattern, changes: new vscode.EventEmitter<vscode.Uri>(), disposed: false };
          this.watchers.push(watcher);
          return {
            dispose: () => { watcher.disposed = true; watcher.changes.dispose(); },
            onDidChange: watcher.changes.event,
            onDidCreate: watcher.changes.event,
            onDidDelete: watcher.changes.event,
          };
        },
      },
      extensions: { all: this.profile.extensions, onDidChange: this.extensionChanges.event },
    };
    const filename = path.join(__dirname, '..', 'noteIconTheme.js');
    const source = await fs.readFile(filename, 'utf8');
    const module = { exports: {} as { NoteIconThemeController: ControllerConstructor } };
    const actualRequire = createRequire(filename);
    const factory = new vm.Script(`(function(exports, require, module, __filename, __dirname) {${source}\n})`, { filename }).runInThisContext();
    factory(module.exports, (name: string) => name === 'vscode' ? fakeVscode : actualRequire(name), module, filename, path.dirname(filename));
    const controller = new module.exports.NoteIconThemeController(context, message => this.reports.push(message));
    this.controllers.push(controller);
    return controller;
  }

  async generatedTheme(): Promise<Record<string, any>> {
    const selected = this.effective<string>(THEME_KEY);
    assert.ok(typeof selected === 'string' && selected.startsWith('cnp-notepad-icons-'), 'The window did not select its managed theme');
    const slot = selected.slice('cnp-notepad-icons-'.length);
    return JSON.parse(await fs.readFile(path.join(this.profile.directory, 'notepads-extension', 'themes', `notepads-${slot}.json`), 'utf8'));
  }

  async dispose(): Promise<void> {
    await Promise.all(this.controllers.map(controller => controller.shutdown()));
    this.controllers.forEach(controller => controller.dispose());
    this.configurationChanges.dispose();
    this.extensionChanges.dispose();
  }
}

suite('Notepads icon theme window and profile isolation', function () {
  this.timeout(15000);
  let directory: string;
  let profile: Profile;

  setup(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cnp-icon-regression-'));
    profile = new Profile(directory);
    await profile.addTheme(ORIGINAL_THEME, '_fixture_file');
    await profile.addTheme(ALTERNATE_THEME, '_alternate_file');
    await profile.addTheme('vs-seti', '_seti_file');
  });

  teardown(async () => {
    await Promise.all(profile.windows.map(window => window.dispose()));
    assert.strictEqual(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('cnp-icon-regression-'));
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('An enabled window and a disabled window keep separate themes without rewriting their shared profile', async () => {
    const disabled = new TestWindow(profile, 'disabled-window');
    const enabled = new TestWindow(profile, 'enabled-window');
    disabled.setWorkspace(FEATURE_KEY, false);
    enabled.setWorkspace(FEATURE_KEY, true);
    const first = await disabled.controller();
    const second = await enabled.controller();
    await Promise.all([first.start(), second.start()]);
    assert.deepStrictEqual(await Promise.all([first.ensureEnabled(), second.ensureEnabled()]), [false, true]);
    assert.strictEqual(disabled.effective(THEME_KEY), ORIGINAL_THEME);
    assert.strictEqual((await enabled.generatedTheme()).file, '_fixture_file');

    profile.setGlobal(THEME_KEY, ALTERNATE_THEME);
    assert.deepStrictEqual(await Promise.all([first.ensureEnabled(), second.ensureEnabled()]), [false, true]);
    assert.strictEqual(disabled.effective(THEME_KEY), ALTERNATE_THEME);
    assert.strictEqual((await enabled.generatedTheme()).file, '_alternate_file');

    enabled.setWorkspace(FEATURE_KEY, false);
    assert.strictEqual(await second.ensureEnabled(), false);
    assert.strictEqual(enabled.effective(THEME_KEY), ALTERNATE_THEME);
    enabled.setWorkspace(FEATURE_KEY, true);
    assert.strictEqual(await second.ensureEnabled(), true);
    assert.strictEqual(disabled.effective(THEME_KEY), ALTERNATE_THEME);
    assert.strictEqual((await enabled.generatedTheme()).file, '_alternate_file');
    assert.deepStrictEqual(profile.writes.filter(write => write.key === THEME_KEY && write.target === vscode.ConfigurationTarget.Global), []);
    assert.deepStrictEqual(disabled.reports, []);
    assert.deepStrictEqual(enabled.reports, []);
  });

  test('A synchronized global slot without local registry or metadata recovers the default theme', async () => {
    profile.setGlobal(THEME_KEY, 'cnp-notepad-icons-7');
    const window = new TestWindow(profile, 'synced-global-window');
    const controller = await window.controller();
    await controller.start();
    assert.strictEqual(await controller.ensureEnabled(), true);
    assert.strictEqual(profile.global.has(THEME_KEY), false);
    assert.strictEqual((await window.generatedTheme()).file, '_fixture_file');
    assert.strictEqual(window.reports.length, 1);
    assert.match(window.reports[0], /복구/);
    assert.strictEqual(await controller.ensureEnabled(), true);
    assert.strictEqual(window.reports.length, 1);
  });

  test('A window without a workspace restores legacy and newly synchronized global slots without creating a workspace theme', async () => {
    profile.setGlobal(FEATURE_KEY, false);
    profile.setGlobal(THEME_KEY, 'cnp-notepad-icons-7');
    const window = new TestWindow(profile, 'empty-window');
    window.workspacePresent = false;
    const controller = await window.controller();
    await controller.start();
    assert.strictEqual(profile.global.has(THEME_KEY), false);
    assert.strictEqual(window.effective(THEME_KEY), ORIGINAL_THEME);
    assert.strictEqual(await controller.ensureEnabled(), false);
    assert.strictEqual(window.settings.has(THEME_KEY), false);
    assert.strictEqual(window.settings.has(SOURCE_KEY), false);

    profile.setGlobal(THEME_KEY, 'cnp-notepad-icons-8');
    const deadline = Date.now() + 3000;
    while (profile.global.has(THEME_KEY)) {
      assert.ok(Date.now() < deadline, 'A synchronized global slot was not restored in a window without a workspace');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.strictEqual(window.effective(THEME_KEY), ORIGINAL_THEME);
    assert.strictEqual(await controller.ensureEnabled(), false);
    assert.strictEqual(window.settings.has(THEME_KEY), false);
    assert.strictEqual(window.settings.has(SOURCE_KEY), false);
    assert.deepStrictEqual(profile.writes.filter(write => write.target === vscode.ConfigurationTarget.Workspace), []);
    assert.strictEqual(profile.writes.filter(write => write.key === THEME_KEY && write.target === vscode.ConfigurationTarget.Global).length, 2);
  });

  test('A synchronized workspace slot is rebuilt from its source metadata on a new machine', async () => {
    const window = new TestWindow(profile, 'synced-workspace-window');
    window.setWorkspace(THEME_KEY, 'cnp-notepad-icons-11');
    window.setWorkspace(SOURCE_KEY, { source: ALTERNATE_THEME, original: { defined: false } });
    const controller = await window.controller();
    await controller.start();
    assert.strictEqual(await controller.ensureEnabled(), true);
    assert.strictEqual(profile.global.get(THEME_KEY), ORIGINAL_THEME);
    assert.strictEqual((await window.generatedTheme()).file, '_alternate_file');
    window.setWorkspace(FEATURE_KEY, false);
    assert.strictEqual(await controller.ensureEnabled(), false);
    assert.strictEqual(window.settings.has(THEME_KEY), false);
    assert.strictEqual(window.effective(THEME_KEY), ORIGINAL_THEME);
    assert.deepStrictEqual(window.reports, []);
  });

  for (const original of [undefined, null, ALTERNATE_THEME] as ThemeSetting[]) {
    test(`Shutdown restores the original workspace setting ${String(original)} and restart resumes the icon`, async () => {
      const window = new TestWindow(profile, 'restart-window');
      window.setWorkspace(THEME_KEY, original);
      const before = await window.controller();
      await before.start();
      assert.strictEqual(await before.ensureEnabled(), true);
      assert.ok(window.effective<string>(THEME_KEY)?.startsWith('cnp-notepad-icons-'));
      await before.shutdown();
      before.dispose();
      assert.strictEqual(window.settings.get(THEME_KEY), original);
      assert.strictEqual(window.settings.has(THEME_KEY), original !== undefined);
      assert.strictEqual(window.settings.has(SOURCE_KEY), false);
      assert.strictEqual(profile.global.get(THEME_KEY), ORIGINAL_THEME);

      const after = await window.controller();
      await after.start();
      const generated = await window.generatedTheme();
      if (original === ALTERNATE_THEME) { assert.strictEqual(generated.file, '_alternate_file'); }
      else if (original === undefined) { assert.strictEqual(generated.file, '_fixture_file'); }
      else { assert.strictEqual(generated.file, undefined); }
      await after.shutdown();
      assert.strictEqual(window.settings.get(THEME_KEY), original);
      assert.strictEqual(window.settings.has(THEME_KEY), original !== undefined);
      assert.deepStrictEqual(profile.writes.filter(write => write.key === THEME_KEY && write.target === vscode.ConfigurationTarget.Global), []);
      assert.deepStrictEqual(window.reports, []);
    });
  }

  test('A missing synchronized source retains usable original file icons and can recover when installed', async () => {
    const window = new TestWindow(profile, 'missing-source-window');
    window.setWorkspace(THEME_KEY, 'cnp-notepad-icons-10');
    window.setWorkspace(SOURCE_KEY, { source: 'fixture-missing-icons', original: { defined: false } });
    const controller = await window.controller();
    await controller.start();
    assert.strictEqual(await controller.ensureEnabled(), true);
    assert.strictEqual(profile.global.get(THEME_KEY), ORIGINAL_THEME);
    assert.strictEqual((await window.generatedTheme()).file, '_fixture_file');
    assert.strictEqual(window.effective<{ source: string }>(SOURCE_KEY)?.source, 'fixture-missing-icons');

    await profile.addTheme('fixture-missing-icons', '_installed_file');
    assert.strictEqual(await controller.ensureEnabled(), true);
    assert.strictEqual((await window.generatedTheme()).file, '_installed_file');
    assert.deepStrictEqual(profile.writes.filter(write => write.key === THEME_KEY && write.target === vscode.ConfigurationTarget.Global), []);
  });

  test('Deleting and restoring a theme asset refreshes its icons without changing its JSON or version', async () => {
    const window = new TestWindow(profile, 'asset-recovery-window');
    window.setWorkspace(THEME_KEY, ALTERNATE_THEME);
    const controller = await window.controller();
    await controller.start();
    assert.strictEqual(await controller.ensureEnabled(), true);
    assert.strictEqual((await window.generatedTheme()).file, '_alternate_file');
    const asset = vscode.Uri.file(path.join(directory, ALTERNATE_THEME, 'file.svg'));
    const original = await fs.readFile(asset.fsPath);
    const waitForIcon = async (expected: string) => {
      const deadline = Date.now() + 3000;
      while ((await window.generatedTheme()).file !== expected) {
        assert.ok(Date.now() < deadline, 'The source asset watcher did not refresh the theme');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };

    await fs.unlink(asset.fsPath);
    window.fileChanged(asset);
    await waitForIcon('_fixture_file');
    assert.strictEqual(window.effective<{ source: string }>(SOURCE_KEY)?.source, ALTERNATE_THEME);
    await fs.writeFile(asset.fsPath, original);
    window.fileChanged(asset);
    await waitForIcon('_alternate_file');
    assert.strictEqual(profile.global.get(THEME_KEY), ORIGINAL_THEME);
    assert.deepStrictEqual(profile.writes.filter(write => write.key === THEME_KEY && write.target === vscode.ConfigurationTarget.Global), []);
  });
});
