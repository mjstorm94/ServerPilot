/**
 * ServerPilot Monitor — Interactive Setup
 * 
 * Walks you through configuring the monitor with prompts.
 * Run: node setup-config.js
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function ask(question, defaultVal = '') {
    const suffix = defaultVal ? ` [${defaultVal}]` : '';
    return new Promise((resolve) => {
        rl.question(`  ${question}${suffix}: `, (answer) => {
            resolve(answer.trim() || defaultVal);
        });
    });
}

async function setup() {
    console.log('');
    console.log('\x1b[36m╔══════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[36m║     ServerPilot Monitor — Setup Wizard           ║\x1b[0m');
    console.log('\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m');
    console.log('');

    // Server settings
    console.log('\n--- Server Configuration ---');
    const host = await ask('Server hostname or IP', 'localhost');
    const port = await ask('Server port', '8444');
    const apiKey = await ask('API Key', '');

    console.log('');

    // Monitoring settings
    console.log('\x1b[33m  ⏱  Monitoring Settings\x1b[0m');
    const interval = await ask('Check interval (seconds)', '60');
    const threshold = await ask('Failure threshold (consecutive fails before alert)', '3');
    const cooldown = await ask('Alert cooldown (minutes between re-alerts)', '30');

    console.log('');

    // Email settings
    console.log('\x1b[33m  📧 Email Alerts\x1b[0m');
    const emailEnabled = (await ask('Enable email alerts? (yes/no)', 'yes')).toLowerCase() === 'yes';

    let emailConfig = {
        enabled: false,
        smtp: { host: '', port: 587, secure: false, auth: { user: '', pass: '' } },
        from: '',
        to: [],
        sendRecoveryAlerts: true,
    };

    if (emailEnabled) {
        console.log('');
        console.log('  \x1b[90mCommon SMTP hosts:\x1b[0m');
        console.log('  \x1b[90m  Gmail:    smtp.gmail.com (port 587, use App Password)\x1b[0m');
        console.log('  \x1b[90m  Outlook:  smtp-mail.outlook.com (port 587)\x1b[0m');
        console.log('  \x1b[90m  Yahoo:    smtp.mail.yahoo.com (port 587)\x1b[0m');
        console.log('');

        const smtpHost = await ask('SMTP host', 'smtp.gmail.com');
        const smtpPort = await ask('SMTP port', '587');
        const smtpUser = await ask('SMTP username (email)');
        const smtpPass = await ask('SMTP password (or app password)');
        const toEmail = await ask('Send alerts to (email)', smtpUser);
        const recovery = (await ask('Send recovery alerts too? (yes/no)', 'yes')).toLowerCase() === 'yes';

        emailConfig = {
            enabled: true,
            smtp: {
                host: smtpHost,
                port: parseInt(smtpPort),
                secure: parseInt(smtpPort) === 465,
                auth: { user: smtpUser, pass: smtpPass },
            },
            from: `ServerPilot Monitor <${smtpUser}>`,
            to: [toEmail],
            sendRecoveryAlerts: recovery,
        };
    }

    const config = {
        server: {
            host,
            port: parseInt(port),
            apiKey,
        },
        monitoring: {
            checkIntervalSeconds: parseInt(interval),
            failureThreshold: parseInt(threshold),
            cooldownMinutes: parseInt(cooldown),
            timeoutSeconds: 10,
        },
        email: emailConfig,
        logging: {
            file: 'monitor.log',
            maxSizeMB: 10,
            verbose: false,
        },
    };

    const configPath = path.join(__dirname, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4));

    console.log('');
    console.log('\x1b[32m  ✅ Configuration saved to config.json\x1b[0m');
    console.log('');
    console.log('  To start monitoring, run:');
    console.log('  \x1b[36m  npm start\x1b[0m');
    console.log('');

    rl.close();
}

setup().catch((error) => {
    console.error('Setup error:', error.message);
    rl.close();
    process.exit(1);
});
