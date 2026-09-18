# step080_prepare_app.ps1
# 阶段3-A：把 reader 构建产物复制进 app 目录，供打包使用
#
# 输入: G:\setting_pdf_reader\step010_reader_src\build\web
# 产出: G:\setting_pdf_reader\step060_app\reader-build
# 清单: G:\setting_pdf_reader\step080_prepare_manifest.txt
#
# 为什么要复制：主进程按 [reader-build/, ../step010_reader_src/build/web] 顺序查找，
# 打包后源码树不存在，必须把构建产物放进 app 目录内。

$ErrorActionPreference = "Stop"

$Root     = "G:\setting_pdf_reader"
$Src      = Join-Path $Root "step010_reader_src\build\web"
$Dst      = Join-Path $Root "step060_app\reader-build"
$Manifest = Join-Path $Root "step080_prepare_manifest.txt"

Write-Host "=== 1/3 检查构建产物 ==="
foreach ($required in @("reader.js", "reader.css", "pdf\web\viewer.html")) {
    $p = Join-Path $Src $required
    if (-not (Test-Path $p)) { throw "缺少构建产物: $p`n请先运行: npx webpack --config-name web 并复制 pdfjs 产物" }
    Write-Host "  OK  $required"
}

Write-Host "=== 2/3 复制 ==="
if (Test-Path $Dst) { Remove-Item $Dst -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dst | Out-Null
Copy-Item -Path (Join-Path $Src "*") -Destination $Dst -Recurse -Force
Write-Host "  $Src -> $Dst"

Write-Host "=== 3/3 写清单 ==="
$files  = Get-ChildItem $Dst -Recurse -File
$bytes  = ($files | Measure-Object Length -Sum).Sum
$lines  = @()
$lines += "step080 app 资源准备清单"
$lines += "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += ""
$lines += "来源: $Src"
$lines += "目标: $Dst"
$lines += "文件数: $($files.Count)"
$lines += "总大小: $([math]::Round($bytes/1MB,1)) MB"
$lines += ""
$lines += "顶层内容:"
foreach ($i in (Get-ChildItem $Dst | Sort-Object Name)) {
    $lines += ("  {0,-24} {1}" -f $i.Name, $(if ($i.PSIsContainer) { "<DIR>" } else { "$([math]::Round($i.Length/1KB,1)) KB" }))
}
$lines | Out-File -FilePath $Manifest -Encoding utf8

Write-Host "  $($files.Count) 个文件, $([math]::Round($bytes/1MB,1)) MB"
Write-Host "  已写入: $Manifest"
Write-Host ""
Write-Host "=== 完成 ==="
