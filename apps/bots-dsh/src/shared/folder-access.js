// One note in the folder picker and in the Bot's context; paths are always quoted.
export const FOLDER_ACCESS_NOTE = 'The operating system blocked read or write access to {folder}. Allow Automagik to use this folder: on macOS, open System Settings > Privacy & Security > Files and Folders (or Full Disk Access); elsewhere, allow your user to read and write the folder. Your folder choice has been kept.'
export const folderAccessNote = folder => FOLDER_ACCESS_NOTE.replace('{folder}', JSON.stringify(folder))
