import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = name => readFileSync(resolve(root, name), 'utf8');
const failures = [];

function requireText(file, text, reason = `missing required text: ${text}`) {
    if (!read(file).includes(text)) failures.push(`${file}: ${reason}`);
}

function requireRegex(file, regex, reason) {
    if (!regex.test(read(file))) failures.push(`${file}: ${reason}`);
}

const license = read('LICENSE');
const notice = read('NOTICE');
const readme = read('README.md');
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const thirdParty = read('THIRD_PARTY_NOTICES.md');
const indexHtml = read('public/index.html');

if (!license.includes('GNU AFFERO GENERAL PUBLIC LICENSE') || !license.includes('Version 3')) {
    failures.push('LICENSE: expected the full GNU AGPL version 3 text');
}
if (packageJson.license !== 'AGPL-3.0') {
    failures.push('package.json: license must remain AGPL-3.0');
}
requireText('NOTICE', 'https://github.com/SillyTavern/SillyTavern', 'upstream SillyTavern attribution is missing');
requireText('NOTICE', 'AGPL-3.0', 'the project license is not identified in NOTICE');
requireText('NOTICE', 'docs/fork-changes.md', 'the fork change inventory is not linked in NOTICE');
requireText('NOTICE', 'corresponding source code at no charge', 'the network source-code offer is not documented');
requireRegex('NOTICE', /Modification notice date: \d{4}-\d{2}-\d{2}/, 'a dated modification notice is required');
requireText('README.md', '[LICENSE](LICENSE)', 'README must link to LICENSE');
requireText('README.md', '[NOTICE](NOTICE)', 'README must link to NOTICE');
requireText('README.md', '[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)', 'README must link to third-party notices');
requireText('README.md', 'docs/fork-changes.md', 'README must link to the fork change inventory');
requireText('public/index.html', 'id="sillyagent-license-notice"', 'the application UI must expose its legal notice');
requireRegex('public/index.html', /href="https:\/\/github\.com\/Bulldogshot10\/SillyAgent\/archive\/refs\/heads\/[^"]+\.zip"[^>]*>Download source code \(ZIP\)<\/a>/, 'the UI must offer a direct free source ZIP download');
requireText('public/index.html', 'may be conveyed under those terms', 'the UI must explain the permission to convey the work under AGPL-3.0');
requireText('public/index.html', 'without warranty', 'the UI must state the no-warranty notice');
requireText('public/index.html', 'AGPL-3.0 license', 'the UI must link to the license');
requireText('public/index.html', 'Modification notice', 'the UI must link to the dated modification notice');
requireText('public/index.html', 'Third-party notices', 'the UI must link to third-party notices');

const inventorySection = thirdParty.split('## Verification of license metadata omitted by package-lock')[0];
if (thirdParty.includes('Not declared in lockfile; inspect package license file')) {
    failures.push('THIRD_PARTY_NOTICES.md: unresolved package-lock license placeholders remain');
}
if (!thirdParty.includes('## Verification of license metadata omitted by package-lock')) {
    failures.push('THIRD_PARTY_NOTICES.md: upstream license verification evidence section is missing');
}
const inventory = new Map();
for (const line of inventorySection.split('\n')) {
    const match = line.match(/^\| `([^\`]+)` \| ([^|]+) \| (.+) \|$/);
    if (!match) continue;
    const [, packagePath, version, declaredLicense] = match;
    inventory.set(packagePath + '@' + version.trim(), declaredLicense.trim());
}

const missingLicenseEntries = [];
for (const [lockPath, pkg] of Object.entries(packageLock.packages ?? {})) {
    if (!lockPath.startsWith('node_modules/') || !pkg || typeof pkg !== 'object') continue;
    if (typeof pkg.license === 'string' && pkg.license.trim()) continue;

    const inventoryPath = lockPath.slice('node_modules/'.length);
    const key = inventoryPath + '@' + String(pkg.version ?? '');
    const licenseEntry = inventory.get(key);
    if (!licenseEntry || !licenseEntry.includes('(verified upstream; lockfile metadata omitted)')) {
        missingLicenseEntries.push(key);
    }
}
if (missingLicenseEntries.length) {
    failures.push('THIRD_PARTY_NOTICES.md: missing upstream-verified license entry for ' + missingLicenseEntries.join(', '));
}

const missingLicenseMetadataCount = Object.entries(packageLock.packages ?? {})
    .filter(([path, pkg]) => path.startsWith('node_modules/') && pkg && typeof pkg === 'object' &&
        !(typeof pkg.license === 'string' && pkg.license.trim())).length;

const menuStart = indexHtml.indexOf('<div id="options"');
const legalNoticePosition = indexHtml.indexOf('id="sillyagent-license-notice"', menuStart);
const firstOptionPosition = indexHtml.indexOf('<a id="option_close_chat"', menuStart);
if (legalNoticePosition < 0 || firstOptionPosition < 0 || legalNoticePosition > firstOptionPosition) {
    failures.push('public/index.html: the AGPL/source notice must appear before the first menu option');
}

const evidenceRows = thirdParty.split('\\n').filter(line =>
    /^\\| `[^\\`]+@\\S+` \\| (?:MIT|ISC|Apache-2\\.0|BSD-[0-9]-Clause) \\| \\[upstream\\/package license\\]\\(https?:\\/\\//.test(line));
if (evidenceRows.length < 40) {
    failures.push('THIRD_PARTY_NOTICES.md: expected evidence links for all 40 unique packages with omitted license metadata');
}

if (failures.length) {
    console.error('License/source notice check failed:');
    for (const failure of failures) console.error(' - ' + failure);
    process.exitCode = 1;
} else {
    console.log('License/source notice check passed; validated AGPL-3.0 notices and ' +
        missingLicenseMetadataCount +
        ' package-lock entries whose license metadata is absent.');
}
