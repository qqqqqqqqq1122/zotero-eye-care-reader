# step120_make_pdf_icon.ps1
# 生成 PDF 风格图标：白纸 + 右上折角 + 红色 PDF 色带（参考 Edge 的 PDF 图标）
#
# 产出: G:\setting_pdf_reader\step120_pdf_icon.ico
#       （多尺寸，PNG 压缩条目；Windows Vista+ 支持）
# 同时产出各尺寸 PNG 便于预览: G:\setting_pdf_reader\step120_icon_<size>.png

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$Root = "G:\setting_pdf_reader"
$Ico  = Join-Path $Root "step120_pdf_icon.ico"
$Sizes = @(16, 24, 32, 48, 64, 128, 256)

function New-PdfIconBitmap([int]$S) {
    $bmp = New-Object System.Drawing.Bitmap($S, $S)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # 小尺寸下细节会糊，按尺寸调整比例
    $m = [double]$S * 0.09                       # 外边距
    $w = [double]$S - 2 * $m
    $h = [double]$S - 2 * $m
    $f = [double]$S * 0.26                       # 折角边长

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $grey  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 205, 210))
    $line  = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(190, 195, 200))
    $red   = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(211, 47, 47))
    $pen   = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(160, 165, 170), [float][Math]::Max(0.6, $S * 0.012))

    # 纸张轮廓（右上角切掉一块给折角）
    $pts = @(
        (New-Object System.Drawing.PointF([float]$m, [float]$m)),
        (New-Object System.Drawing.PointF([float]($m + $w - $f), [float]$m)),
        (New-Object System.Drawing.PointF([float]($m + $w), [float]($m + $f))),
        (New-Object System.Drawing.PointF([float]($m + $w), [float]($m + $h))),
        (New-Object System.Drawing.PointF([float]$m, [float]($m + $h)))
    )
    $g.FillPolygon($white, $pts)
    $g.DrawPolygon($pen, $pts)

    # 折角三角
    $fold = @(
        (New-Object System.Drawing.PointF([float]($m + $w - $f), [float]$m)),
        (New-Object System.Drawing.PointF([float]($m + $w - $f), [float]($m + $f))),
        (New-Object System.Drawing.PointF([float]($m + $w), [float]($m + $f)))
    )
    $g.FillPolygon($grey, $fold)
    $g.DrawPolygon($pen, $fold)

    # 上方几条文字线（太小时省略，否则是糊的）
    if ($S -ge 32) {
        $barH = [float]([Math]::Max(1, $S * 0.035))
        $x0 = [float]($m + $w * 0.14)
        $lw = [float]($w * 0.5)
        for ($i = 0; $i -lt 3; $i++) {
            $y = [float]($m + $h * (0.16 + $i * 0.085))
            $g.FillRectangle($line, $x0, $y, $lw, $barH)
        }
    }

    # 红色 PDF 色带（横跨整张纸）
    $bandTop = [float]($m + $h * 0.40)
    $bandH   = [float]($h * 0.28)
    if ($S -lt 32) { $bandTop = [float]($m + $h * 0.37); $bandH = [float]($h * 0.32) }
    $g.FillRectangle($red, [float]$m, $bandTop, [float]$w, $bandH)

    # 色带里的 PDF 字样（16px 下画不下，省略）
    if ($S -ge 32) {
        $fontSize = [float]($bandH * 0.82)
        $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = [System.Drawing.StringAlignment]::Center
        $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
        $rect = New-Object System.Drawing.RectangleF([float]$m, $bandTop, [float]$w, $bandH)
        $g.DrawString("PDF", $font, $white, $rect, $sf)
        $font.Dispose(); $sf.Dispose()
    }

    # 色带下方再来一条线
    if ($S -ge 48) {
        $barH = [float]([Math]::Max(1, $S * 0.035))
        $g.FillRectangle($line, [float]($m + $w * 0.14), [float]($m + $h * 0.76), [float]($w * 0.5), $barH)
    }

    $pen.Dispose(); $white.Dispose(); $grey.Dispose(); $line.Dispose(); $red.Dispose()
    $g.Dispose()
    return $bmp
}

Write-Host "=== 1/2 生成各尺寸 PNG ==="
$pngs = @()
foreach ($s in $Sizes) {
    $bmp = New-PdfIconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    $bmp.Save((Join-Path $Root "step120_icon_$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $pngs += [PSCustomObject]@{ Size = $s; Bytes = $bytes }
    Write-Host "  $s x $s  -> $($bytes.Length) bytes"
}

Write-Host "=== 2/2 组装 .ico ==="
# ICONDIR(6 字节) + ICONDIRENTRY(16 字节 * N) + 各 PNG 数据
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([UInt16]0)                 # idReserved
$bw.Write([UInt16]1)                 # idType = 1 (icon)
$bw.Write([UInt16]$pngs.Count)       # idCount

$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
    $bw.Write([Byte]$(if ($p.Size -ge 256) { 0 } else { $p.Size }))  # 256 记作 0
    $bw.Write([Byte]$(if ($p.Size -ge 256) { 0 } else { $p.Size }))
    $bw.Write([Byte]0)               # bColorCount
    $bw.Write([Byte]0)               # bReserved
    $bw.Write([UInt16]1)             # wPlanes
    $bw.Write([UInt16]32)            # wBitCount
    $bw.Write([UInt32]$p.Bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $p.Bytes.Length
}
foreach ($p in $pngs) { $bw.Write($p.Bytes) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($Ico, $ms.ToArray())
$bw.Dispose(); $ms.Dispose()

Write-Host "  已写入: $Ico ($([math]::Round((Get-Item $Ico).Length/1KB,1)) KB, $($pngs.Count) 个尺寸)"
