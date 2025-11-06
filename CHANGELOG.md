# Change Log

All notable changes to the "cursor-notepads" extension will be documented in this file.

## [0.2.0] - 2024-11-06

### Added
- **Full edit support**: Create, edit, rename, and delete notepads
- **Drag & Drop reordering**: Reorder notes by dragging them to new positions
- **Automatic migration**: Seamlessly migrates existing notepads from Cursor's database to `notepads.json`
- **JSON array storage**: Simplified array-based storage format (auto-migrates from old object format)
- **New note creation**: "+" button in the Notepads view toolbar
- **Refresh button**: Manually refresh the notepad list
- **Context menu**: Right-click on notepads to rename or delete
- **Save confirmation**: Shows a message when a notepad is saved

### Changed
- **Storage location**: Now saves to `%APPDATA%\Cursor\User\workspaceStorage\{workspace-id}\notepads.json` instead of workspace folder
- **JSON structure**: Changed from nested object `{"notepads": {...}}` to simple array `[...]`
- **Minimum version**: Requires VSCode/Cursor 1.76.0+ for drag & drop support
- Notepads are now editable instead of read-only
- Database is only read once during initial migration
- After migration, all data is managed in `notepads.json`

### Fixed
- Improved error handling for workspaces without folders

## [0.1.1] - Previous

- Bug fixes and improvements

## [0.1.0] - Initial Release

- Read-only access to Cursor Notepads
- Explorer sidebar integration
- Markdown preview support