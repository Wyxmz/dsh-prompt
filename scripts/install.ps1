<#
.SYNOPSIS
    把 dsh-idle-alert 装进 DeepSeek Harness 的 profile。

.DESCRIPTION
    做三件事：

      1. 在 <profile>\node_modules 下建目录联接（junction）指向本仓库
         —— 不复制、不占空间，改源码即时生效
      2. 把包名写进 <profile>\package.json 的 dependencies（link: 相对路径）
      3. 把包名追加进 <profile>\package.json 的 dsh.profile.bundles
         ⚠️ 只写 dependencies 不会被加载，bundles 才是加载列表

    写 profile\package.json 之前会先备份成 package.json.bak-<时间戳>。
    装完需要**重启 DSH 桌面应用**才生效。

    profile 目录默认按环境变量探测：$env:DSH_PROFILE_DIR →
    $env:DSH_HOME\profiles\$env:DSH_PROFILE → ~/.dsh/profiles/desktop。
    探测不到时请用 -ProfileDir 显式指定。

.PARAMETER ProfileDir
    DSH profile 目录（里面有 package.json 与 node_modules 的那个）。

.PARAMETER BundleId
    写入 bundles 的标识，默认 dsh-idle-alert，一般不用改。

.EXAMPLE
    pwsh -NoProfile -File .\scripts\install.ps1

.EXAMPLE
    pwsh -NoProfile -File .\scripts\install.ps1 -ProfileDir 'D:\dsh\profiles\desktop'

.EXAMPLE
    # 只看会做什么，不落盘
    pwsh -NoProfile -File .\scripts\install.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProfileDir,
    [string]$BundleId = 'dsh-idle-alert'
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 0. 定位插件目录与 profile 目录
# ---------------------------------------------------------------------------
$pluginSrc = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $pluginSrc 'package.json'))) {
    throw "找不到插件根目录（应为 scripts 的上一级）：$pluginSrc"
}
foreach ($f in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'assets\alert.js', 'assets\alert.m4a')) {
    $full = Join-Path $pluginSrc $f
    if (-not (Test-Path -LiteralPath $full)) { throw "插件文件缺失：$full" }
}

function Resolve-ProfileDir {
    param([string]$Explicit)
    if ($Explicit) { return $Explicit }
    if ($env:DSH_PROFILE_DIR) { return $env:DSH_PROFILE_DIR }
    if ($env:DSH_HOME) {
        $name = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'desktop' }
        return (Join-Path $env:DSH_HOME "profiles\$name")
    }
    foreach ($cand in @(
            (Join-Path $HOME '.dsh/profiles/desktop'),
            (Join-Path $HOME '.deepseek/profiles/desktop')
        )) {
        if (Test-Path -LiteralPath $cand) { return $cand }
    }
    return $null
}

# 联接目标的原样比较会踩坑：跨进程读到的 Target 可能带 `Global\` 或 `\??\` 前缀，
# 尾部分隔符也不一致。统一规范化后再比，幂等判断才可靠。
function Normalize-LinkTarget {
    param([string]$Value)
    if (-not $Value) { return '' }
    $v = $Value -replace '^\\\\\?\?\\', ''
    $v = $v -replace '^Global\\', ''
    return $v.TrimEnd('\', '/')
}

if (-not $ProfileDir) { $ProfileDir = Resolve-ProfileDir -Explicit $null }
if (-not $ProfileDir) {
    throw @'
探测不到 DSH profile 目录。请显式指定，例如：
  pwsh -NoProfile -File .\scripts\install.ps1 -ProfileDir "<DSH_HOME>\profiles\<profile>"
（DSH 的 profile 目录是里面有 package.json 和 node_modules 的那一层）
'@
}
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "profile 目录不存在：$ProfileDir" }

$pkgJsonPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgJsonPath)) { throw "profile 里没有 package.json：$pkgJsonPath" }

$linkPath = Join-Path (Join-Path $ProfileDir 'node_modules') $BundleId
$onWindows = ($env:OS -eq 'Windows_NT')

Write-Host "[1/4] 插件目录：$pluginSrc"
Write-Host "      profile：$ProfileDir"

# ---------------------------------------------------------------------------
# 1. 目录联接（已存在且指向正确则跳过）
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $targets = @($item.Target | ForEach-Object { Normalize-LinkTarget $_ })
    $ok = ($item.LinkType -in @('Junction', 'SymbolicLink')) -and
        ($targets -contains (Normalize-LinkTarget $pluginSrc))
    if ($ok) {
        Write-Host "[2/4] 联接已存在且指向正确，跳过：$linkPath"
    }
    else {
        throw "已存在但不是预期联接，拒绝覆盖：$linkPath (LinkType=$($item.LinkType), Target=$($targets -join ','))"
    }
}
else {
    if ($PSCmdlet.ShouldProcess($linkPath, "创建目录联接 -> $pluginSrc")) {
        $parent = Split-Path -Parent $linkPath
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if ($onWindows) {
            New-Item -ItemType Junction -Path $linkPath -Target $pluginSrc | Out-Null
        }
        else {
            New-Item -ItemType SymbolicLink -Path $linkPath -Target $pluginSrc | Out-Null
        }
        Write-Host "[2/4] 已创建联接：$linkPath -> $pluginSrc"
    }
}

# ---------------------------------------------------------------------------
# 2. 备份 profile\package.json（保留原 BOM 与换行风格）
# ---------------------------------------------------------------------------
$bytes = [IO.File]::ReadAllBytes($pkgJsonPath)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$raw = [IO.File]::ReadAllText($pkgJsonPath, [Text.Encoding]::UTF8)
$nl = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }

# ---------------------------------------------------------------------------
# 3. 写入 dependencies 与 dsh.profile.bundles
# ---------------------------------------------------------------------------
$changed = $false

if ($raw -match ('"' + [regex]::Escape($BundleId) + '"\s*:')) {
    Write-Host "      dependencies 已含 $BundleId，跳过"
}
else {
    $rxDep = [regex]'("dependencies"\s*:\s*\{)'
    if (-not $rxDep.IsMatch($raw)) { throw 'profile package.json 里找不到 dependencies 段' }
    $rel = $pluginSrc
    try {
        $rel = [IO.Path]::GetRelativePath($ProfileDir, $pluginSrc)
    }
    catch { }
    $rel = ($rel -replace '\\', '/')
    $depLine = $nl + '    "' + $BundleId + '": "link:' + $rel + '",'
    $raw = $rxDep.Replace($raw, '$1' + $depLine, 1)
    $changed = $true
    Write-Host "      已写入 dependencies: link:$rel"
}

$rxB = [regex]'"bundles"\s*:\s*\[(?<items>[^\]]*)\]'
$m = $rxB.Match($raw)
if (-not $m.Success) {
    throw 'profile package.json 里找不到 dsh.profile.bundles；请手动把 ' + $BundleId + ' 加进去'
}
$items = $m.Groups['items'].Value
if ($items -match [regex]::Escape('"' + $BundleId + '"')) {
    Write-Host "      dsh.profile.bundles 已含 $BundleId，跳过"
}
else {
    $trimmed = $items.TrimEnd()
    $newItems = $trimmed
    if ($newItems.Length -gt 0 -and -not $newItems.EndsWith(',')) { $newItems += ',' }
    $newItems += $nl + '        "' + $BundleId + '"' + $nl + '      '
    $raw = $raw.Remove($m.Index, $m.Length).Insert($m.Index, $m.Value.Replace($items, $newItems))
    $changed = $true
    Write-Host '      已追加进 dsh.profile.bundles'
}

if ($changed) {
    if ($PSCmdlet.ShouldProcess($pkgJsonPath, '备份并写回 dependencies 与 dsh.profile.bundles')) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
        Copy-Item -LiteralPath $pkgJsonPath -Destination (Join-Path $ProfileDir "package.json.bak-$stamp") -Force
        [IO.File]::WriteAllText($pkgJsonPath, $raw, (New-Object Text.UTF8Encoding($hasBom)))
        Write-Host "[3/4] 已写回 package.json（备份 package.json.bak-$stamp）"
    }
}
else {
    Write-Host '[3/4] profile package.json 无需改动，不备份也不写盘'
}

# ---------------------------------------------------------------------------
# 4. 交叉验证
# ---------------------------------------------------------------------------
if ($WhatIfPreference) {
    Write-Host ''
    Write-Host 'WHATIF —— 未做任何改动。去掉 -WhatIf 即真正安装。'
    return
}

$json = Get-Content -Raw -Encoding UTF8 $pkgJsonPath | ConvertFrom-Json
$bundles = @($json.dsh.profile.bundles)
Write-Host ('[4/4] bundles 解析结果: ' + ($bundles -join ' | '))
if ($bundles -notcontains $BundleId) { throw "bundles 仍未包含 $BundleId" }
Write-Host ('      入口可解析: ' + (Test-Path -LiteralPath (Join-Path $linkPath 'lib\index.js')))
Write-Host ('      cordis.patch.yml: ' + (Test-Path -LiteralPath (Join-Path $linkPath 'cordis.patch.yml')))
Write-Host ('      提醒音: ' + (Test-Path -LiteralPath (Join-Path $linkPath 'assets\alert.m4a')))
Write-Host ''
Write-Host 'INSTALLED —— 现在需要重启 DSH 桌面应用才会生效。'
