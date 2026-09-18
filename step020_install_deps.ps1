# step020_install_deps.ps1
# 阶段1-B：安装 reader 依赖，并准备构建所需的语言文件
#
# 产出日志: G:\setting_pdf_reader\step020_npm_install.log
# 产出清单: G:\setting_pdf_reader\step020_install_manifest.txt
#
# 背景（重要，别删）：
#   reader 的 webpack.zotero-locale-plugin.js 会从
#   https://raw.githubusercontent.com/zotero/zotero/<commit> 下载 .ftl 语言文件。
#   本机 raw.githubusercontent.com 无法解析，且该插件不跟随重定向，构建必然失败。
#
#   绕过办法：改从 jsDelivr CDN（cdn.jsdelivr.net/gh/...）按同样的 commit 拉取，
#   放进 reader 源码树的 locales/en-US/，并写入 locales/.signature 记录 commit。
#   插件读到 .signature 与 .zotero-locale-commit 一致时就会跳过下载。

$ErrorActionPreference = "Stop"

$Root     = "G:\setting_pdf_reader"
$SrcDir   = Join-Path $Root "step010_reader_src"
$LogFile  = Join-Path $Root "step020_npm_install.log"
$Manifest = Join-Path $Root "step020_install_manifest.txt"

if (-not (Test-Path $SrcDir)) { throw "源码目录不存在，请先运行 step010_fetch_reader.ps1: $SrcDir" }

Write-Host "=== 1/4 检查前置工具 ==="
$bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bash) { throw "缺少 bash（reader 的构建脚本依赖 bash，需要 Git for Windows）" }
Write-Host "  bash   $(& bash --version | Select-Object -First 1)"
Write-Host "  node   $(& node --version)"
Write-Host "  npm    $(& npm --version)"
Write-Host "  registry $(npm config get registry)"

Write-Host "=== 2/4 安装依赖 ==="
if (Test-Path (Join-Path $SrcDir "node_modules\.package-lock.json")) {
    Write-Host "  依赖已安装，跳过 npm install"
} else {
    # 注意：必须用 bash 执行，且 NODE_OPTIONS 要在 bash 里设置
    bash -c "cd '$($SrcDir -replace '\\','/')' && NODE_OPTIONS=--openssl-legacy-provider npm install" 2>&1 |
        Tee-Object -FilePath $LogFile
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败，exit=$LASTEXITCODE" }
}

Write-Host "=== 3/4 准备语言文件 ==="
$localeCommit = (Get-Content (Join-Path $SrcDir ".zotero-locale-commit") -Raw).Trim()
$locDir = Join-Path $SrcDir "locales\en-US"
$sigPath = Join-Path $SrcDir "locales\.signature"
New-Item -ItemType Directory -Force -Path $locDir | Out-Null

$targets = @(
    @{ name = "zotero.ftl"; path = "chrome/locale/en-US/zotero/zotero.ftl" },
    @{ name = "reader.ftl"; path = "chrome/locale/en-US/zotero/reader.ftl" },
    @{ name = "brand.ftl";  path = "app/assets/branding/locale/brand.ftl" }
)

$localeResults = @()
foreach ($t in $targets) {
    $out = Join-Path $locDir $t.name
    $src = "jsDelivr CDN"
    if (Test-Path $out) {
        $localeResults += "  跳过（已存在）  $($t.name)"
        continue
    }
    $url = "https://cdn.jsdelivr.net/gh/zotero/zotero@$localeCommit/$($t.path)"
    try {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 30
        $localeResults += "  OK  $($t.name)  $((Get-Item $out).Length) bytes  <- $src"
    } catch {
        throw "语言文件拉取失败: $($t.name) ($url)`n$($_.Exception.Message)"
    }
}
$localeCommit | Out-File -FilePath $sigPath -Encoding ascii -NoNewline
$localeResults += "  已写入 .signature = $localeCommit"
$localeResults | ForEach-Object { Write-Host $_ }

Write-Host "=== 4/4 写清单 ==="
$lines = @()
$lines += "step020 reader 依赖安装清单"
$lines += "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += ""
$lines += "源码目录:   $SrcDir"
$lines += "语言文件:   $locDir"
$lines += "语言 commit: $localeCommit"
$lines += "npm registry: $(npm config get registry)"
$lines += ""
$lines += "top-level node_modules 包数: $(@(Get-ChildItem (Join-Path $SrcDir 'node_modules') -Directory).Count)"
$lines += ""
$lines += "语言文件准备结果:"
$lines += $localeResults
$lines += ""
$lines += "踩坑记录:"
$lines += "  raw.githubusercontent.com 在本机无法解析，且 ZoteroLocalePlugin 不跟随重定向，"
$lines += "  因此改用 jsDelivr CDN 镜像按同一 commit 拉取 .ftl，并写入 locales/.signature 让其跳过下载。"

$lines | Out-File -FilePath $Manifest -Encoding utf8
Write-Host "  已写入: $Manifest"
Write-Host ""
Write-Host "=== 完成 ==="
