import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CONFIG_DIRECTORY = 'sillyagent';
const CONFIG_FILENAME = 'reflection-provider.json';
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    endpoint: '',
    model: '',
    secretKey: 'none',
});

export const REFLECTION_SECRET_OPTIONS = [
    'none',
    'api_key_openai',
    'api_key_custom',
    'api_key_openrouter',
    'api_key_groq',
    'api_key_deepseek',
    'api_key_mistralai',
    'api_key_moonshot',
    'api_key_xai',
    'api_key_fireworks',
    'api_key_chutes',
    'api_key_llamacpp',
    'api_key_koboldcpp',
    'api_key_ooba',
    'api_key_vllm',
    'api_key_tabby',
    'api_key_aphrodite',
];

/**
 * Read the active SillyTavern secret without importing the Express Secrets
 * endpoint (which expects app configuration to have been bootstrapped).
 * The on-disk format matches SecretManager.readSecret: each key maps to a
 * list of { id, value, active, label } entries.
 * @param {object} directories SillyTavern user directories.
 * @param {string} key Secret key identifier.
 * @returns {string} The active secret value, or an empty string.
 */
function readStoredSecret(directories, key) {
    const root = directories?.root;
    if (typeof root !== 'string' || !root.trim()) throw new TypeError('A user data directory is required to read the active secret.');
    const filename = path.join(root, 'secrets.json');
    let info;
    try {
        info = fs.lstatSync(filename);
    } catch (error) {
        if (error?.code === 'ENOENT') return '';
        throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error('SillyTavern secrets file must be a regular file.');
    }
    const secrets = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const entries = secrets?.[key];
    if (!Array.isArray(entries)) return '';
    const active = entries.find(entry => entry?.active === true);
    return typeof active?.value === 'string' ? active.value : '';
}

function configPath(root) {
    if (typeof root !== 'string' || !root.trim()) {
        throw new TypeError('A user data directory is required for reflection settings.');
    }
    return path.join(path.resolve(root), CONFIG_DIRECTORY, CONFIG_FILENAME);
}

function validateConfig(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError('Reflection provider settings must be an object.');
    }
    const enabled = input.enabled === true;
    const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
    const model = typeof input.model === 'string' ? input.model.trim() : '';
    const secretKey = typeof input.secretKey === 'string' ? input.secretKey : 'none';

    if (endpoint.length > 2048) throw new TypeError('Reflection endpoint must be at most 2048 characters.');
    if (model.length > 200) throw new TypeError('Reflection model must be at most 200 characters.');
    if (!REFLECTION_SECRET_OPTIONS.includes(secretKey)) throw new TypeError('Unsupported reflection credential key.');

    if (endpoint) {
        let parsed;
        try {
            parsed = new URL(endpoint);
        } catch {
            throw new TypeError('Reflection endpoint must be a complete URL ending at an OpenAI-compatible chat completions endpoint.');
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
            throw new TypeError('Reflection endpoint must use HTTP or HTTPS and must not include embedded credentials, query parameters, or a fragment.');
        }
        const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
        const isLoopback = hostname === 'localhost'
            || hostname.endsWith('.localhost')
            || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
            || hostname === '[::1]';
        if (parsed.protocol === 'http:' && !isLoopback) {
            throw new TypeError('Non-loopback reflection endpoints must use HTTPS to protect prompts and credentials in transit.');
        }
        if (!/\/chat\/completions\/?$/iu.test(parsed.pathname)) {
            throw new TypeError('Reflection endpoint path must end in /chat/completions.');
        }
    }
    if (enabled && (!endpoint || !model)) {
        throw new TypeError('Configure both the reflection endpoint and model before enabling background reflection.');
    }

    return { enabled, endpoint, model, secretKey };
}

function ensurePrivateDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') return;
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Reflection settings directory must be a real directory.');
    }
    fs.chmodSync(directory, 0o700);
}

export function loadReflectionProviderConfig(root) {
    const filename = configPath(root);
    try {
        const info = fs.lstatSync(filename);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error('Reflection settings file must not be a symbolic link.');
        }
        const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
        return validateConfig({ ...DEFAULT_CONFIG, ...parsed });
    } catch (error) {
        if (error?.code === 'ENOENT') return { ...DEFAULT_CONFIG };
        throw error;
    }
}

export function saveReflectionProviderConfig(root, input) {
    const filename = configPath(root);
    const directory = path.dirname(filename);
    ensurePrivateDirectory(directory);
    try {
        const info = fs.lstatSync(filename);
        if (info.isSymbolicLink() || !info.isFile()) {
            throw new Error('Reflection settings file must not be a symbolic link.');
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    const config = validateConfig(input);
    const temporaryPath = filename + '.' + randomUUID() + '.tmp';
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(config, null, 2), 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, filename);
        if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
    } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.rmSync(temporaryPath, { force: true }); } catch { /* Best-effort temporary file cleanup. */ }
    }
    return config;
}

export function getReflectionProviderState(directories) {
    const config = loadReflectionProviderConfig(directories?.root);
    const credentialAvailable = config.secretKey === 'none'
        || Boolean(readStoredSecret(directories, config.secretKey));
    return { ...config, credentialAvailable, configured: Boolean(config.endpoint && config.model) };
}

/**
 * Call an explicitly configured OpenAI-compatible endpoint. Credentials are
 * loaded from SillyTavern's server-side secrets store and never serialized into
 * job data or returned to the browser.
 * @param {object} options Provider options.
 * @param {object} options.directories User data directories.
 * @param {object} options.config Validated provider configuration.
 * @param {object[]} options.messages Chat messages for structured reflection.
 * @returns {Promise<string>} Assistant response content.
 */
export async function requestReflectionCompletion({ directories, config, messages }) {
    const validated = validateConfig({ ...config, enabled: true });
    const apiKey = validated.secretKey === 'none' ? '' : readStoredSecret(directories, validated.secretKey);
    if (validated.secretKey !== 'none' && !apiKey) {
        throw new Error('The selected SillyTavern secret is not configured. Choose a credential key with an active secret or select no authentication.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
        const response = await fetch(validated.endpoint, {
            method: 'POST',
            headers,
            redirect: 'error',
            signal: controller.signal,
            body: JSON.stringify({
                model: validated.model,
                messages,
                temperature: 0.2,
                max_tokens: 1800,
            }),
        });
        const body = await response.text();
        if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
            throw new Error('Reflection provider response exceeded 256 KiB.');
        }
        if (!response.ok) throw new Error('Reflection provider returned HTTP ' + response.status + '.');
        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            throw new Error('Reflection provider returned invalid JSON.');
        }
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('Reflection provider returned no assistant content.');
        }
        return content.trim();
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Reflection provider request timed out after 45 seconds.');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
