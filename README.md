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
1. The extension checks if `notepads.json` exists in your workspace folder
2. If not found, reads Cursor's internal `state.vscdb` database
3. Extracts notepad data and saves it to `notepads.json`
4. Shows a confirmation message when migration is complete

### After Migration
1. All notepad data is read from `notepads.json`
2. Click a notepad to open and edit it
3. Changes are saved back to `notepads.json`
4. Use toolbar buttons to create new notes or refresh the list

**Database Storage Locations (for migration only):**
- Windows: `%APPDATA%\Cursor\User\workspaceStorage\{workspace-id}\`
- macOS: `~/Library/Application Support/Cursor/User/workspaceStorage/{workspace-id}/`
- Linux: `~/.config/Cursor/User/workspaceStorage/{workspace-id}/`

**Notepad File Location:**
- `%APPDATA%\Cursor\User\workspaceStorage\{workspace-id}\notepads.json` (Windows)
- `~/Library/Application Support/Cursor/User/workspaceStorage/{workspace-id}/notepads.json` (macOS)
- `~/.config/Cursor/User/workspaceStorage/{workspace-id}/notepads.json` (Linux)

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
1. Click the "+" button in the Notepads view
2. Enter a name for your note
3. The note will be created and you can start editing

### Editing a Note
1. Click on any notepad in the list
2. Edit the content in the opened editor
3. Save the file (`Ctrl+S` or `Cmd+S`)
4. A confirmation message will appear

### Renaming a Note
1. Right-click on a notepad
2. Select "Rename"
3. Enter the new name

### Deleting a Note
1. Right-click on a notepad
2. Select "Delete"
3. Confirm the deletion

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
- Create a new note using the "+" button
- Enable debug logs to see detailed information

**Migration didn't work:**
- Ensure the workspace was used in Cursor before and had notepads
- Check debug logs for migration messages
- You can still create new notes even if migration fails

**Troubleshooting tips:**
1. Open Output panel: `Ctrl+Shift+U` (Windows/Linux) or `Cmd+Shift+U` (Mac)
2. Select "Cursor Notepads" from the dropdown to view logs
3. Look for `[storageUri] ✓ found workspace id` to confirm successful detection
4. Enable `cursorNotepads.verbose` if you want to see all action notifications

## 📝 License

MIT License - See [LICENSE.md](LICENSE.md) for details

## 🔗 Links

- **Repository**: https://github.com/LCH-1/cursor-notepads
- **Issues**: https://github.com/LCH-1/cursor-notepads/issues
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)

## 🙏 Acknowledgments

This extension was created to preserve access to Cursor's deprecated notepad feature.
