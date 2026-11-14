'use strict';
// Reads and drives the ChatGPT desktop window through Windows UI Automation
// (the accessibility tree), so the macro can SEE what it is doing instead of
// typing blind: which tab is on (Chat / Work), where the message box is and
// whether "Enviar" is enabled. Found by name and control type, never by screen
// position. Runs a short PowerShell script per call (~0.5 s).
const { execFile } = require('child_process');
const log = require('./log');

// Chromium only builds its accessibility tree once a client asks, so the first
// look may find just the window buttons: look again a few times.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]::Descendants
$out = @{ ok = $false; tree = 0; chat = $null; work = $null; switched = $false; input = $false; send = $null }
try {
  $root = $A::FromHandle([IntPtr][Int64]$env:CW_HWND)
  $all = $null
  for ($i = 0; $i -lt 6; $i++) {
    $all = $root.FindAll($T, [System.Windows.Automation.Condition]::TrueCondition)
    if ($all.Count -gt 40) { break }
    Start-Sleep -Milliseconds 600
  }
  $out.tree = $all.Count
  $chat = $null; $work = $null; $edit = $null; $send = $null
  foreach ($e in $all) {
    $c = $e.Current
    $ct = $c.ControlType.ProgrammaticName
    if ($ct -eq 'ControlType.Button') {
      if ($c.Name -eq 'Chat' -and -not $chat) { $chat = $e }
      elseif ($c.Name -eq 'Work' -and -not $work) { $work = $e }
      elseif ($c.Name -match '^(Enviar|Send)( |$)' -and -not $send) { $send = $e }
    } elseif ($ct -eq 'ControlType.Edit' -and -not $edit -and -not $c.IsOffscreen) { $edit = $e }
  }
  function State($el) {
    $p = $null
    if ($el -and $el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { return [string]$p.Current.ToggleState }
    return $null
  }
  $out.chat = State $chat; $out.work = State $work
  if ($env:CW_ACTION -eq 'chat' -and $chat -and $out.chat -ne 'On') {
    $p = $null
    if ($chat.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle() }
    elseif ($chat.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
    Start-Sleep -Milliseconds 700
    $out.chat = State $chat; $out.work = State $work
    $out.switched = ($out.chat -eq 'On')
  }
  if ($env:CW_ACTION -eq 'focus' -and $edit) { $edit.SetFocus(); $out.input = $true }
  elseif ($edit) { $out.input = $true }
  if ($send) { $out.send = [bool]$send.Current.IsEnabled }
  if ($env:CW_ACTION -eq 'send' -and $send -and $send.Current.IsEnabled) {
    $p = $null
    if ($send.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); $out.sent = $true }
  }
  $out.ok = $true
} catch { $out.error = $_.Exception.Message }
$out | ConvertTo-Json -Compress
`;
const ENCODED = Buffer.from(SCRIPT, 'utf16le').toString('base64');

/**
 * action: 'look' (just read), 'chat' (switch to the Chat tab if it is not on),
 * 'focus' (put the cursor in the message box), 'send' (press Enviar).
 * Resolves { ok, tree, chat: 'On'|'Off'|null, work, switched, input, send: bool|null }.
 * `chat === null` means this ChatGPT has no Chat tab to be found.
 */
function chatgptUi(hwnd, action = 'look') {
  if (process.platform !== 'win32' || !hwnd) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED], {
      windowsHide: true, timeout: 15000, env: Object.assign({}, process.env, { CW_HWND: String(hwnd), CW_ACTION: action }),
    }, (err, out) => {
      const line = String(out || '').trim().split(/\r?\n/).pop() || '';
      try { resolve(JSON.parse(line)); } catch (_) {
        log.warn('uia: sem resposta', action, err ? err.message : line.slice(0, 120));
        resolve({ ok: false });
      }
    });
  });
}

module.exports = { chatgptUi };
