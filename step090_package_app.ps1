# step090_package_app.ps1
# 阶段3-B：把 Electron 运行时 + 我们的 app 组装成可分发目录
#
# 输入: G:\setting_pdf_reader\step060_app
# 产出: G:\setting_pdf_reader\step090_dist\ZoteroReader.exe
# 清单: G:\setting_pdf_reader\step090_package_manifest.txt
#
# 为什么手工组装而不用 electron-builder：
#   electron-builder 需要额外下载 winCodeSign / nsis 等二进制，
#   那些走 GitHub Releases 重定向，本机对 raw.githubusercontent.com 一类域名解析失败，
#   失败风险高。手工组装只用本地已下载好的 electron dist，完全离线。

$ErrorActionPreference = "Stop"

$Root         = "G:\setting_pdf_reader"
$AppSrc       = Join-Path $Root "step060_app"
$ElectronDist = Join-Path $AppSrc "node_modules\electron\dist"
$Dist         = Join-Path $Root "step090_dist"
$ExeName      = "ZoteroReader.exe"
$Manifest     = Join-Path $Root "step090_package_manifest.txt"

# 只打包 app 自己的东西，绝不包含 node_modules（里面有 234 MB 的 electron，重复）
$Include = @("package.json", "main.js", "renderer", "reader-build")

Write-Host "=== 1/4 校验输入 ==="
if (-not (Test-Path (Join-Path $ElectronDist "electron.exe"))) { throw "Electron 运行时不存在: $ElectronDist" }
Write-Host "  Electron OK"
foreach ($item in $Include) {
    $p = Join-Path $AppSrc $item
    if (-not (Test-Path $p)) { throw "app 文件缺失: $p（reader-build 需先运行 step080）" }
    Write-Host "  OK  $item"
}

Write-Host "=== 2/4 复制 Electron 运行时 ==="
if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
Copy-Item -Path (Join-Path $ElectronDist "*") -Destination $Dist -Recurse -Force
Write-Host "  $ElectronDist -> $Dist"

Write-Host "=== 3/4 安装 app 到 resources\app ==="
$AppDst = Join-Path $Dist "resources\app"
New-Item -ItemType Directory -Force -Path $AppDst | Out-Null
foreach ($item in $Include) {
    Copy-Item -Path (Join-Path $AppSrc $item) -Destination $AppDst -Recurse -Force
    Write-Host "  + $item"
}

# 重命名可执行文件
Rename-Item -Path (Join-Path $Dist "electron.exe") -NewName $ExeName
Write-Host "  electron.exe -> $ExeName"

Write-Host "=== 4/4 写清单 ==="
$AppExe  = Join-Path $Dist $ExeName
$files   = Get-ChildItem $Dist -Recurse -File
$bytes   = ($files | Measure-Object Length -Sum).Sum

$lines  = @()
$lines += "step090 打包清单"
$lines += "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += ""
$lines += "分发目录: $Dist"
$lines += "可执行文件: $AppExe"
$lines += "文件数: $($files.Count)"
$lines += "总大小: $([math]::Round($bytes/1MB,1)) MB"
$lines += ""
$lines += "app 内容 (resources\app):"
foreach ($item in $Include) { $lines += "  $item" }
$lines += ""
$lines += "验证方式:"
$lines += "  & `"$AppExe`" `"<某个.pdf>`""
$lines += ""
$lines += "注意: UCPD (User Choice Protection Driver) 在本机处于 Running 状态，"
$lines += "      会拒绝任何对 .pdf\UserChoice 的脚本写入，"
$lines += "      因此默认程序必须由用户在系统 UI 中手动指定（见 step100）。"
$lines | Out-File -FilePath $Manifest -Encoding utf8

Write-Host "  $($files.Count) 个文件, $([math]::Round($bytes/1MB,1)) MB"
Write-Host "  可执行文件: $AppExe"
Write-Host "  已写入: $Manifest"
Write-Host ""
Write-Host "=== 完成 ==="
