# step110_cdp_probe.ps1
# 通过 Chrome DevTools Protocol 连到 Edge，在指定页面里求值 / 截图
#
# 用途：验证 Edge 扩展页面里的 WebAssembly 是否能在我们的 CSP 下编译 ——
#       这是只靠"扩展能加载"看不出来的风险点（pdf.js 的 jbig2/openjpeg/qcms 要用 wasm）。
#
# 用法:
#   .\step110_cdp_probe.ps1 -Port 9333 -UrlMatch "reader.html" -Expression "1+1"
#   .\step110_cdp_probe.ps1 -Port 9333 -UrlMatch "reader.html" -ScreenshotPath out.png

param(
    [int]$Port = 9333,
    [string]$UrlMatch = "reader.html",
    [string]$Navigate,
    [int]$WaitAfterNavigateSec = 8,
    # 同一个 URL 可能同时有 page / iframe / webview 多个 target，必须按类型挑
    [string]$TargetType = "page",
    [string]$Expression,
    [string]$ScreenshotPath,
    [int]$TimeoutSec = 30
)

$ErrorActionPreference = "Stop"

function Get-Targets([int]$p) {
    return Invoke-RestMethod "http://127.0.0.1:$p/json" -TimeoutSec 8
}

$script:CdpMsgId = 0

function Invoke-CdpCommand($ws, [string]$method, $params) {
    # id 由函数自己递增：PowerShell 参数模式会把 $id++ 当成字面量 "1++"
    $script:CdpMsgId++
    $id = $script:CdpMsgId
    $payload = @{ id = $id; method = $method }
    if ($params) { $payload.params = $params }
    $json = $payload | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $seg = New-Object System.ArraySegment[byte] -ArgumentList @(, $bytes)
    $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true,
        [System.Threading.CancellationToken]::None).Wait()

    # 一条一条读，直到拿到 id 匹配的那条。
    # 注意：像 Runtime.enable 会先推 executionContextCreated 之类的事件，
    # 那些消息没有 id —— 不能读到一条就当成响应。
    $buf = New-Object byte[] 65536
    while ($true) {
        $sb = New-Object System.Text.StringBuilder
        do {
            $seg2 = New-Object System.ArraySegment[byte] -ArgumentList @(, $buf)
            $r = $ws.ReceiveAsync($seg2, [System.Threading.CancellationToken]::None).Result
            [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
        } while (-not $r.EndOfMessage)

        $msg = $sb.ToString() | ConvertFrom-Json
        if ($null -eq $msg.id) { continue }        # 事件，跳过
        if ($msg.id -ne $id) { continue }          # 别的响应的，跳过
        if ($msg.error) { throw "CDP 错误: $($msg.error.message)" }
        return $msg.result
    }
}

# ---- 找目标 ----
$targets = Get-Targets $Port
$target = $targets | Where-Object { $_.url -like "*$UrlMatch*" -and $_.type -eq $TargetType } | Select-Object -First 1
if (-not $target) {
    Write-Host "没找到匹配 '$UrlMatch' (type=$TargetType) 的目标。现有目标："
    $targets | Select-Object type, url | Format-Table -AutoSize -Wrap
    exit 1
}
Write-Host "目标: $($target.type)  $($target.url)"

$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [System.Threading.CancellationToken]::None).Wait()
Write-Host "已连接 CDP"

try {
    [void](Invoke-CdpCommand $ws "Runtime.enable" $null)
    # Page 域只有 page 类型的 target 才有（service_worker 上没有）
    $isPage = $target.type -eq 'page'
    if ($isPage) { [void](Invoke-CdpCommand $ws "Page.enable" $null) }

    if ($Navigate -and -not $isPage) { throw "非 page 目标不能导航: $($target.type)" }

    if ($Navigate) {
        [void](Invoke-CdpCommand $ws "Page.navigate" @{ url = $Navigate })
        Write-Host "已导航到: $Navigate"
        Write-Host "等待 $WaitAfterNavigateSec 秒..."
        Start-Sleep -Seconds $WaitAfterNavigateSec
    }

    if ($Expression) {
        $res = Invoke-CdpCommand $ws "Runtime.evaluate" @{
            expression    = $Expression
            awaitPromise  = $true
            returnByValue = $true
        }
        Write-Host "=== 求值结果 ==="
        if ($res.exceptionDetails) {
            Write-Host "异常: $($res.exceptionDetails.text)"
            if ($res.exceptionDetails.exception) {
                Write-Host $res.exceptionDetails.exception.description
            }
        }
        else {
            $res.result.value | ConvertTo-Json -Depth 10
        }
    }

    if ($ScreenshotPath -and -not $isPage) { throw "非 page 目标不能截图: $($target.type)" }

    if ($ScreenshotPath) {
        $shot = Invoke-CdpCommand $ws "Page.captureScreenshot" @{ format = "png" }
        [System.IO.File]::WriteAllBytes($ScreenshotPath, [Convert]::FromBase64String($shot.data))
        Write-Host "截图已保存: $ScreenshotPath ($([math]::Round((Get-Item $ScreenshotPath).Length/1KB,1)) KB)"
    }
}
catch {
    # 单独打印，避免被 finally 的异常掩盖
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Write-Host "错误: $($e.Message)"
    Write-Host $_.ScriptStackTrace
    exit 1
}
finally {
    try {
        $ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, "done",
            [System.Threading.CancellationToken]::None).Wait()
    }
    catch { }
}
