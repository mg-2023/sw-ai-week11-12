# mini-react를 전용 창으로 열고, 타이머가 끝났다는 요청을 받아 Windows 알림과 작업표시줄 깜빡임을 띄웁니다.
# 웹페이지는 PC 기능을 직접 부를 수 없어서, 이 스크립트가 중간 다리 역할을 합니다.
# 이 PC 안(127.0.0.1)의 요청만 받습니다. 이 창을 끄면 전용 창도 함께 닫힙니다.
$ErrorActionPreference = 'Stop'

$Port = 47631
$FlashCount = 3
$MaxBodyLength = 2000
$MaxTextLength = 60
$PagePath = Join-Path $PSScriptRoot 'mini-react.html'

# 전용 창은 Chrome을 먼저 찾고, 없으면 Edge를 씁니다.
$BrowserPaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)

# 알림 발신자 이름과 아이콘입니다. HKCU\Software\Classes\AppUserModelId\mini-react.Notify에 등록해 두었고,
# 등록 값 DisplayName = mini-react, IconUri = notify-icon.png (보라 번개, public/favicon.svg에서 만든 PNG)입니다.
$AppId = 'mini-react.Notify'
$IconUri = ([System.Uri](Join-Path $PSScriptRoot 'notify-icon.png')).AbsoluteUri

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class PageWindow {
  private const string BrowserClass = "Chrome_WidgetWin_1";
  private const string TitleMark = "mini-react";
  private const uint WM_CLOSE = 0x0010;
  private const uint FLASHW_ALL = 3;

  [StructLayout(LayoutKind.Sequential)]
  private struct FLASHWINFO {
    public uint cbSize;
    public IntPtr hwnd;
    public uint dwFlags;
    public uint uCount;
    public uint dwTimeout;
  }

  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  private delegate bool ConsoleHandler(uint signal);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool FlashWindowEx(ref FLASHWINFO info);
  [DllImport("kernel32.dll")] private static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, bool add);

  // 운영체제가 부를 함수라서 사라지지 않게 붙들어 둡니다.
  private static ConsoleHandler closeHandler;

  // 전용 창의 제목은 "... | mini-react"로 끝납니다. 일반 탭은 뒤에 " - Chrome"이 붙어서 걸리지 않습니다.
  private static List<IntPtr> FindDedicatedWindows() {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
      if (!IsWindowVisible(hwnd)) return true;

      StringBuilder className = new StringBuilder(64);
      GetClassName(hwnd, className, className.Capacity);
      if (className.ToString() != BrowserClass) return true;

      StringBuilder title = new StringBuilder(256);
      GetWindowText(hwnd, title, title.Capacity);
      if (title.ToString().EndsWith(TitleMark, StringComparison.Ordinal)) found.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static int Count() {
    return FindDedicatedWindows().Count;
  }

  public static void Flash(uint count) {
    foreach (IntPtr hwnd in FindDedicatedWindows()) {
      FLASHWINFO info = new FLASHWINFO();
      info.cbSize = (uint)Marshal.SizeOf(info);
      info.hwnd = hwnd;
      info.dwFlags = FLASHW_ALL;
      info.uCount = count;
      FlashWindowEx(ref info);
    }
  }

  public static void Close() {
    foreach (IntPtr hwnd in FindDedicatedWindows()) {
      PostMessage(hwnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }
  }

  // Ctrl+C를 눌러도, 이 창의 X를 눌러도 전용 창을 함께 닫습니다.
  public static void CloseWithConsole() {
    closeHandler = delegate (uint signal) {
      Close();
      return false;
    };
    SetConsoleCtrlHandler(closeHandler, true);
  }
}
'@

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

# 알림 XML에 그대로 들어가므로 길이를 자르고 특수 문자를 바꿉니다.
function Get-SafeText($value) {
  $text = [string]$value
  if ($text.Length -gt $MaxTextLength) {
    # 이모지는 두 칸을 써서, 반만 남기면 알림 XML이 깨집니다. 그때는 이모지 앞에서 자릅니다.
    $cut = $MaxTextLength
    if ([char]::IsHighSurrogate($text[$cut - 1])) { $cut-- }
    $text = $text.Substring(0, $cut)
  }
  return [System.Security.SecurityElement]::Escape($text)
}

function Show-Toast($title, $message) {
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><image placement='appLogoOverride' src='$IconUri'/><text>$title</text><text>$message</text></binding></visual></toast>")
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
}

# 파일로 연 페이지는 Origin이 null이고, 개발 서버는 localhost입니다. 다른 사이트의 요청은 받지 않습니다.
function Test-AllowedOrigin($origin) {
  return $origin -eq 'null' -or $origin -match '^http://(localhost|127\.0\.0\.1)(:\d+)?$'
}

function Send-Status($context, $status) {
  $context.Response.StatusCode = $status
  $context.Response.Close()
}

function Receive-Notification($context) {
  $request = $context.Request

  if ($request.HttpMethod -ne 'POST' -or $request.Url.AbsolutePath -ne '/notify') {
    Send-Status $context 404
    return
  }
  if (-not (Test-AllowedOrigin $request.Headers['Origin']) -or $request.ContentLength64 -gt $MaxBodyLength) {
    Send-Status $context 403
    return
  }

  $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
  $body = $reader.ReadToEnd() | ConvertFrom-Json

  Show-Toast (Get-SafeText $body.title) (Get-SafeText $body.message)
  [PageWindow]::Flash($FlashCount)
  Send-Status $context 204
}

# 전용 창은 주소창 없이 페이지 하나만 담아서, 닫아도 다른 탭에 영향이 없습니다.
function Open-PageWindow {
  $browser = $BrowserPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $browser) {
    Write-Host 'Chrome이나 Edge를 찾지 못해 기본 브라우저로 엽니다. 이 경우 페이지는 직접 닫아야 합니다.'
    Start-Process $PagePath
    return
  }
  Start-Process $browser "--app=$(([Uri]$PagePath).AbsoluteUri)"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
  $listener.Start()
} catch {
  # 창이 바로 닫히면 이유를 볼 수 없어서 멈춰 둡니다.
  Write-Host "알림 프로그램을 켜지 못했습니다. 이미 켜져 있는지 확인하세요: $($_.Exception.Message)"
  Read-Host '닫으려면 Enter를 누르세요'
  exit 1
}

[PageWindow]::CloseWithConsole()
Open-PageWindow
Write-Host 'mini-react 알림을 켰습니다. 끝내려면 이 창에서 Ctrl+C를 누르세요. 페이지도 함께 닫힙니다.'

try {
  while ($listener.IsListening) {
    $pending = $listener.GetContextAsync()

    # 기다리는 동안에도 Ctrl+C가 먹도록 짧게 나눠서 기다립니다.
    while (-not $pending.AsyncWaitHandle.WaitOne(200)) { }

    $context = $pending.GetAwaiter().GetResult()
    try {
      Receive-Notification $context
    } catch {
      Write-Host "알림을 띄우지 못했습니다: $($_.Exception.Message)"
      Send-Status $context 500
    }
  }
} finally {
  $listener.Close()
}
