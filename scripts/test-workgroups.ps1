# End-to-end workgroup regression test.
#
# Spins an isolated server on :8799 (does not touch a dev server on :8787),
# exercises every workgroup scenario (P1-P5 + multi-project + live WS + restart
# persistence), prints one PASS/FAIL line per check, then cleans up.
#
#   powershell -ExecutionPolicy Bypass -File scripts/test-workgroups.ps1
$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path $PSScriptRoot -Parent
$base = 'http://127.0.0.1:8799'
$script:pass = 0; $script:fail = 0; $ids = @()

function Check($name, $cond) {
  if ($cond) { $script:pass++; Write-Output ("PASS  " + $name) }
  else { $script:fail++; Write-Output ("FAIL  " + $name) }
}
function ApiGet($path) { return Invoke-RestMethod ($base + $path) }
function ApiPost($path, $obj) {
  return Invoke-RestMethod ($base + $path) -Method Post -ContentType 'application/json' -Body ($obj | ConvertTo-Json -Compress)
}
function Start-Sb {
  $env:PORT = '8799'; $env:HOST = '127.0.0.1'; $env:LOG_LEVEL = 'error'
  $node = (Get-Command node).Source
  $proc = Start-Process -FilePath $node -ArgumentList 'packages/server/dist/index.js' -WorkingDirectory $repo -PassThru -WindowStyle Hidden
  for ($i = 0; $i -lt 50; $i++) { Start-Sleep -Milliseconds 500; try { Invoke-RestMethod "$base/health" -TimeoutSec 2 | Out-Null; return $proc } catch {} }
  return $proc
}
function Stop-Sb($proc) {
  try { Stop-Process -Id $proc.Id -Force } catch {}
  Get-NetTCPConnection -LocalPort 8799 -State Listen | ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force } catch {} }
  Start-Sleep -Milliseconds 800
}
function WsRecv($ws, $ms) {
  $cts = New-Object System.Threading.CancellationTokenSource; $cts.CancelAfter($ms)
  $buf = New-Object byte[] 8192
  try { $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), $cts.Token).GetAwaiter().GetResult(); return [Text.Encoding]::UTF8.GetString($buf, 0, $r.Count) } catch { return $null }
}
function WsSend($ws, $text) {
  $b = [Text.Encoding]::UTF8.GetBytes($text)
  $ws.SendAsync([ArraySegment[byte]]::new($b), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
}

$root = Join-Path $env:TEMP ("sbtest-" + (Get-Random))
$projA = Join-Path $root 'projA'; $projB = Join-Path $root 'projB'
New-Item -ItemType Directory -Force -Path $projA, $projB | Out-Null

$proc = Start-Sb
Check "server up" ((ApiGet '/health').ok -eq $true)

# --- P1 scan ---
$scan = ApiGet '/api/scan'
Check "scan: >=1 available CLI" (@($scan | Where-Object { $_.status -eq 'available' }).Count -ge 1)
Check "scan: reports versions" (@($scan | Where-Object { $_.version }).Count -ge 1)

# --- P2 / multi-project: dedupe, isolation, cwd-exists, scaffold/injection ---
$wgA = ApiPost '/api/workgroups' @{ cwd = $projA }; $ids += $wgA.id
Check "create A: name=basename" ($wgA.name -eq 'projA')
$wgA2 = ApiPost '/api/workgroups' @{ cwd = $projA }
Check "dedupe same folder -> same id" ($wgA.id -eq $wgA2.id)
$wgB = ApiPost '/api/workgroups' @{ cwd = $projB }; $ids += $wgB.id
Check "second project -> different id" ($wgA.id -ne $wgB.id)
$rej = 0; try { ApiPost '/api/workgroups' @{ cwd = 'C:\__sb_nope_zzz__' } | Out-Null } catch { $rej = $_.Exception.Response.StatusCode.value__ }
Check "nonexistent cwd -> 400" ($rej -eq 400)
Check "A: .switchboard/context.md scaffolded" (Test-Path (Join-Path $projA '.switchboard\context.md'))
Check "A: AGENTS.md injected" ((Get-Content (Join-Path $projA 'AGENTS.md') -Raw) -match 'switchboard:workgroup')
Check "A: CLAUDE.md injected" ((Get-Content (Join-Path $projA 'CLAUDE.md') -Raw) -match 'switchboard:workgroup')

# --- P2 members + roles (Option B spawn) ---
$m1 = ApiPost "/api/workgroups/$($wgA.id)/members" @{ adapterId = 'passthrough' }
Check "addMember: spawned, role=active" ($m1.role -eq 'active')
Check "addMember: session in /sessions" ((ApiGet '/sessions' | Where-Object { $_.id -eq $m1.sessionId }).Count -eq 1)
$mRaw = ApiPost "/api/workgroups/$($wgA.id)/members" @{ command = 'node' }
Check "addMember raw: adapter-less command starts" (($mRaw.adapterId -eq 'node') -and ($mRaw.role -eq 'active'))
Check "addMember raw: session uses passthrough PTY" ((ApiGet '/sessions' | Where-Object { $_.id -eq $mRaw.sessionId }).adapterId -eq 'passthrough')
ApiPost "/api/workgroups/$($wgA.id)/members/$($m1.sessionId)/role" @{ role = 'idle' } | Out-Null
$fullA = ApiGet "/api/workgroups/$($wgA.id)"
Check "setRole -> idle" (($fullA.members | Where-Object { $_.sessionId -eq $m1.sessionId }).role -eq 'idle')

# --- P3 tasks + dispatch + peek + status ---
$t = ApiPost "/api/workgroups/$($wgA.id)/tasks" @{ title = 'T1'; description = 'do a thing' }
Check "task created: pending" ($t.status -eq 'pending')
$ta = ApiPost "/api/workgroups/$($wgA.id)/tasks/$($t.id)/assign" @{ sessionId = $m1.sessionId }
Check "assign -> running + assignee set" (($ta.status -eq 'running') -and ($ta.assignee -eq $m1.sessionId))
Start-Sleep -Milliseconds 700
Check "peek: returns output" ((ApiGet "/api/sessions/$($m1.sessionId)/peek?lines=15").text.Length -gt 0)
$td = ApiPost "/api/workgroups/$($wgA.id)/tasks/$($t.id)/status" @{ status = 'done'; result = 'ok' }
Check "status -> done + completedAt" (($td.status -eq 'done') -and ([bool]$td.completedAt))

# --- P4 workflow (4-step SOP) ---
$wf = ApiPost "/api/workgroups/$($wgB.id)/workflow/start" @{}
Check "workflow start -> planning" ($wf.phase -eq 'planning')
$phases = @(); foreach ($n in 1..4) { $phases += (ApiPost "/api/workgroups/$($wgB.id)/workflow/advance" @{}).phase }
Check "workflow advance -> ...->done" (($phases -join ',') -eq 'execution,audit,bugfix,done')
Check "workflow created 4 phase-tasks" ((ApiGet "/api/workgroups/$($wgB.id)/tasks").Count -eq 4)

# --- P5 handoff ---
$mb1 = ApiPost "/api/workgroups/$($wgB.id)/members" @{ adapterId = 'passthrough' }
$mb2 = ApiPost "/api/workgroups/$($wgB.id)/members" @{ adapterId = 'passthrough' }
$h = ApiPost "/api/workgroups/$($wgB.id)/handoff" @{ fromSessionId = $mb1.sessionId; toSessionId = $mb2.sessionId; note = 'did part 1' }
Check "handoff: roles flip idle/active" (($h.from.role -eq 'idle') -and ($h.to.role -eq 'active'))
Check "handoff.md: note written" ((Get-Content (Join-Path $projB '.switchboard\handoff.md') -Raw) -match 'did part 1')

# --- live WS broadcast ---
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]"ws://127.0.0.1:8799/workgroups/ws", [Threading.CancellationToken]::None).Wait(5000) | Out-Null
WsSend $ws ('{"type":"subscribe","workgroupId":"' + $wgA.id + '"}')
WsRecv $ws 1500 | Out-Null
ApiPost "/api/workgroups/$($wgA.id)/tasks" @{ title = 'ping'; description = 'x' } | Out-Null
$gotEvt = $false; for ($i = 0; $i -lt 6; $i++) { if ((WsRecv $ws 1000) -match 'workgroup.changed') { $gotEvt = $true; break } }
Check "live WS: workgroup.changed on mutation" $gotEvt
$ws.Dispose()

# --- persistence across restart (SPEC 9: metadata persists, sessions pruned) ---
Stop-Sb $proc
$proc = Start-Sb
Check "server restarted" ((ApiGet '/health').ok -eq $true)
$wgAr = ApiGet "/api/workgroups/$($wgA.id)"
Check "restart: workgroup persists" ($wgAr.id -eq $wgA.id)
Check "restart: dead members pruned" ($wgAr.members.Count -eq 0)
Check "restart: tasks persist" ((ApiGet "/api/workgroups/$($wgA.id)/tasks").Count -ge 2)
$wfr = ApiGet "/api/workgroups/$($wgB.id)/workflow"
Check "restart: workflow persists (done)" ($wfr.phase -eq 'done')

# --- teardown ---
Stop-Sb $proc
foreach ($id in $ids) { $rd = Join-Path $env:USERPROFILE ".switchboard\workgroups\$id"; if (Test-Path $rd) { Remove-Item $rd -Recurse -Force } }
if (Test-Path $root) { Remove-Item $root -Recurse -Force }
Write-Output ("RESULT  pass=" + $script:pass + "  fail=" + $script:fail)
if ($script:fail -gt 0) { exit 1 }
