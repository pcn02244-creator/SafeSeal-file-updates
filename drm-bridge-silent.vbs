Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\drm-bridge.js""", 0, False
