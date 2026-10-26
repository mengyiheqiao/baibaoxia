# Baibaoxia - screenshot OCR using the OCR engine built into Windows 10/11.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File ocr.ps1 -Mode snip  -Out C:\path\shot.png
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File ocr.ps1 -Mode image -Image C:\path\shot.png
# Prints one line of JSON: {"ok":true,"text":"..."} or {"ok":false,"code":"..."}
param(
  [string]$Mode = 'snip',
  [string]$Out = '',
  [string]$Image = '',
  [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Finish($obj) {
  $obj | ConvertTo-Json -Compress
  exit 0
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  if ($Mode -eq 'snip') {
    # Clear clipboard, open the Windows snipping overlay, wait for an image
    [System.Windows.Forms.Clipboard]::Clear()
    Start-Process 'ms-screenclip:'
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $img = $null
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $img = [System.Windows.Forms.Clipboard]::GetImage()
        break
      }
    }
    if ($null -eq $img) { Finish @{ ok = $false; code = 'NO_SNIP' } }
    $img.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    $Image = $Out
  }

  if (-not (Test-Path -LiteralPath $Image)) { Finish @{ ok = $false; code = 'NO_IMAGE' } }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

  $full = (Resolve-Path -LiteralPath $Image).Path
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  # Prefer Simplified Chinese (it also reads English); otherwise the user's languages
  $engine = $null
  $zh = New-Object Windows.Globalization.Language 'zh-Hans-CN'
  if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($zh)) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zh)
  }
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { Finish @{ ok = $false; code = 'NO_ENGINE' } }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()

  # Windows puts spaces between Chinese characters; remove them
  $cjk = '[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]'
  $lines = @()
  foreach ($line in $result.Lines) {
    $t = $line.Text
    $t = [regex]::Replace($t, "(?<=$cjk) +(?=$cjk)", '')
    $lines += $t
  }
  $text = ($lines -join "`r`n").Trim()

  if ($text.Length -gt 0) { Set-Clipboard -Value $text }
  Finish @{ ok = $true; text = $text; zh = ($engine.RecognizerLanguage.LanguageTag) }
}
catch {
  Finish @{ ok = $false; code = 'ERROR'; detail = $_.Exception.Message }
}
