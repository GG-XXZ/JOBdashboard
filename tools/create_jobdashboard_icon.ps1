param([string]$OutputPath = (Join-Path $PSScriptRoot '..\JOBdashboard.ico'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(19, 37, 63))
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(42, 190, 170))
$graphics.FillRectangle($brush, 36, 48, 184, 160)
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font('Segoe UI', 92, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString('J', $font, $white, 88, 44)
$graphics.Dispose()
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Icon)
$bitmap.Dispose()
Write-Host "已生成：$OutputPath"
