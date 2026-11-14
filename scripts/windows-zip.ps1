param(
    [Parameter(Mandatory = $true)][string]$SourcePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = Get-Item -LiteralPath $SourcePath -Force
if (-not $source.PSIsContainer) { throw 'ZIP source must be a directory.' }
if (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ZIP source must not be a link.' }
$destination = [IO.Path]::GetFullPath($DestinationPath)
$prefix = $source.FullName.TrimEnd('\') + '\'
if ($destination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP output must be outside the source tree.' }
if (Test-Path -LiteralPath $destination) { throw 'ZIP output already exists; refusing to overwrite it.' }
foreach ($item in Get-ChildItem -LiteralPath $source.FullName -Force -Recurse) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ZIP source contains a link.' }
}
[IO.Compression.ZipFile]::CreateFromDirectory($source.FullName, $destination, [IO.Compression.CompressionLevel]::Optimal, $false)
$shell = New-Object -ComObject Shell.Application
$folder = $shell.NameSpace($destination)
if ($null -eq $folder -or $folder.Items().Count -eq 0) { throw 'Windows compressed folders cannot enumerate this ZIP.' }
@{ windowsShellTopLevelEntries = $folder.Items().Count } | ConvertTo-Json -Compress
