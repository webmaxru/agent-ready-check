$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$scriptPath = Join-Path $PSScriptRoot '../../infra/deploy.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path $scriptPath), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors -join "`n") }
$helper = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Az'
}, $true)
. ([scriptblock]::Create($helper.Extent.Text))

function az {
  Write-Error 'CLI warning on stderr'
  '{"value":"ok"}'
  $global:LASTEXITCODE = 0
}
$result = Invoke-Az @('deployment', 'group') 3>$null | ConvertFrom-Json
if ($result.value -ne 'ok') { throw 'CLI warnings corrupted JSON stdout' }

function az {
  Write-Error 'Azure rejected the deployment'
  $global:LASTEXITCODE = 1
}
$caught = $false
try { Invoke-Az @('deployment', 'group') } catch {
  $caught = $true
  if ($_.Exception.Message -notmatch 'Azure rejected the deployment') { throw }
}
if (-not $caught) { throw 'A failed Azure command did not throw' }
$global:LASTEXITCODE = 0
'Deployment helper tests passed'
