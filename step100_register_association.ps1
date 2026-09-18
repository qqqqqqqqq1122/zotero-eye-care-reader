# step100_register_association.ps1
# 阶段3-C：把 ZoteroReader 注册成 PDF 处理程序，并修复坏掉的旧关联
#
# 产出清单: G:\setting_pdf_reader\step100_association_manifest.txt
#
# ============================ 重要背景 ============================
# 本机 UCPD (User Choice Protection Driver) 服务处于 Running 状态，
# 实测对 HKCU\...\Explorer\FileExts\.pdf\UserChoice 的任何脚本写入都会被拒绝：
#     "Requested registry access is not allowed."
#
# 而 UserChoice 才是决定「双击 PDF 用哪个程序」的那个键。
# 所以本脚本只能完成「注册」，无法完成「设为默认」—— 最后一步必须由用户
# 在 Windows 界面里点一下。这不是脚本写得不好，是 Windows 的设计。
# ==================================================================

$ErrorActionPreference = "Stop"

$Root     = "G:\setting_pdf_reader"
$Exe      = Join-Path $Root "step090_dist\ZoteroReader.exe"
$ProgId   = "ZoteroReader.pdf"
$AppKey   = "ZoteroReader.exe"
$Friendly = "ZoteroReader 阅读器"
$Manifest = Join-Path $Root "step100_association_manifest.txt"

if (-not (Test-Path $Exe)) { throw "找不到可执行文件，请先运行 step090: $Exe" }

$log = @()
function Step($msg) { Write-Host $msg; $script:log += $msg }

Step "=== 1/5 清理坏掉的旧关联 ==="
# 之前手工/脚本写出来的野路子 ProgID，指向 zotero.exe（Zotero 已证明不认命令行 PDF）
$legacy = "HKCU:\Software\Classes\pdf_auto_file"
if (Test-Path $legacy) {
    $old = (Get-ItemProperty "$legacy\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
    Remove-Item $legacy -Recurse -Force
    Step "  已删除野路子 ProgID pdf_auto_file (原值: $old)"
} else {
    Step "  pdf_auto_file 不存在，跳过"
}

# HKCU\Software\Classes\.pdf 的默认值指向空壳 ProgID winupdf（全盘无任何 open 命令），
# 一旦 UserChoice 失效就会退到这里，表现为「双击毫无反应」
$extKey = "HKCU:\Software\Classes\.pdf"
if (Test-Path $extKey) {
    $cur = (Get-ItemProperty $extKey -ErrorAction SilentlyContinue).'(default)'
    if ($cur -eq "winupdf") {
        Step "  .pdf 的兜底 ProgID 是空壳 winupdf，将改指到 $ProgId"
    } else {
        Step "  .pdf 的兜底 ProgID 当前为: $cur"
    }
} else {
    New-Item -Path $extKey -Force | Out-Null
}

Step "=== 2/5 注册 ProgID: $ProgId ==="
$pk = "HKCU:\Software\Classes\$ProgId"
New-Item -Path $pk -Force | Out-Null
Set-ItemProperty -Path $pk -Name "(default)" -Value "PDF 文档"
New-Item -Path "$pk\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$pk\DefaultIcon" -Name "(default)" -Value "`"$Exe`",0"
New-Item -Path "$pk\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$pk\shell\open\command" -Name "(default)" -Value "`"$Exe`" `"%1`""
Step "  shell\open\command = `"$Exe`" `"%1`""

Step "=== 3/5 注册 Applications 条目（让它出现在「打开方式」列表）==="
$ak = "HKCU:\Software\Classes\Applications\$AppKey"
New-Item -Path $ak -Force | Out-Null
Set-ItemProperty -Path $ak -Name "FriendlyAppName" -Value $Friendly
New-Item -Path "$ak\SupportedTypes" -Force | Out-Null
Set-ItemProperty -Path "$ak\SupportedTypes" -Name ".pdf" -Value ""
New-Item -Path "$ak\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$ak\shell\open\command" -Name "(default)" -Value "`"$Exe`" `"%1`""
Step "  SupportedTypes: .pdf"

Step "=== 4/5 修复兜底 ProgID 与 OpenWithProgids ==="
Set-ItemProperty -Path $extKey -Name "(default)" -Value $ProgId
Step "  HKCU\Software\Classes\.pdf = $ProgId"

$owp = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids"
try {
    New-Item -Path $owp -Force | Out-Null
    Set-ItemProperty -Path $owp -Name $ProgId -Value ([byte[]]@()) -Type Binary
    Step "  OpenWithProgids 已加入 $ProgId"
} catch {
    Step "  OpenWithProgids 写入失败（不影响主流程）: $($_.Exception.Message)"
}

Step "=== 5/5 尝试设置默认程序（预期会被 UCPD 拒绝）==="
$uc = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice"
$ucResult = ""
try {
    Set-ItemProperty -Path $uc -Name "ProgId" -Value $ProgId -ErrorAction Stop
    Start-Sleep -Seconds 2
    $now = (Get-ItemProperty $uc -ErrorAction Stop).ProgId
    if ($now -eq $ProgId) {
        $ucResult = "成功！UserChoice 已设为 $ProgId"
    } else {
        $ucResult = "被系统还原为 $now（UCPD 介入）"
    }
} catch {
    $ucResult = "被拒绝: $($_.Exception.Message)"
}
Step "  $ucResult"

# ------------------------------------------------------------------
Step ""
Step "================ 需要你手动完成的一步 ================"
Step "UCPD 保护了默认程序设置，脚本改不了。请手动操作："
Step ""
Step "  方法一（推荐）："
Step "    1. 在任意 PDF 文件上点右键"
Step "    2. 打开方式 -> 选择其他应用"
Step "    3. 在列表里选「$Friendly」"
Step "       （若列表里没有，点「更多应用」->「在这台电脑上查找其他应用」"
Step "         然后选 $Exe）"
Step "    4. 勾选「始终使用此应用打开 .pdf 文件」，确定"
Step ""
Step "  方法二："
Step "    设置 -> 应用 -> 默认应用 -> 按文件类型选择默认应用 -> .pdf"
Step "    选择「$Friendly」"
Step "======================================================"

$log | Out-File -FilePath $Manifest -Encoding utf8
Write-Host ""
Write-Host "已写入清单: $Manifest"
