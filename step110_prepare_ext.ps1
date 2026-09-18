# step110_prepare_ext.ps1
# 方案B：把 reader 构建产物搬进 Edge 扩展目录
#
# 输入: G:\setting_pdf_reader\step010_reader_src\build\web
# 产出: G:\setting_pdf_reader\step110_edge_ext\reader
#
# 扩展的 reader 页面是 chrome-extension:// 页面，同源加载 pdf/web/viewer.html，
# 所以不需要 web_accessible_resources，但需要 CSP 里放开 'wasm-unsafe-eval'
# （pdf.js 的 jbig2 / openjpeg / qcms 都要用 WebAssembly）。

$ErrorActionPreference = "Stop"

$Root = "G:\setting_pdf_reader"
$Src  = Join-Path $Root "step010_reader_src\build\web"
$Ext  = Join-Path $Root "step110_edge_ext"
$Dst  = Join-Path $Ext "reader"

Write-Host "=== 1/3 检查构建产物 ==="
foreach ($r in @("reader.js", "reader.css", "pdf\web\viewer.html")) {
    $p = Join-Path $Src $r
    if (-not (Test-Path $p)) { throw "缺少构建产物: $p" }
    Write-Host "  OK  $r"
}

Write-Host "=== 2/3 复制到扩展目录 ==="
New-Item -ItemType Directory -Force -Path $Dst | Out-Null
Copy-Item -Path (Join-Path $Src "*") -Destination $Dst -Recurse -Force
Write-Host "  $Src -> $Dst"

Write-Host "=== 3/3 复制护眼主题定义 ==="
$themeSrc = Join-Path $Root "step060_app\renderer\eye-care-themes.js"
if (Test-Path $themeSrc) {
    Copy-Item $themeSrc (Join-Path $Dst "eye-care-themes.js") -Force
    Write-Host "  eye-care-themes.js 已复制"
} else {
    throw "找不到护眼主题定义: $themeSrc"
}

$files = Get-ChildItem $Dst -Recurse -File
Write-Host ""
Write-Host "=== 完成 ==="
Write-Host "  $($files.Count) 个文件, $([math]::Round(($files | Measure-Object Length -Sum).Sum/1MB,1)) MB"
Write-Host "  目标: $Dst"
