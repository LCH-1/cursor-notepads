import * as vscode from 'vscode';

export type ManagedNote = { id: string; name: string; text: string };

export const NOTE_SCHEME = 'cnp-notepad';
export const NOTE_ICON_PARENT = 'lch-cursor-notepads-editor-7f4e19';

type NoteTimes = { ctime: number; mtime: number };

export class NoteFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  private readonly times = new Map<string, NoteTimes>();
  private readonly knownNoteIds = new Set<string>();
  private readonly createdAt = Date.now();

  constructor(
    private readonly workspaceId: string,
    private readonly getNote: (id: string) => ManagedNote | undefined,
    private readonly saveNote: (id: string, text: string) => Promise<boolean>,
  ) {}

  uriForNote(noteId: string): vscode.Uri {
    this.knownNoteIds.add(noteId);
    return vscode.Uri.from({
      scheme: NOTE_SCHEME,
      path: `/${this.workspaceId}/${encodeURIComponent(noteId)}/${NOTE_ICON_PARENT}/note`,
    });
  }

  noteIdForUri(uri: vscode.Uri): string | undefined {
    const parts = this.pathParts(uri);
    if (!parts || parts.length !== 4 || parts[2] !== NOTE_ICON_PARENT || parts[3] !== 'note') {
      return undefined;
    }
    return this.decodeNoteId(parts[1]);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const parts = this.existingParts(uri);
    if (parts.length < 4) {
      return { type: vscode.FileType.Directory, ctime: this.createdAt, mtime: this.createdAt, size: 0 };
    }

    const note = this.fileNote(uri);
    const times = this.noteTimes(note.id);
    return { type: vscode.FileType.File, ...times, size: Buffer.byteLength(note.text, 'utf8') };
  }

  readFile(uri: vscode.Uri): Uint8Array {
    return Buffer.from(this.fileNote(uri).text, 'utf8');
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean },
  ): Promise<void> {
    const note = this.fileNote(uri);
    if (options.create && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    let saved: boolean;
    try {
      saved = await this.saveNote(note.id, Buffer.from(content).toString('utf8'));
    } catch {
      throw vscode.FileSystemError.Unavailable(uri);
    }
    if (!saved) {
      throw vscode.FileSystemError.Unavailable(uri);
    }
    this.notifyChanged(note.id);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const parts = this.existingParts(uri);
    if (parts.length === 0) {
      return [[this.workspaceId, vscode.FileType.Directory]];
    }
    if (parts.length === 1) {
      return [...this.knownNoteIds]
        .filter(id => this.getNote(id))
        .map(id => [encodeURIComponent(id), vscode.FileType.Directory]);
    }
    if (parts.length === 2) {
      return [[NOTE_ICON_PARENT, vscode.FileType.Directory]];
    }
    if (parts.length === 3) {
      return [['note', vscode.FileType.File]];
    }
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  notifyChanged(noteId: string): void {
    const uri = this.uriForNote(noteId);
    if (!this.getNote(noteId)) {
      this.knownNoteIds.delete(noteId);
      this.times.delete(noteId);
      this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      return;
    }

    const times = this.noteTimes(noteId);
    times.mtime = Math.max(Date.now(), times.mtime + 1);
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  dispose(): void {
    this.changes.dispose();
    this.times.clear();
    this.knownNoteIds.clear();
  }

  private fileNote(uri: vscode.Uri): ManagedNote {
    const noteId = this.noteIdForUri(uri);
    if (noteId === undefined) {
      if (this.existingParts(uri).length < 4) {
        throw vscode.FileSystemError.FileIsADirectory(uri);
      }
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const note = this.getNote(noteId);
    if (!note) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.knownNoteIds.add(noteId);
    return note;
  }

  private existingParts(uri: vscode.Uri): string[] {
    const parts = this.pathParts(uri);
    if (!parts || parts.length > 4) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (parts.length >= 2) {
      const noteId = this.decodeNoteId(parts[1]);
      if (noteId === undefined || !this.getNote(noteId)) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      this.knownNoteIds.add(noteId);
    }
    if ((parts.length >= 3 && parts[2] !== NOTE_ICON_PARENT) || (parts.length === 4 && parts[3] !== 'note')) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return parts;
  }

  private pathParts(uri: vscode.Uri): string[] | undefined {
    if (uri.scheme !== NOTE_SCHEME || uri.authority || uri.query || uri.fragment || !uri.path.startsWith('/')) {
      return undefined;
    }
    if (uri.path === '/') {
      return [];
    }
    const parts = uri.path.slice(1).split('/');
    return parts[0] === this.workspaceId && parts.every(part => part.length > 0) ? parts : undefined;
  }

  private decodeNoteId(encodedId: string): string | undefined {
    try {
      const noteId = decodeURIComponent(encodedId);
      return noteId && encodeURIComponent(noteId) === encodedId ? noteId : undefined;
    } catch {
      return undefined;
    }
  }

  private noteTimes(noteId: string): NoteTimes {
    let times = this.times.get(noteId);
    if (!times) {
      const now = Date.now();
      times = { ctime: now, mtime: now };
      this.times.set(noteId, times);
    }
    return times;
  }
}
