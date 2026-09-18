# step110_make_icons.ps1
# 生成扩展图标：豆沙绿圆角底 + 深色文档条
#
# 产出: G:\setting_pdf_reader\step110_edge_ext\icons\icon{16,48,128}.png

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$OutDir = "G:\setting_pdf_reader\step110_edge_ext\icons"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 取自护眼主题「淡豆沙绿」
$bgColor = [System.Drawing.Color]::FromArgb(220, 234, 216)
$fgColor = [System.Drawing.Color]::FromArgb(38, 53, 42)

function New-Icon([int]$size, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # 圆角矩形底
    $r = [math]::Max(2, [int]($size * 0.20))
    $d = $r * 2
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddArc(0, 0, $d, $d, 180, 90)
    $gp.AddArc($size - $d - 1, 0, $d, $d, 270, 90)
    $gp.AddArc($size - $d - 1, $size - $d - 1, $d, $d, 0, 90)
    $gp.AddArc(0, $size - $d - 1, $d, $d, 90, 90)
    $gp.CloseFigure()
    $bg = New-Object System.Drawing.SolidBrush($bgColor)
    $g.FillPath($bg, $gp)

    # 三条文档横线
    $fg = New-Object System.Drawing.SolidBrush($fgColor)
    $mx = [int]($size * 0.28)
    $w = $size - 2 * $mx
    $barH = [math]::Max(1, [int]($size * 0.075))
    $gap = [int]($size * 0.145)
    $y0 = [int]($size * 0.33)
    for ($i = 0; $i -lt 3; $i++) {
        $ww = if ($i -eq 2) { [int]($w * 0.6) } else { $w }
        $g.FillRectangle($fg, $mx, $y0 + $i * $gap, $ww, $barH)
    }

    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  $path  ($size x $size)"
}

Write-Host "=== 生成图标 ==="
foreach ($s in @(16, 48, 128)) {
    New-Icon $s (Join-Path $OutDir "icon$s.png")
}
Write-Host "完成"
