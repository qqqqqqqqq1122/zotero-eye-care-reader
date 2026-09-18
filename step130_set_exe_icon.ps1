# step130_set_exe_icon.ps1
# 把 step120 生成的 PDF 风格图标注入 ZoteroReader.exe 的资源段
#
# 输入: G:\setting_pdf_reader\step120_pdf_icon.ico
# 目标: G:\setting_pdf_reader\step090_dist\ZoteroReader.exe
# 产出预览: G:\setting_pdf_reader\step130_icon_check.png
#
# 为什么这么做：exe 的图标是编译进资源段的，改文件名/放个 ico 在旁边都没用。
# 用 Win32 的 BeginUpdateResource / UpdateResource / EndUpdateResource
# 直接替换 RT_ICON(3) 和 RT_GROUP_ICON(14)。
#
# 注意：改完后 .pdf 文件关联的 DefaultIcon 指向这个 exe，
# 所以资源管理器里 .pdf 文件的图标也会跟着变成这个样子。
#
# 顺序要求：本脚本必须在 step090 打包之后运行（step090 会重建整个 dist）。

$ErrorActionPreference = "Stop"

$Root = "G:\setting_pdf_reader"
$Ico  = Join-Path $Root "step120_pdf_icon.ico"
$Exe  = Join-Path $Root "step090_dist\ZoteroReader.exe"
$Check = Join-Path $Root "step130_icon_check.png"

if (-not (Test-Path $Ico)) { throw "图标不存在，请先运行 step120: $Ico" }
if (-not (Test-Path $Exe)) { throw "目标 exe 不存在，请先运行 step090: $Exe" }

if (Get-Process ZoteroReader -ErrorAction SilentlyContinue) {
    throw "ZoteroReader.exe 正在运行，请先关掉再换图标"
}

# ---- Win32 声明 ----
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ResUpdate {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "BeginUpdateResourceW")]
    public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "UpdateResourceW")]
    public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "EndUpdateResourceW")]
    public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
'@

$RT_ICON = [IntPtr]3
$RT_GROUP_ICON = [IntPtr]14
$LANG = [UInt16]1033      # en-US，Electron 的资源用的就是这个

Write-Host "=== 1/3 解析 .ico ==="
$raw = [System.IO.File]::ReadAllBytes($Ico)
$count = [BitConverter]::ToUInt16($raw, 4)
if ($count -eq 0) { throw "ico 里没有图像" }
Write-Host "  共 $count 个尺寸"

$entries = @()
for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + 16 * $i
    $bw  = $raw[$off]
    $bh  = $raw[$off + 1]
    $bc  = $raw[$off + 2]
    $res = $raw[$off + 3]
    $planes = [BitConverter]::ToUInt16($raw, $off + 4)
    $bits   = [BitConverter]::ToUInt16($raw, $off + 6)
    $size   = [BitConverter]::ToUInt32($raw, $off + 8)
    $dataOff = [BitConverter]::ToUInt32($raw, $off + 12)
    $data = New-Object byte[] $size
    [Array]::Copy($raw, $dataOff, $data, 0, $size)
    $entries += [PSCustomObject]@{
        W = $bw; H = $bh; ColorCount = $bc; Reserved = $res
        Planes = $planes; BitCount = $bits; Data = $data
        Label = "$(if ($bw -eq 0) { 256 } else { $bw })x$(if ($bh -eq 0) { 256 } else { $bh })"
    }
}
$entries | ForEach-Object { Write-Host "    $($_.Label)  $($_.Data.Length) bytes" }

Write-Host "=== 2/3 注入资源 ==="
$h = [ResUpdate]::BeginUpdateResource($Exe, $false)
if ($h -eq [IntPtr]::Zero) {
    throw "BeginUpdateResource 失败，错误码 $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

try {
    # 每个尺寸写一条 RT_ICON，ID 从 1 开始
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $id = [IntPtr]($i + 1)
        $e = $entries[$i]
        $ok = [ResUpdate]::UpdateResource($h, $RT_ICON, $id, $LANG, $e.Data, [uint32]$e.Data.Length)
        if (-not $ok) { throw "写 RT_ICON id=$($i+1) 失败，错误码 $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
        Write-Host "    RT_ICON  id=$($i+1)  $($e.Label)"
    }

    # 再写一条 RT_GROUP_ICON 把它们串起来。
    # 结构与 ICONDIR 类似，但最后一项是资源 ID 而不是文件偏移。
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt16]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]$entries.Count)
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $e = $entries[$i]
        $bw.Write([Byte]$e.W)
        $bw.Write([Byte]$e.H)
        $bw.Write([Byte]$e.ColorCount)
        $bw.Write([Byte]$e.Reserved)
        $bw.Write([UInt16]$e.Planes)
        $bw.Write([UInt16]$e.BitCount)
        $bw.Write([UInt32]$e.Data.Length)
        $bw.Write([UInt16]($i + 1))          # nID
    }
    $bw.Flush()
    $grp = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()

    $ok = [ResUpdate]::UpdateResource($h, $RT_GROUP_ICON, [IntPtr]1, $LANG, $grp, [uint32]$grp.Length)
    if (-not $ok) { throw "写 RT_GROUP_ICON 失败，错误码 $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    Write-Host "    RT_GROUP_ICON id=1  ($($grp.Length) bytes)"
}
finally {
    $committed = [ResUpdate]::EndUpdateResource($h, $false)
    if (-not $committed) { throw "EndUpdateResource 提交失败" }
}

Write-Host "=== 3/3 验证：把图标从 exe 里抽出来看 ==="
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)
if ($icon) {
    $bmp = $icon.ToBitmap()
    $bmp.Save($Check, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "  已抽出 $($bmp.Width)x$($bmp.Height) 图标 -> $Check"
    $bmp.Dispose(); $icon.Dispose()
}
else {
    Write-Host "  警告：ExtractAssociatedIcon 返回空"
}

Write-Host ""
Write-Host "=== 完成 ==="
Write-Host "  目标: $Exe"
Write-Host "  预览: $Check"
