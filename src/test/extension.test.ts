import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as iconv from 'iconv-lite';
import { parse } from 'jsonc-parser';
import { ManagedNote, NOTE_ICON_PARENT, NOTE_SCHEME, NoteFileSystem } from '../noteFileSystem';

type NoteItem = { note: ManagedNote };

type ExtensionApi = {
  notes: {
    getChildren(): vscode.ProviderResult<NoteItem[]>;
    addNote(name: string, text: string): Promise<boolean>;
    updateNote(id: string, name: string, text: string): Promise<boolean>;
    updateNoteText(id: string, text: string): Promise<boolean>;
    updateNoteName(id: string, name: string): Promise<boolean>;
    getNoteById(id: string): ManagedNote | undefined;
    deleteNote(id: string): Promise<boolean>;
    rescan(): Promise<void>;
    handleDrag(source: readonly NoteItem[], transfer: vscode.DataTransfer): Promise<void>;
    handleDrop(target: NoteItem | undefined, transfer: vscode.DataTransfer): Promise<void>;
  };
  files: NoteFileSystem;
  icons: vscode.Disposable & { ensureEnabled(): Promise<boolean> };
};

type Theme = Record<string, any>;
type ThemeContribution = { id: string; path: string };

async function eventually<T>(read: () => T | Promise<T>, matches: (value: T) => boolean, message: string): Promise<T> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const value = await read();
    if (matches(value)) { return value; }
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function noteTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
    tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
  );
}

async function replaceText(editor: vscode.TextEditor, text: string): Promise<void> {
  const range = new vscode.Range(new vscode.Position(0, 0), editor.document.positionAt(editor.document.getText().length));
  assert.strictEqual(await editor.edit(edit => edit.replace(range, text)), true);
}

async function readTheme(id: string): Promise<Theme> {
  for (const extension of vscode.extensions.all) {
    const contributions: ThemeContribution[] = extension.packageJSON?.contributes?.iconThemes ?? [];
    const contribution = contributions.find(theme => theme.id === id);
    if (!contribution) { continue; }
    const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, contribution.path));
    return parse(Buffer.from(content).toString('utf8')) as Theme;
  }
  throw new Error(`Icon theme not found: ${id}`);
}

function assertThemeAssociations(source: Theme, generated: Theme): void {
  const mapping = { [`${NOTE_ICON_PARENT}/note`]: '_cnp_notepad' };
  assert.deepStrictEqual(generated.fileNames, { ...source.fileNames, ...mapping });
  for (const key of [
    'file', 'fileExtensions', 'languageIds', 'folder', 'folderExpanded', 'folderNames',
    'folderNamesExpanded', 'rootFolder', 'rootFolderExpanded', 'rootFolderNames',
    'rootFolderNamesExpanded', 'hidesExplorerArrows',
  ]) {
    assert.deepStrictEqual(generated[key], source[key], `Original theme association changed: ${key}`);
  }
  const hasSpecificFileIcon = [source, source.light, source.highContrast, source.highContrastLight]
    .some(variant => variant && ['fileNames', 'fileExtensions', 'languageIds']
      .some(key => Object.keys(variant[key] ?? {}).length > 0));
  assert.strictEqual(generated.showLanguageModeIcons, source.showLanguageModeIcons ?? hasSpecificFileIcon);
  for (const variant of ['light', 'highContrast', 'highContrastLight']) {
    if (variant === 'highContrastLight' && !source[variant]) {
      assert.strictEqual(generated[variant], undefined);
      continue;
    }
    assert.deepStrictEqual(generated[variant], {
      ...source[variant],
      fileNames: { ...source[variant]?.fileNames, ...mapping },
    });
  }
}

suite('Notepads native editor integration', function () {
  this.timeout(20000);

  let api: ExtensionApi;
  let originalTheme: string | null | undefined;
  let originalGlobalTheme: string | null | undefined;
  let originalWorkspaceTheme: string | null | undefined;
  let originalGlobalFeature: boolean | undefined;
  let originalWorkspaceFeature: boolean | undefined;
  const createdIds: string[] = [];
  let fixtureFile: vscode.Uri | undefined;

  const themeSetting = () => vscode.workspace.getConfiguration('workbench').get<string | null>('iconTheme');

  async function createNote(name: string, text: string): Promise<ManagedNote> {
    assert.strictEqual(await api.notes.addNote(name, text), true);
    const items = await api.notes.getChildren();
    const note = items?.find(item => item.note.name === name)?.note;
    assert.ok(note, `Created note missing from Notepads: ${name}`);
    createdIds.push(note.id);
    return note;
  }

  async function openNote(note: ManagedNote): Promise<vscode.TextEditor> {
    await vscode.commands.executeCommand('cnp.openNote', note);
    const uri = api.files.uriForNote(note.id);
    const editor = await eventually(
      () => vscode.window.activeTextEditor,
      current => current?.document.uri.toString() === uri.toString(),
      'The note did not open in the native text editor',
    );
    assert.ok(editor);
    return editor;
  }

  suiteSetup(async () => {
    assert.ok(vscode.workspace.workspaceFolders?.length, 'An isolated fixture workspace is required');
    const workbench = vscode.workspace.getConfiguration('workbench');
    originalTheme = workbench.get<string | null>('iconTheme');
    const themeValues = workbench.inspect<string | null>('iconTheme');
    originalGlobalTheme = themeValues?.globalValue;
    originalWorkspaceTheme = themeValues?.workspaceValue;
    const featureValues = vscode.workspace.getConfiguration('cursorNotepads').inspect<boolean>('noteTabIcon');
    originalGlobalFeature = featureValues?.globalValue;
    originalWorkspaceFeature = featureValues?.workspaceValue;
    const extension = vscode.extensions.getExtension<ExtensionApi>('lch.cursor-notepads');
    assert.ok(extension, 'The development extension is not available');
    api = await extension.activate();
  });

  suiteTeardown(async () => {
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && api?.files.noteIdForUri(document.uri)) {
        await document.save();
      }
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const id of createdIds) {
      if (api?.notes.getNoteById(id)) {
        await api.notes.deleteNote(id);
        api.files.notifyChanged(id);
      }
    }
    if (fixtureFile) { await vscode.workspace.fs.delete(fixtureFile); }
    const feature = vscode.workspace.getConfiguration('cursorNotepads');
    await feature.update('noteTabIcon', false, vscode.ConfigurationTarget.Workspace);
    await eventually(themeSetting, current => !current?.startsWith('cnp-notepad-icons-'), 'The original theme was not restored');
    api.icons.dispose();
    await feature.update('noteTabIcon', originalGlobalFeature, vscode.ConfigurationTarget.Global);
    await feature.update('noteTabIcon', originalWorkspaceFeature, vscode.ConfigurationTarget.Workspace);
    const workbench = vscode.workspace.getConfiguration('workbench');
    await workbench.update('iconTheme', originalGlobalTheme, vscode.ConfigurationTarget.Global);
    await workbench.update('iconTheme', originalWorkspaceTheme, vscode.ConfigurationTarget.Workspace);
  });

  test('Preserves Korean dotted titles, Markdown, and the native editor', async () => {
    const note = await createNote('회의.정리', '# 회의 기록\n첫 내용');
    const editor = await openNote(note);
    assert.strictEqual(editor.document.uri.scheme, NOTE_SCHEME);
    assert.strictEqual(editor.document.uri.path.split('/').at(-2), NOTE_ICON_PARENT);
    assert.strictEqual(editor.document.languageId, 'markdown');
    assert.strictEqual(editor.document.getText(), note.text);
    await eventually(() => noteTab(editor.document.uri)?.label, label => label === note.name, 'The note title lost part of its name');
    assert.strictEqual(api.files.noteIdForUri(vscode.Uri.parse(editor.document.uri.toString())), note.id);
  });

  test('Saves native editor changes and simultaneous changes to two notes', async () => {
    const first = await createNote('동시저장.하나', '첫째');
    const second = await createNote('동시저장.둘', '둘째');
    const firstEditor = await openNote(first);
    await replaceText(firstEditor, '# 수정된 첫째\n하나');
    const secondEditor = await openNote(second);
    await replaceText(secondEditor, '# 수정된 둘째\n둘');
    const firstText = firstEditor.document.getText();
    const secondText = secondEditor.document.getText();
    assert.deepStrictEqual(await Promise.all([firstEditor.document.save(), secondEditor.document.save()]), [true, true]);
    assert.strictEqual(api.notes.getNoteById(first.id)?.text, firstText);
    assert.strictEqual(api.notes.getNoteById(second.id)?.text, secondText);
    const reopenedFirst = await openNote(first);
    const before = api.files.stat(reopenedFirst.document.uri).mtime;
    await replaceText(reopenedFirst, '첫째 최종 내용');
    assert.strictEqual(await reopenedFirst.document.save(), true);
    assert.ok(api.files.stat(reopenedFirst.document.uri).mtime > before);
    assert.strictEqual(api.notes.getNoteById(first.id)?.text, '첫째 최종 내용');
    assert.strictEqual(api.notes.getNoteById(second.id)?.text, secondText);
  });

  test('Concurrent text updates, renaming, and rescanning preserve both changes', async () => {
    const note = await createNote('동시변경.원래제목', '이전 본문');
    const text = '동시에 저장한 새 본문';
    const name = '동시변경.새제목';
    const results = await Promise.all([
      api.notes.updateNoteText(note.id, text),
      api.notes.updateNoteName(note.id, name),
      api.notes.rescan(),
    ]);
    assert.deepStrictEqual(results.slice(0, 2), [true, true]);
    assert.strictEqual(api.notes.getNoteById(note.id)?.text, text);
    assert.strictEqual(api.notes.getNoteById(note.id)?.name, name);
    const editor = await openNote(note);
    assert.strictEqual(editor.document.getText(), text);
    await eventually(() => noteTab(editor.document.uri)?.label, label => label === name, 'The concurrent rename was lost');
  });

  test('Dropping a stale dragged item preserves the latest saved name and text', async () => {
    const note = await createNote('끌기.원래제목', '끌기 전 본문');
    await createNote('끌기.대상', '다른 노트');
    const staleItem = (await api.notes.getChildren())?.find(item => item.note.id === note.id);
    assert.ok(staleItem);
    const transfer = new vscode.DataTransfer();
    await api.notes.handleDrag([staleItem], transfer);
    await api.notes.rescan();
    const text = '끌기 도중 저장된 최신 본문';
    const name = '끌기.최신제목';
    assert.strictEqual(await api.notes.updateNoteText(note.id, text), true);
    assert.strictEqual(await api.notes.updateNoteName(note.id, name), true);
    await api.notes.handleDrop(undefined, transfer);
    assert.strictEqual(api.notes.getNoteById(note.id)?.text, text);
    assert.strictEqual(api.notes.getNoteById(note.id)?.name, name);
    assert.strictEqual((await api.notes.getChildren())?.at(-1)?.note.id, note.id);
  });

  test('Reopening an unsaved note preserves edits and reopening a closed note restores saved text', async () => {
    const note = await createNote('저장전.다시열기', '저장된 내용');
    let editor = await openNote(note);
    await replaceText(editor, '아직 저장하지 않은 편집');
    assert.strictEqual(editor.document.isDirty, true);
    editor = await openNote(note);
    assert.strictEqual(editor.document.getText(), '아직 저장하지 않은 편집');
    assert.strictEqual(editor.document.isDirty, true);
    assert.strictEqual(api.notes.getNoteById(note.id)?.text, '저장된 내용');
    assert.strictEqual(await editor.document.save(), true);
    const tab = noteTab(editor.document.uri);
    assert.ok(tab);
    assert.strictEqual(await vscode.window.tabGroups.close(tab), true);
    editor = await openNote(note);
    assert.strictEqual(editor.document.getText(), '아직 저장하지 않은 편집');
    assert.strictEqual(editor.document.isDirty, false);
  });

  test('Upgrading a legacy dirty note preserves its edits and migrates after saving', async function () {
    const globalStorageDirectory = process.env.CNP_TEST_GLOBAL_STORAGE_DIR;
    if (!globalStorageDirectory) { this.skip(); }
    const note = await createNote('이전.편집탭', '업데이트 전 저장된 내용');
    const directory = vscode.Uri.file(path.join(globalStorageDirectory, note.id));
    const legacyUri = vscode.Uri.joinPath(directory, 'legacy-title');
    let legacyDocument: vscode.TextDocument | undefined;
    try {
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(legacyUri, Buffer.from(note.text, 'utf8'));
      legacyDocument = await vscode.workspace.openTextDocument(legacyUri);
      const legacyEditor = await vscode.window.showTextDocument(legacyDocument, { preview: false });
      await replaceText(legacyEditor, '업데이트 도중 저장하지 않은 편집');
      const editedText = legacyDocument.getText();
      assert.strictEqual(legacyDocument.isDirty, true);

      await vscode.commands.executeCommand('cnp.openNote', note);
      const reopened = await eventually(
        () => vscode.window.activeTextEditor,
        editor => editor?.document.uri.toString() === legacyUri.toString(),
        'The legacy dirty tab was replaced during upgrade',
      );
      assert.ok(reopened);
      assert.strictEqual(reopened.document.getText(), editedText);
      assert.strictEqual(reopened.document.isDirty, true);
      assert.strictEqual(api.notes.getNoteById(note.id)?.text, note.text);
      assert.strictEqual(await legacyDocument.save(), true);
      await eventually(
        () => api.notes.getNoteById(note.id)?.text,
        text => text === editedText,
        'Saving a legacy note did not persist its edits',
      );

      const tab = noteTab(legacyUri);
      assert.ok(tab);
      assert.strictEqual(await vscode.window.tabGroups.close(tab), true);
      const migrated = await openNote(note);
      assert.strictEqual(migrated.document.uri.scheme, NOTE_SCHEME);
      assert.strictEqual(migrated.document.getText(), editedText);
      assert.strictEqual(migrated.document.isDirty, false);
    } finally {
      if (legacyDocument?.isDirty) { await legacyDocument.save(); }
      const tab = noteTab(legacyUri);
      if (tab) { await vscode.window.tabGroups.close(tab); }
      await vscode.workspace.fs.delete(directory, { recursive: true });
    }
  });

  test('Upgrading a clean legacy tab closes it before opening the managed editor', async function () {
    const globalStorageDirectory = process.env.CNP_TEST_GLOBAL_STORAGE_DIR;
    if (!globalStorageDirectory) { this.skip(); }
    const note = await createNote('이전.저장된탭', '업데이트 전에 저장한 내용');
    const directory = vscode.Uri.file(path.join(globalStorageDirectory, note.id));
    const legacyUri = vscode.Uri.joinPath(directory, 'legacy-clean-title');
    try {
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(legacyUri, Buffer.from(note.text, 'utf8'));
      const document = await vscode.workspace.openTextDocument(legacyUri);
      await vscode.window.showTextDocument(document, { preview: false });
      assert.strictEqual(document.isDirty, false);
      const managed = await openNote(note);
      await eventually(() => noteTab(legacyUri), tab => tab === undefined, 'The old clean tab still has a second editable copy');
      await replaceText(managed, '업데이트 뒤 새 편집기에서 저장한 내용');
      assert.strictEqual(await managed.document.save(), true);
      assert.strictEqual(api.notes.getNoteById(note.id)?.text, managed.document.getText());
      const latest = managed.document.getText();
      const resurrected = await vscode.workspace.openTextDocument(legacyUri);
      const oldEditor = await vscode.window.showTextDocument(resurrected, { preview: false });
      await replaceText(oldEditor, '최근 파일에서 다시 연 오래된 본문 편집');
      assert.strictEqual(await resurrected.save(), true);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.strictEqual(api.notes.getNoteById(note.id)?.text, latest, 'A manually reopened old tab overwrote the managed editor');
      assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(legacyUri)).toString('utf8'), resurrected.getText());
    } finally {
      const tab = noteTab(legacyUri);
      if (tab) { await vscode.window.tabGroups.close(tab); }
      await vscode.workspace.fs.delete(directory, { recursive: true });
    }
  });

  test('Refreshing external changes updates clean editors and preserves unsaved edits', async function () {
    const globalStorageDirectory = process.env.CNP_TEST_GLOBAL_STORAGE_DIR;
    if (!globalStorageDirectory) { this.skip(); }
    const note = await createNote('재조회.외부변경', '이전 저장 본문');
    let editor = await openNote(note);
    const uri = editor.document.uri;
    const storeUri = vscode.Uri.file(path.resolve(globalStorageDirectory, '..', '..', 'workspaceStorage', uri.path.split('/')[1], 'notepads.json'));
    const rewriteExternal = async (text: string) => {
      const stored = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(storeUri)).toString('utf8')) as ManagedNote[];
      stored.find(item => item.id === note.id)!.text = text;
      await vscode.workspace.fs.writeFile(storeUri, Buffer.from(JSON.stringify(stored), 'utf8'));
      await vscode.commands.executeCommand('cnp.refresh');
    };
    const before = api.files.stat(uri).mtime;
    const external = '다른 창에서 저장한 최신 본문';
    await rewriteExternal(external);
    await eventually(() => editor.document.getText(), text => text === external, 'Refresh left the clean editor on its old text');
    assert.ok(api.files.stat(uri).mtime > before);
    editor = await openNote(note);
    assert.strictEqual(editor.document.getText(), external);
    await replaceText(editor, '이 창에서 아직 저장하지 않은 본문');
    const unsaved = editor.document.getText();
    await rewriteExternal('다른 창에서 두 번째로 저장한 본문');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.strictEqual(editor.document.getText(), unsaved);
    assert.strictEqual(editor.document.isDirty, true);
    assert.strictEqual(await editor.document.save(), false, 'A conflicting dirty save overwrote the refreshed external text');
    assert.strictEqual(api.notes.getNoteById(note.id)?.text, '다른 창에서 두 번째로 저장한 본문');
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await eventually(() => editor.document.getText(), text => text === '다른 창에서 두 번째로 저장한 본문', 'Revert did not use the refreshed persisted text');
  });

  test('Configured UTF-16, UTF-8 BOM, and Korean encodings preserve Unicode note text', async () => {
    const configuration = vscode.workspace.getConfiguration('files');
    const original = configuration.inspect<string>('encoding')?.workspaceValue;
    try {
      for (const encoding of ['utf16le', 'utf8bom', 'euckr']) {
        await configuration.update('encoding', encoding, vscode.ConfigurationTarget.Workspace);
        const text = '# 한글 메모\r\n인코딩과 줄바꿈을 유지한다';
        const note = await createNote(`인코딩.${encoding}`, text);
        let editor = await openNote(note);
        assert.strictEqual(editor.document.getText(), text, `Opening with ${encoding} corrupted the text`);
        await replaceText(editor, `수정한 한글 메모\r\n${encoding} 저장 검증`);
        const edited = editor.document.getText();
        assert.strictEqual(await editor.document.save(), true);
        assert.strictEqual(api.notes.getNoteById(note.id)?.text, edited, `Saving with ${encoding} corrupted the text`);
        const tab = noteTab(editor.document.uri);
        assert.ok(tab);
        await vscode.window.tabGroups.close(tab);
        editor = await openNote(note);
        assert.strictEqual(editor.document.getText(), edited, `Reopening with ${encoding} corrupted the text`);
      }
    } finally {
      await configuration.update('encoding', original, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('UTF-16 byte writes preserve Unicode and malformed unmarked writes cannot corrupt notes', async () => {
    const note = await createNote('인코딩.바이트저장', '원래 본문');
    const editor = await openNote(note);
    const text = 'UTF-16 한글 저장\r\n둘째 줄';
    await vscode.workspace.fs.writeFile(editor.document.uri, iconv.encode(text, 'utf16le', { addBOM: true }));
    await eventually(() => editor.document.getText(), current => current === text, 'UTF-16 data was not decoded back to Unicode');
    assert.strictEqual(api.notes.getNoteById(note.id)?.text, text);
    await assert.rejects(async () => vscode.workspace.fs.writeFile(editor.document.uri, Buffer.from([0x80, 0x81, 0x82])));
    assert.strictEqual(api.notes.getNoteById(note.id)?.text, text);
  });

  test('Explicit native encoding changes save the original Unicode text', async function () {
    const note = await createNote('인코딩.직접선택', '선택 인코딩 검증');
    let editor = await openNote(note);
    if (typeof editor.document.encoding !== 'string') { this.skip(); }
    for (const encoding of ['utf16le', 'euckr']) {
      const document = await vscode.workspace.openTextDocument(editor.document.uri, { encoding });
      assert.strictEqual(document.encoding, encoding);
      editor = await vscode.window.showTextDocument(document, { preview: false });
      await replaceText(editor, `직접 선택한 한글 인코딩 😀\r\n${encoding} 원문 검증`);
      const expected = editor.document.getText();
      assert.strictEqual(await editor.document.save(), true);
      assert.strictEqual(api.notes.getNoteById(note.id)?.text, expected);
    }
  });

  test('Renaming changes the title while preserving the URI and saved content', async () => {
    const note = await createNote('이름.변경전', '이름 변경 내용');
    const editor = await openNote(note);
    const uri = editor.document.uri;
    const renamed = '이름.변경후.정리';
    assert.strictEqual(await api.notes.updateNote(note.id, renamed, editor.document.getText()), true);
    await vscode.commands.executeCommand('vscode.open', uri, { preview: false }, renamed);
    await eventually(() => noteTab(uri)?.label, label => label === renamed, 'The renamed title did not update');
    assert.strictEqual(api.files.uriForNote(note.id).toString(), uri.toString());
    assert.strictEqual(api.notes.getNoteById(note.id)?.text, '이름 변경 내용');
  });

  test('Ordinary .np files keep their original names and original theme associations', async () => {
    fixtureFile = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'fixture-file.np');
    await vscode.workspace.fs.writeFile(fixtureFile, Buffer.from('일반 np 파일', 'utf8'));
    const document = await vscode.workspace.openTextDocument(fixtureFile);
    await vscode.commands.executeCommand('vscode.open', fixtureFile, { preview: false });
    await eventually(() => noteTab(fixtureFile!)?.label, label => label === 'fixture-file.np', 'An ordinary .np filename was changed');
    assert.strictEqual(document.uri.scheme, 'file');
    assert.strictEqual(api.files.noteIdForUri(document.uri), undefined);

    const selected = themeSetting();
    assert.ok(typeof selected === 'string' && selected.startsWith('cnp-notepad-icons-'), 'The generated Notepads theme is not selected');
    assert.strictEqual(vscode.workspace.getConfiguration('workbench').inspect<string | null>('iconTheme')?.globalValue, originalGlobalTheme);
    const generated = await readTheme(selected);
    const source = originalTheme ? await readTheme(originalTheme) : { showLanguageModeIcons: false };
    assertThemeAssociations(source, generated);
    assert.strictEqual(generated.iconDefinitions._cnp_notepad.iconPath, '../assets/notepad-tab.svg');
    assert.strictEqual(generated.fileNames['fixture-file.np'], source.fileNames?.['fixture-file.np']);
  });

  test('Disabling the feature restores exact original settings and enabling it restores the note icon', async () => {
    const feature = vscode.workspace.getConfiguration('cursorNotepads');
    await feature.update('noteTabIcon', false, vscode.ConfigurationTarget.Workspace);
    await eventually(themeSetting, current => current === originalTheme, 'The original icon theme was not restored');
    const restored = vscode.workspace.getConfiguration('workbench').inspect<string | null>('iconTheme');
    assert.strictEqual(restored?.globalValue, originalGlobalTheme);
    assert.strictEqual(restored?.workspaceValue, originalWorkspaceTheme);

    await feature.update('noteTabIcon', true, vscode.ConfigurationTarget.Workspace);
    const note = await createNote('아이콘.재활성화', '기능 재활성화');
    const editor = await openNote(note);
    await eventually(themeSetting, current => !!current?.startsWith('cnp-notepad-icons-'), 'The note icon theme was not enabled again');
    assert.strictEqual(editor.document.languageId, 'markdown');
    assert.strictEqual(editor.document.getText(), note.text);
  });

  test('Deleted notes become unavailable through the managed filesystem', async () => {
    const note = await createNote('삭제.검증', '삭제할 내용');
    const uri = api.files.uriForNote(note.id);
    await openNote(note);
    const tab = noteTab(uri);
    assert.ok(tab);
    await vscode.window.tabGroups.close(tab);
    assert.strictEqual(await api.notes.deleteNote(note.id), true);
    api.files.notifyChanged(note.id);
    assert.throws(() => api.files.readFile(uri), error => error instanceof vscode.FileSystemError && error.code === 'FileNotFound');
    assert.throws(() => api.files.stat(uri), error => error instanceof vscode.FileSystemError && error.code === 'FileNotFound');
  });
});
