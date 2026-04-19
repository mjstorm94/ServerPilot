#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Automated Installer for the ServerPilot Agent.
.DESCRIPTION
    This script downloads the latest ServerPilot Agent directly from GitHub, 
    generates a secure API key, creates a self-signed SSL certificate, configures 
    Windows Firewall, and sets up a scheduled task to run the agent persistently 
    in the background.
.NOTES
    Run this script as Administrator.
#>

param(
    [string]$InstallPath = "C:\ServerPilot",
    [int]$Port = 8444,
    [string]$GitHubRawUrl = "https://raw.githubusercontent.com/mjstorm94/ServerPilot/master/server-agent/ServerManagerAgent.ps1"
)

$ErrorActionPreference = "Stop"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  ServerPilot Agent Automated Installer"      -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# --- 1. Create installation directory ---
Write-Host "[1/6] Setting up installation directory..." -ForegroundColor Yellow
if (-not (Test-Path $InstallPath)) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
}
Write-Host "  -> $InstallPath" -ForegroundColor Green

# --- 2. Download latest agent from GitHub ---
Write-Host "[2/6] Downloading latest agent from GitHub..." -ForegroundColor Yellow
$agentPath = Join-Path $InstallPath "ServerManagerAgent.ps1"

# Force TLS 1.2 for GitHub download
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
    Invoke-WebRequest -Uri $GitHubRawUrl -OutFile $agentPath -UseBasicParsing
    Write-Host "  -> Download successful." -ForegroundColor Green
} catch {
    Write-Error "Failed to download agent script: $_"
    exit
}

# --- 3. Generate API Key & Config ---
Write-Host "[3/6] Generating secure API key..." -ForegroundColor Yellow
if (-not (Test-Path "$InstallPath\config.json")) {
    $apiKeyBytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::Create()
    $rng.GetBytes($apiKeyBytes)
    $apiKey = [Convert]::ToBase64String($apiKeyBytes).Replace("+", "").Replace("/", "").Replace("=", "")
    
    $config = @{
        Port          = $Port
        ApiKey        = $apiKey
        AllowedOrigins = @("*")
    } | ConvertTo-Json -Depth 3

    $config | Out-File "$InstallPath\config.json" -Encoding UTF8
    Write-Host "  -> API Key generated and saved to config" -ForegroundColor Green
} else {
    $existingConfig = Get-Content "$InstallPath\config.json" | ConvertFrom-Json
    $apiKey = $existingConfig.ApiKey
    Write-Host "  -> Using existing API key from config" -ForegroundColor Green
}

# --- 4. Setup SSL Certificate & Port Binding ---
Write-Host "[4/6] Setting up SSL certificate..." -ForegroundColor Yellow
$certExists = Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -match "ServerPilotAgent" }
if (-not $certExists) {
    $hostname = [System.Net.Dns]::GetHostName()
    $cert = New-SelfSignedCertificate `
        -DnsName $hostname, "localhost" `
        -CertStoreLocation "Cert:\LocalMachine\My" `
        -FriendlyName "ServerPilotAgent" `
        -NotAfter (Get-Date).AddYears(5)
    $thumbprint = $cert.Thumbprint
    Write-Host "  -> Certificate created: $thumbprint" -ForegroundColor Green
} else {
    $thumbprint = $certExists[0].Thumbprint
    Write-Host "  -> Using existing certificate: $thumbprint" -ForegroundColor Green
}

$existingBinding = netsh http show sslcert ipport=0.0.0.0:$Port 2>&1
if ($existingBinding -match "Hash") {
    netsh http delete sslcert ipport=0.0.0.0:$Port | Out-Null
}
$appId = "{00000000-0000-0000-0000-000000000000}"
netsh http add sslcert ipport=0.0.0.0:$Port certhash=$thumbprint appid=$appId | Out-Null
Write-Host "  -> SSL bound to port $Port" -ForegroundColor Green

# Register URL Prefix just in case
$existingUrl = netsh http show urlacl url=https://+:$Port/ 2>&1
if ($existingUrl -notmatch "Reserved URL") {
    netsh http add urlacl url=https://+:$Port/ user="NT AUTHORITY\LOCAL SERVICE" | Out-Null
}

# --- 5. Configure Windows Firewall ---
Write-Host "[5/6] Configuring Windows Firewall..." -ForegroundColor Yellow
$fwRule = Get-NetFirewallRule -DisplayName "ServerPilot Agent" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    New-NetFirewallRule `
        -DisplayName "ServerPilot Agent" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort $Port `
        -Action Allow `
        -Profile Any | Out-Null
    Write-Host "  -> Firewall rule created" -ForegroundColor Green
} else {
    Write-Host "  -> Firewall rule already exists" -ForegroundColor Green
}

# --- 6. Set up Scheduled Task ---
Write-Host "[6/6] Setting up Scheduled Task..." -ForegroundColor Yellow
$taskName = "ServerPilotAgent"

# Remove existing task if it exists
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$agentPath`""
$triggerStartup = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggerStartup -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "  -> Scheduled task '$taskName' created and started." -ForegroundColor Green

# --- Summary ---
$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" }).IPAddress

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "The ServerPilot Agent is now running securely in the background."
Write-Host ""
Write-Host "Add this server to your dashboard using the following details:"
Write-Host "  Addresses: " -NoNewline
Write-Host ($ips -join ", ") -ForegroundColor Yellow
Write-Host "  Port:      " -NoNewline
Write-Host $Port -ForegroundColor Yellow
Write-Host "  API Key:   " -NoNewline
Write-Host $apiKey -ForegroundColor Yellow
Write-Host ""
Write-Host "Note: Since this uses a self-signed certificate, you may need to navigate to"
Write-Host "https://$($ips[0]):$Port in your browser first and accept the security warning"
Write-Host "before the dashboard can connect successfully."
Write-Host ""
