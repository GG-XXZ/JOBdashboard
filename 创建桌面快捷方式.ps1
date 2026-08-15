$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $PSScriptRoot).Path
$target = Join-Path $root '启动 JOBdashboard.bat'
$icon = Join-Path $root 'JOBdashboard.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'JOBdashboard.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$icon,0"
$shortcut.Description = '启动 JOBdashboard 本地求职看板'
$shortcut.Save()
Write-Host "已创建：$shortcutPath"
