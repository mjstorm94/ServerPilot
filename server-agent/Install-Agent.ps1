#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installs the Windows Server Manager Agent as a Windows Service.
.DESCRIPTION
    This script sets up the PowerShell REST API agent, generates a self-signed
    SSL certificate, creates a config file, and registers the agent as a
    Windows service using NSSM (Non-Sucking Service Manager).
.NOTES
    Run this script as Administrator on the target Windows Server.
#>

param(
    [int]$Port = 8443,
    [string]$InstallPath = "C:\ServerManagerAgent",
    [switch]$GenerateApiKey
)

$ErrorActionPreference = "Stop"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Windows Server Manager Agent Installer"     -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# --- 1. Create installation directory ---
Write-Host "[1/6] Creating installation directory..." -ForegroundColor Yellow
if (-not (Test-Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
}
Write-Host "  -> $InstallPath" -ForegroundColor Green

# --- 2. Copy agent files ---
Write-Host "[2/6] Copying agent files..." -ForegroundColor Yellow
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item "$scriptDir\ServerManagerAgent.ps1" -Destination $InstallPath -Force
Copy-Item "$scriptDir\AgentModules\*" -Destination "$InstallPath\AgentModules" -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "  -> Files copied" -ForegroundColor Green

# --- 3. Generate API Key ---
Write-Host "[3/6] Generating API key..." -ForegroundColor Yellow
if ($GenerateApiKey -or -not (Test-Path "$InstallPath\config.json")) {
    $apiKey = -join ((65..90) + (97..122) + (48..57) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
    $config = @{
        Port          = $Port
        ApiKey        = $apiKey
        AllowedOrigins = @("*")
        LogPath       = "$InstallPath\logs"
        MaxLogSizeMB  = 50
    } | ConvertTo-Json -Depth 3

    $config | Out-File "$InstallPath\config.json" -Encoding UTF8
    Write-Host "  -> API Key: $apiKey" -ForegroundColor Magenta
    Write-Host "  -> SAVE THIS KEY! You will need it for the web dashboard." -ForegroundColor Red
} else {
    $existingConfig = Get-Content "$InstallPath\config.json" | ConvertFrom-Json
    $apiKey = $existingConfig.ApiKey
    Write-Host "  -> Using existing API key from config" -ForegroundColor Green
}

# --- 4. Create self-signed SSL certificate ---
Write-Host "[4/6] Setting up SSL certificate..." -ForegroundColor Yellow
$certExists = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -match "ServerManagerAgent" }
if (-not $certExists) {
    $cert = New-SelfSignedCertificate `
        -DnsName $env:COMPUTERNAME, "localhost" `
        -CertStoreLocation "Cert:\LocalMachine\My" `
        -FriendlyName "ServerManagerAgent" `
        -NotAfter (Get-Date).AddYears(5) `
        -KeyUsage DigitalSignature, KeyEncipherment `
        -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")
    $thumbprint = $cert.Thumbprint
    Write-Host "  -> Certificate created: $thumbprint" -ForegroundColor Green
} else {
    $thumbprint = $certExists[0].Thumbprint
    Write-Host "  -> Using existing certificate: $thumbprint" -ForegroundColor Green
}

# Bind certificate to port
$existingBinding = netsh http show sslcert ipport=0.0.0.0:$Port 2>&1
if ($existingBinding -match "Hash") {
    netsh http delete sslcert ipport=0.0.0.0:$Port | Out-Null
}
$appId = [Guid]::NewGuid().ToString()
netsh http add sslcert ipport=0.0.0.0:$Port certhash=$thumbprint appid="{$appId}" | Out-Null
Write-Host "  -> SSL bound to port $Port" -ForegroundColor Green

# --- 5. Register URL prefix ---
Write-Host "[5/6] Registering URL prefix..." -ForegroundColor Yellow
$existingUrl = netsh http show urlacl url=https://+:$Port/ 2>&1
if ($existingUrl -notmatch "Reserved URL") {
    netsh http add urlacl url=https://+:$Port/ user="NT AUTHORITY\LOCAL SERVICE" | Out-Null
}
Write-Host "  -> URL prefix registered" -ForegroundColor Green

# --- 6. Create Windows Firewall rule ---
Write-Host "[6/6] Configuring firewall..." -ForegroundColor Yellow
$fwRule = Get-NetFirewallRule -DisplayName "ServerManagerAgent" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    New-NetFirewallRule `
        -DisplayName "ServerManagerAgent" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort $Port `
        -Action Allow `
        -Profile Domain, Private | Out-Null
    Write-Host "  -> Firewall rule created" -ForegroundColor Green
} else {
    Write-Host "  -> Firewall rule already exists" -ForegroundColor Green
}

# --- Create logs directory ---
if (-not (Test-Path "$InstallPath\logs")) {
    New-Item -ItemType Directory -Path "$InstallPath\logs" -Force | Out-Null
}

# --- Summary ---
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Agent Path:  $InstallPath" -ForegroundColor White
Write-Host "  Port:        $Port" -ForegroundColor White
Write-Host "  API Key:     $apiKey" -ForegroundColor Magenta
Write-Host "  Config:      $InstallPath\config.json" -ForegroundColor White
Write-Host ""
Write-Host "  To start the agent manually:" -ForegroundColor Yellow
Write-Host "    powershell -ExecutionPolicy Bypass -File $InstallPath\ServerManagerAgent.ps1" -ForegroundColor White
Write-Host ""
Write-Host "  To install as a Windows Service (recommended):" -ForegroundColor Yellow
Write-Host "    Use NSSM: nssm install ServerManagerAgent powershell.exe -ExecutionPolicy Bypass -File $InstallPath\ServerManagerAgent.ps1" -ForegroundColor White
Write-Host ""
