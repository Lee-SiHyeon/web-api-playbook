[CmdletBinding()]
param([int]$WaitSeconds = 8)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
if (-not ('CoupangWindow' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CoupangWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint nInputs, INPUT[] inputs, int cbSize);
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
    public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
  }
  const uint INPUT_KEYBOARD = 1;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  static void SendKey(ushort key, uint flags) {
    var input = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = key, wScan = 0, dwFlags = flags } } };
    SendInput(1, new [] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Chord(ushort modifier, ushort key) {
    SendKey(modifier, 0); SendKey(key, 0); SendKey(key, KEYEVENTF_KEYUP); SendKey(modifier, KEYEVENTF_KEYUP);
  }
  public static void Press(ushort key) { SendKey(key, 0); SendKey(key, KEYEVENTF_KEYUP); }
  public static void Text(string value) {
    foreach (char c in value) {
      var down = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE } } };
      var up = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } };
      SendInput(2, new [] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
"@
}

$chrome = Get-Process chrome -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*Coupang Partners*' } |
  Sort-Object StartTime |
  Select-Object -First 1
if (-not $chrome) { throw 'Logged-in Coupang Partners Chrome window not found.' }

$probePath = Join-Path $PSScriptRoot 'coupang-page-probe.js'
$probe = (Get-Content -LiteralPath $probePath -Raw) -replace "`r?`n", ' '
$previousClipboard = $null
try { $previousClipboard = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}

$before = Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" -Filter 'coupang-partners-page-*.json' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
$beforeTime = if ($before) { $before.LastWriteTimeUtc } else { [datetime]::MinValue }

try {
  [CoupangWindow]::ShowWindow($chrome.MainWindowHandle, 9) | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shell.SendKeys('%')
  [CoupangWindow]::SetForegroundWindow($chrome.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 700
  Set-Clipboard -Value $probe
  [CoupangWindow]::Chord(0x11, 0x4C)
  Start-Sleep -Milliseconds 250
  [CoupangWindow]::Text('javascript:')
  [CoupangWindow]::Chord(0x11, 0x56)
  Start-Sleep -Milliseconds 150
  [CoupangWindow]::Press(0x0D)
  Start-Sleep -Seconds $WaitSeconds
} finally {
  if ($null -ne $previousClipboard) { Set-Clipboard -Value $previousClipboard }
}

$latest = Get-ChildItem -LiteralPath "$env:USERPROFILE\Downloads" -Filter 'coupang-partners-page-*.json' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $latest -or $latest.LastWriteTimeUtc -le $beforeTime) {
  throw "Probe download was not created. Current Chrome title: $((Get-Process -Id $chrome.Id -ErrorAction SilentlyContinue).MainWindowTitle)"
}

[pscustomobject]@{
  File = $latest.FullName
  Bytes = $latest.Length
  LastWriteTime = $latest.LastWriteTime
  ChromePid = $chrome.Id
  Title = $chrome.MainWindowTitle
} | Format-List
