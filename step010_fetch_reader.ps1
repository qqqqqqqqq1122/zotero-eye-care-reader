# step010_fetch_reader.ps1
# 阶段1-A：拉取 zotero/reader 源码（含子模块）
#
# 产出目录: G:\setting_pdf_reader\step010_reader_src
# 产出清单: G:\setting_pdf_reader\step010_fetch_manifest.txt
#
# 背景：用户下载的 zotero-main.zip 里 reader/ 是空的 git 子模块，
#       真正的 PDF 渲染引擎在独立仓库 https://github.com/zotero/reader

$ErrorActionPreference = "Stop"

$Root     = "G:\setting_pdf_reader"
$RepoUrl  = "https://github.com/zotero/reader.git"
$Branch   = "10.0"
$SrcDir   = Join-Path $Root "step010_reader_src"
$Manifest = Join-Path $Root "step010_fetch_manifest.txt"

Write-Host "=== 1/4 检查前置工具 ==="
$toolVersions = @{}
foreach ($t in @("git", "node", "npm")) {
    $c = Get-Command $t -ErrorAction SilentlyContinue
    if (-not $c) { throw "缺少必要工具: $t" }
    $v = (& $t --version | Select-Object -First 1)
    $toolVersions[$t] = $v
    Write-Host ("  {0,-6} {1}" -f $t, $v)
}

$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
Write-Host "  Node 主版本: $nodeMajor"
if ($nodeMajor -lt 18) { throw "reader 要求 Node 18+，当前 $nodeMajor" }
if ($nodeMajor -gt 20) {
    Write-Host "  [警告] README 针对 Node 18，当前 $nodeMajor 偏新，构建老 webpack 可能踩坑"
}

Write-Host "=== 2/4 拉取源码 ==="
if (Test-Path $SrcDir) {
    Write-Host "  目录已存在，跳过 clone: $SrcDir"
} else {
    Write-Host "  clone $RepoUrl (branch=$Branch) -> $SrcDir"
    git clone --branch $Branch --recursive $RepoUrl $SrcDir
    if ($LASTEXITCODE -ne 0) { throw "git clone 失败，exit=$LASTEXITCODE" }
}

Write-Host "=== 3/4 确认子模块 ==="
$submoduleStatus = (git -C $SrcDir submodule status --recursive)
$submoduleStatus | ForEach-Object { Write-Host "  $_" }

$emptySubmodules = @()
foreach ($line in $submoduleStatus) {
    if ($line -match "^\s*-\S+\s+(\S+)") { $emptySubmodules += $Matches[1] }
}
if ($emptySubmodules.Count -gt 0) {
    Write-Host "  [警告] 以下子模块未初始化: $($emptySubmodules -join ', ')"
} else {
    Write-Host "  所有子模块已初始化 OK"
}

Write-Host "=== 4/4 写清单 ==="
$commit = (git -C $SrcDir rev-parse HEAD).Trim()
$commitDate = (git -C $SrcDir log -1 --format=%cI).Trim()

$lines = @()
$lines += "step010 zotero/reader 源码拉取清单"
$lines += "生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
$lines += ""
$lines += "仓库:     $RepoUrl"
$lines += "分支:     $Branch"
$lines += "提交:     $commit"
$lines += "提交时间: $commitDate"
$lines += "源码目录: $SrcDir"
$lines += ""
$lines += "工具版本:"
foreach ($k in $toolVersions.Keys) { $lines += ("  {0,-6} {1}" -f $k, $toolVersions[$k]) }
$lines += ""
$lines += "子模块状态:"
foreach ($line in $submoduleStatus) { $lines += "  $line" }
$lines += ""
$lines += "顶层内容:"
foreach ($item in (Get-ChildItem $SrcDir | Sort-Object Name)) {
    $lines += ("  {0,-30} {1}" -f $item.Name, $(if ($item.PSIsContainer) { "<DIR>" } else { "$($item.Length) bytes" }))
}

$lines | Out-File -FilePath $Manifest -Encoding utf8
Write-Host "  已写入: $Manifest"
Write-Host ""
Write-Host "=== 完成 ==="
Write-Host "  源码: $SrcDir"
Write-Host "  提交: $commit"
