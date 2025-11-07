# Cursor Notepads

View and edit your deprecated Cursor Notepads directly in the Explorer sidebar. This extension migrates your workspace notepads from Cursor's internal database to an editable JSON file.

![Cursor Notepads](cursor-notepad.png)

## ✨ Features

- **Explorer Integration**: Adds a "Notepads" section to the Explorer sidebar
- **Full Edit Support**: Create, edit, rename, and delete notepads
- **Drag & Drop Reordering**: Easily reorder notes by dragging them to new positions
- **Automatic Migration**: Seamlessly migrates existing notepads from Cursor's database
- **Markdown Editing**: Edit notepads as Markdown documents
- **JSON Array Storage**: Clean, simple array-based storage format
- **Fast & Efficient**: Uses VS Code's storage API to directly locate workspace data (O(1) lookup)
- **Privacy-First**: All data stays local - no network access, no telemetry

## 🚀 How It Works

### First Time (Migration)
1. The extension checks if `notepads.json` exists in the workspace storage directory
2. If not found, reads Cursor's internal `state.vscdb` database
3. Extracts notepad data and saves it to `notepads.json`
4. Shows a confirmation message when migration is complete

### After Migration
1. All notepad data is read from `notepads.json` in the workspace storage
2. Click a notepad to open and edit it as a `.np` file (Markdown format)
3. Changes are automatically saved back to `notepads.json`
4. Use toolbar buttons to create new notes or refresh the list

**Database Storage Locations (for migration only):**
- Windows: `%APPDATA%\Cursor\User\workspaceStorage\{workspace-id}\`
- macOS: `~/Library/Application Support/Cursor/User/workspaceStorage/{workspace-id}/`
- Linux: `~/.config/Cursor/User/workspaceStorage/{workspace-id}/`

**Notepad File Location:**
- Windows: `%APPDATA%\Cursor\User\workspaceStorage\{workspace-id}\notepads.json`
- macOS: `~/Library/Application Support/Cursor/User/workspaceStorage/{workspace-id}/notepads.json`
- Linux: `~/.config/Cursor/User/workspaceStorage/{workspace-id}/notepads.json`

**JSON File Structure:**
```json
[
  {
    "id": "unique-id-1",
    "name": "My First Note",
    "text": "Note content here..."
  },
  {
    "id": "unique-id-2", 
    "name": "Another Note",
    "text": "More content..."
  }
]
```

## 📋 Requirements

- Cursor or VS Code 1.76.0 or higher (for drag & drop support)
- A workspace folder must be open
- The extension works completely offline

## ⚙️ Settings

- `cursorNotepads.verbose`: Show verbose notifications for all actions (default: `false`)

To enable verbose notifications:
```json
{
  "cursorNotepads.verbose": true
}
```

When enabled, you'll see notifications for:
- Note created
- Note saved
- Note deleted
- Note renamed

**Note**: Error messages are always shown regardless of this setting.

## 📝 Usage

### Creating a New Note
1. Click the "+" button in the Notepads view toolbar
2. Enter a name for your note (defaults to "New Notepad")
3. The note will be created and appears in the list

### Editing a Note
1. Click on any notepad in the list to open it
2. Edit the content in the opened editor (`.np` file with Markdown syntax highlighting)
3. Save the file with `Ctrl+S` (Windows/Linux) or `Cmd+S` (macOS)
4. Changes are automatically saved to `notepads.json` (verbose notifications can be enabled in settings)

### Renaming a Note
1. Click the ✏️ (edit) icon next to any notepad
2. Enter the new name in the input box
3. Press Enter or click OK

### Deleting a Note
1. Click the 🗑️ (trash) icon next to any notepad
2. Confirm the deletion in the modal dialog

### Reordering Notes (Drag & Drop)
1. Click and hold on any notepad item
2. Drag it to the desired position
3. Drop it before another note or at the end of the list
4. Order is automatically saved to the JSON file

## 🔒 Privacy & Security

- ✅ Reads local files only
- ✅ Never modifies Cursor's internal database (only reads during migration)
- ✅ No network requests
- ✅ No telemetry or data collection
- ✅ Open source - inspect the code yourself!

## ⚠️ Limitations

- **Workspace-specific**: Only shows notepads for the currently open workspace
- **Single workspace**: Uses the first workspace folder if multiple are open
- **One-time migration**: Database is only read once when `notepads.json` doesn't exist

## 🐛 Troubleshooting

**No "Notepads" section visible:**
- Ensure a workspace folder is open (not just a single file)
- Check if the extension is activated in the Extensions panel

**Empty notepad list:**
- Your workspace may not have any notepads stored in Cursor's database
- Create a new note using the "+" button in the toolbar
- Check the Output panel (see Troubleshooting tips below) for detailed information

**Migration didn't work:**
- Ensure the workspace was used in Cursor before and had notepads
- Check the Output panel for migration messages
- You can still create new notes even if migration fails

**Troubleshooting tips:**
1. Open Output panel: `Ctrl+Shift+U` (Windows/Linux) or `Cmd+Shift+U` (Mac)
2. Select "Cursor Notepads" from the dropdown to view logs
3. Look for `[storageUri] ✓ found workspace id` to confirm successful detection
4. Enable `cursorNotepads.verbose` if you want to see all action notifications

## 📝 License

MIT License - See [LICENSE.md](LICENSE.md) for details

## 💡 Technical Details

- **File Format**: Notepads are saved as `.np` files (Notepad format)
- **Syntax Highlighting**: `.np` files use Markdown syntax highlighting
- **Storage Location**: Files are stored in VSCode's workspace storage directory
- **Icon**: Notepads display with a 📝 notepad icon in the Explorer sidebar

## 🔗 Links

- **Repository**: https://github.com/LCH-1/cursor-notepads
- **Issues**: https://github.com/LCH-1/cursor-notepads/issues
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)

## 🙏 Acknowledgments

This extension was created to preserve access to Cursor's deprecated notepad feature.
