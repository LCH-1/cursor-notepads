# Cursor Notepads

View your deprecated Cursor Notepads directly in the Explorer sidebar. This extension provides read-only access to your workspace notepads stored in Cursor's internal database.

![Cursor Notepads](cursor-notepad.png)

## ✨ Features

- **Explorer Integration**: Adds a "Notepads" section to the Explorer sidebar
- **Read-Only Access**: Safely reads your notepads without modifying any data
- **Markdown Preview**: Click any notepad to view it as a Markdown document
- **Fast & Efficient**: Uses VS Code's storage API to directly locate workspace data (O(1) lookup)
- **Privacy-First**: All data stays local - no network access, no telemetry

## 🚀 How It Works

1. The extension uses `ExtensionContext.storageUri` to locate the current workspace's storage directory
2. Reads the workspace's `state.vscdb` (or `state.vscdb.backup`) database
3. Extracts notepad data from the `notepadData` key
4. Displays all notepads in the Explorer sidebar
5. Clicking a notepad opens it as a read-only Markdown document

**Storage Locations:**
- Windows: `%APPDATA%\Cursor\User\workspaceStorage\{workspace-id}\`
- macOS: `~/Library/Application Support/Cursor/User/workspaceStorage/{workspace-id}/`
- Linux: `~/.config/Cursor/User/workspaceStorage/{workspace-id}/`

## 📋 Requirements

- Cursor or VS Code 1.75.0 or higher
- A workspace folder must be open
- The extension works completely offline

## ⚙️ Settings

- `cursorNotepads.debugLogs`: Enable debug logs in the Output panel (default: `false`)

To enable debug logs:
```json
{
  "cursorNotepads.debugLogs": true
}
```

Then view logs in **Output** → **Cursor Notepads**

## 🔒 Privacy & Security

- ✅ Reads local files only
- ✅ Never modifies your database
- ✅ No network requests
- ✅ No telemetry or data collection
- ✅ Open source - inspect the code yourself!

## ⚠️ Limitations

- **Read-only**: This version does not support editing or creating notepads
- **Workspace-specific**: Only shows notepads for the currently open workspace
- **Schema dependent**: Relies on Cursor's internal storage format which may change

## 🐛 Troubleshooting

**No "Notepads" section visible:**
- Ensure a workspace folder is open (not just a single file)
- Check if the extension is activated in the Extensions panel

**Empty notepad list:**
- Your workspace may not have any notepads stored
- Try opening a different workspace that you know has notepads
- Enable debug logs to see detailed information

**Debug mode:**
1. Enable `cursorNotepads.debugLogs` in settings
2. Open Output panel: `Ctrl+Shift+U` (Windows/Linux) or `Cmd+Shift+U` (Mac)
3. Select "Cursor Notepads" from the dropdown
4. Look for `[storageUri] ✓ found workspace id` to confirm successful detection

## 📝 License

MIT License - See [LICENSE.md](LICENSE.md) for details

## 🔗 Links

- **Repository**: https://github.com/LCH-1/cursor-notepads
- **Issues**: https://github.com/LCH-1/cursor-notepads/issues
- **Changelog**: [CHANGELOG.md](CHANGELOG.md)

## 🙏 Acknowledgments

This extension was created to preserve access to Cursor's deprecated notepad feature.
