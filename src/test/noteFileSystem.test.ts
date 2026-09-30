import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vm from 'vm';
import { createRequire } from 'module';
import * as vscode from 'vscode';
import * as iconv from 'iconv-lite';
import type { ManagedNote, NoteFileSystem } from '../noteFileSystem';

type FixtureDocument = {
  uri: vscode.Uri;
  isClosed: boolean;
  getText(): string;
  encoding?: string;
};

async function createFixture(configuredEncoding: string, editorText: string, documentEncoding?: string) {
  const documents: FixtureDocument[] = [];
  const fakeVscode = {
    Uri: vscode.Uri,
    EventEmitter: vscode.EventEmitter,
    Disposable: vscode.Disposable,
    FileSystemError: vscode.FileSystemError,
    FileType: vscode.FileType,
    FileChangeType: vscode.FileChangeType,
    workspace: {
      textDocuments: documents,
      getConfiguration: () => ({
        get: (key: string, fallback: unknown) => key === 'encoding' ? configuredEncoding : fallback,
      }),
    },
  };
  const modulePath = path.resolve(__dirname, '..', 'noteFileSystem.js');
  const source = await fs.readFile(modulePath, 'utf8');
  const localRequire = createRequire(modulePath);
  const loaded: { exports: unknown } = { exports: {} };
  const initialize = new vm.Script(`(function(require, module, exports) {\n${source}\n})`, {
    filename: modulePath,
  }).runInNewContext({ Buffer, TextDecoder }) as (
    require: (specifier: string) => unknown,
    module: { exports: unknown },
    exports: unknown,
  ) => void;
  initialize(specifier => specifier === 'vscode' ? fakeVscode : localRequire(specifier), loaded, loaded.exports);
  const exports = loaded.exports as { NoteFileSystem: typeof NoteFileSystem };
  const persisted: ManagedNote = { id: 'encoding-fixture', name: '인코딩.호환', text: '기존 저장된 원문' };
  let saveCalls = 0;
  const files = new exports.NoteFileSystem('fixture-workspace', id => id === persisted.id ? persisted : undefined, async (id, text) => {
    assert.strictEqual(id, persisted.id);
    saveCalls++;
    persisted.text = text;
    return true;
  });
  const uri = files.uriForNote(persisted.id);
  const document: FixtureDocument = { uri, isClosed: false, getText: () => editorText };
  if (documentEncoding !== undefined) { document.encoding = documentEncoding; }
  documents.push(document);
  return { files, uri, document, persisted, saveCalls: () => saveCalls };
}

suite('Note filesystem encoding API compatibility', () => {
  test('API 1.76 preserves Korean CRLF through a configured euckr save snapshot', async () => {
    const text = '# 한글 회의\r\n정리.메모\r\n';
    const fixture = await createFixture('euckr', text);
    try {
      assert.strictEqual('encoding' in fixture.document, false);
      fixture.files.prepareSave(fixture.document as vscode.TextDocument);
      await fixture.files.writeFile(fixture.uri, iconv.encode(text, 'euckr'), { create: false, overwrite: true });
      assert.strictEqual(fixture.persisted.text, text);
      assert.strictEqual(fixture.saveCalls(), 1);
      const bytes = fixture.files.readFile(fixture.uri);
      assert.strictEqual(fixture.files.stat(fixture.uri).size, bytes.byteLength);
      assert.strictEqual(iconv.decode(Buffer.from(bytes), 'utf8'), text);
    } finally {
      fixture.files.dispose();
    }
  });

  test('API 1.76 rejects unidentified non-UTF8 bytes without persisting or emitting a change', async () => {
    const text = '한글 미식별 저장\r\n원문 보존';
    const fixture = await createFixture('utf8', text);
    const original = fixture.persisted.text;
    let changes = 0;
    const subscription = fixture.files.onDidChangeFile(() => { changes++; });
    try {
      const before = fixture.files.stat(fixture.uri).mtime;
      fixture.files.prepareSave(fixture.document as vscode.TextDocument);
      await assert.rejects(
        fixture.files.writeFile(fixture.uri, iconv.encode(text, 'euckr'), { create: false, overwrite: true }),
        error => error instanceof vscode.FileSystemError && error.code === 'Unavailable',
      );
      assert.strictEqual(fixture.persisted.text, original);
      assert.strictEqual(fixture.saveCalls(), 0);
      assert.strictEqual(fixture.files.stat(fixture.uri).mtime, before);
      assert.strictEqual(changes, 0);
    } finally {
      subscription.dispose();
      fixture.files.dispose();
    }
  });

  test('Modern document encoding works without save events and preserves different external UTF8 writes', async () => {
    const text = '# 현대 API 한글\r\n저장 이벤트 없음';
    const fixture = await createFixture('utf8', text, 'euckr');
    try {
      await fixture.files.writeFile(fixture.uri, iconv.encode(text, 'euckr'), { create: false, overwrite: true });
      assert.strictEqual(fixture.persisted.text, text);
      const external = '# 외부 변경된 내용\r\n기존 편집기 본문과 다름';
      await fixture.files.writeFile(fixture.uri, Buffer.from(external, 'utf8'), { create: false, overwrite: true });
      assert.strictEqual(fixture.persisted.text, external);
      assert.notStrictEqual(fixture.persisted.text, fixture.document.getText());
      assert.strictEqual(fixture.saveCalls(), 2);
    } finally {
      fixture.files.dispose();
    }
  });
});
