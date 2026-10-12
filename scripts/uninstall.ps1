<#
.SYNOPSIS
    把 dsh-idle-alert 从 DeepSeek Harness 的 profile 里卸载。

.DESCRIPTION
    做三件事：

      1. 摘掉 <profile>\node_modules\dsh-idle-alert 联接（**不动**插件源码目录）
      2. 从 <profile>\package.json 的 dependencies 里移除该条目
      3. 从 <profile>\package.json 的 dsh.profile.bundles 里移除该条目

    改 profile\package.json 之前会先备份成 package.json.bak-<时间戳>。
    卸载完需要**重启 DSH 桌面应用**才生效。

.PARAMETER ProfileDir
    DSH profile 目录。默认按环境变量探测（同 install.ps1）。

.EXAMPLE
    pwsh -NoProfile -File .\scripts\uninstall.ps1

.EXAMPLE
    pwsh -NoProfile -File .\scripts\uninstall.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ProfileDir,
    [string]$BundleId = 'dsh-idle-alert'
)

$ErrorActionPreference = 'Stop'

$pluginSrc = Split-Path -Parent $PSScriptRoot

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

if (-not $ProfileDir) { $ProfileDir = Resolve-ProfileDir -Explicit $null }
if (-not $ProfileDir) { throw '探测不到 DSH profile 目录，请用 -ProfileDir 显式指定。' }
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "profile 目录不存在：$ProfileDir" }

# 联接目标的原样比较会踩坑：跨进程读到的 Target 可能带 `Global\` 或 `\??\` 前缀，
# 尾部分隔符也不一致。统一规范化后再比，才认得出「这是本仓库的联接」。
function Normalize-LinkTarget {
    param([string]$Value)
    if (-not $Value) { return '' }
    $v = $Value -replace '^\\\\\?\?\\', ''
    $v = $v -replace '^Global\\', ''
    return $v.TrimEnd('\', '/')
}

$pkgJsonPath = Join-Path $ProfileDir 'package.json'
$linkPath = Join-Path (Join-Path $ProfileDir 'node_modules') $BundleId

Write-Host "profile：$ProfileDir"

# ---------------------------------------------------------------------------
# 1. 摘联接（只摘指向本仓库的那个）
# ---------------------------------------------------------------------------
if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    $targets = @($item.Target | ForEach-Object { Normalize-LinkTarget $_ })
    if ($item.LinkType -in @('Junction', 'SymbolicLink') -and
        ($targets -contains (Normalize-LinkTarget $pluginSrc))) {
        if ($PSCmdlet.ShouldProcess($linkPath, '删除目录联接（不动源码）')) {
            # 目录联接用 Remove-Item 删除时不会跟着删目标内容；加 -Force 处理只读属性
            [IO.Directory]::Delete($linkPath, $false)
            Write-Host "[1/3] 已摘掉联接：$linkPath"
        }
    }
    else {
        Write-Warning "跳过：$linkPath 不是指向本仓库的联接（LinkType=$($item.LinkType)）"
    }
}
else {
    Write-Host "[1/3] 联接不存在，跳过：$linkPath"
}

# ---------------------------------------------------------------------------
# 2. 从 profile\package.json 里移除条目
# ---------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $pkgJsonPath)) { throw "profile 里没有 package.json：$pkgJsonPath" }

$bytes = [IO.File]::ReadAllBytes($pkgJsonPath)
$hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
$raw = [IO.File]::ReadAllText($pkgJsonPath, [Text.Encoding]::UTF8)
$orig = $raw

# 2a. dependencies 条目（整行，含前导缩进与可能的尾随逗号）
$rxDep = [regex]('[ \t]*"' + [regex]::Escape($BundleId) + '"\s*:\s*"[^"]*"\s*,?[ \t]*\r?\n')
$raw = $rxDep.Replace($raw, '', 1)

# 2b. bundles 数组里的条目（含可能的前后逗号与空白）
$rxBundle1 = [regex]('[ \t]*"' + [regex]::Escape($BundleId) + '"\s*,\s*\r?\n')
if ($rxBundle1.IsMatch($raw)) {
    $raw = $rxBundle1.Replace($raw, '', 1)
}
else {
    $rxBundle2 = [regex](',\s*\r?\n[ \t]*"' + [regex]::Escape($BundleId) + '"[ \t]*')
    $raw = $rxBundle2.Replace($raw, '', 1)
}

if ($raw -eq $orig) {
    Write-Host '[2/3] profile package.json 里没有该条目，跳过'
}
elseif ($PSCmdlet.ShouldProcess($pkgJsonPath, '移除 dependencies 与 dsh.profile.bundles 里的条目')) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    Copy-Item -LiteralPath $pkgJsonPath -Destination (Join-Path $ProfileDir "package.json.bak-$stamp") -Force
    [IO.File]::WriteAllText($pkgJsonPath, $raw, (New-Object Text.UTF8Encoding($hasBom)))
    Write-Host "[2/3] 已从 profile package.json 移除条目（备份 package.json.bak-$stamp）"
}

# ---------------------------------------------------------------------------
# 3. 验证
# ---------------------------------------------------------------------------
if ($WhatIfPreference) {
    Write-Host ''
    Write-Host 'WHATIF —— 未做任何改动。去掉 -WhatIf 即真正卸载。'
    return
}

try {
    $json = Get-Content -Raw -Encoding UTF8 $pkgJsonPath | ConvertFrom-Json
    $bundles = @($json.dsh.profile.bundles)
    Write-Host ('[3/3] bundles 解析结果: ' + ($bundles -join ' | '))
    if ($bundles -contains $BundleId) { throw "bundles 里仍有 $BundleId" }
    if ($json.dependencies.PSObject.Properties.Name -contains $BundleId) { throw "dependencies 里仍有 $BundleId" }
    Write-Host '      已确认移除干净'
}
catch {
    throw ("卸载后校验失败：" + $_.Exception.Message)
}
Write-Host ''
Write-Host 'UNINSTALLED —— 现在需要重启 DSH 桌面应用才会生效。'
