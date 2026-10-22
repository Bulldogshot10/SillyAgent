import { performance } from 'node:perf_hooks';

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/;
const TOOLSET_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const PERMISSIONS = new Set(['read', 'write', 'external']);
const SCHEMA_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_SCHEMA_DEPTH = 8;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function validateSchemaDefinition(schema, depth = 0) {
    if (!isPlainObject(schema) || depth > MAX_SCHEMA_DEPTH) {
        throw new TypeError('Tool input schema must be a JSON Schema object.');
    }

    if (!SCHEMA_TYPES.has(schema.type)) {
        throw new TypeError(`Unsupported or missing schema type: ${String(schema.type)}`);
    }

    if (schema.type === 'object') {
        if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
            throw new TypeError('Object schema properties must be an object.');
        }

        const properties = schema.properties ?? {};
        const required = schema.required ?? [];
        if (!Array.isArray(required) || required.some(name => typeof name !== 'string')) {
            throw new TypeError('Object schema required must be an array of property names.');
        }

        if (new Set(required).size !== required.length || required.some(name => !(name in properties))) {
            throw new TypeError('Object schema required entries must be unique declared properties.');
        }

        for (const child of Object.values(properties)) {
            validateSchemaDefinition(child, depth + 1);
        }
    }

    if (schema.type === 'array' && schema.items !== undefined) {
        validateSchemaDefinition(schema.items, depth + 1);
    }

    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
        if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || schema[key] < 0)) {
            throw new TypeError(`Schema keyword ${key} must be a non-negative finite number.`);
        }
    }

    if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
        throw new TypeError('Schema minimum cannot be greater than maximum.');
    }

    if (schema.minLength !== undefined && schema.maxLength !== undefined && schema.minLength > schema.maxLength) {
        throw new TypeError('Schema minLength cannot be greater than maxLength.');
    }

    if (schema.minItems !== undefined && schema.maxItems !== undefined && schema.minItems > schema.maxItems) {
        throw new TypeError('Schema minItems cannot be greater than maxItems.');
    }

    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
        throw new TypeError('Schema enum must be a non-empty array.');
    }
}

/**
 * Validate a value against the deliberately small JSON Schema subset used by built-in tools.
 * @param {object} schema The input schema.
 * @param {*} value The value to validate.
 * @param {string} path Current property path.
 * @param {number} depth Current recursive depth.
 * @returns {string|null} An error message or null when valid.
 */
function validateValue(schema, value, path = '$', depth = 0) {
    if (depth > MAX_SCHEMA_DEPTH) {
        return `${path} exceeds the maximum schema depth.`;
    }

    switch (schema.type) {
        case 'object': {
            if (!isPlainObject(value)) return `${path} must be an object.`;
            const properties = schema.properties ?? {};
            const required = schema.required ?? [];

            for (const key of required) {
                if (!Object.hasOwn(value, key)) return `${path}.${key} is required.`;
            }

            for (const [key, item] of Object.entries(value)) {
                if (!Object.hasOwn(properties, key)) {
                    if (schema.additionalProperties === true) continue;
                    return `${path}.${key} is not allowed.`;
                }

                const error = validateValue(properties[key], item, `${path}.${key}`, depth + 1);
                if (error) return error;
            }
            return null;
        }
        case 'string':
            if (typeof value !== 'string') return `${path} must be a string.`;
            if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short.`;
            if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long.`;
            break;
        case 'integer':
            if (!Number.isInteger(value)) return `${path} must be an integer.`;
            if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below the minimum.`;
            if (schema.maximum !== undefined && value > schema.maximum) return `${path} exceeds the maximum.`;
            break;
        case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a finite number.`;
            if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below the minimum.`;
            if (schema.maximum !== undefined && value > schema.maximum) return `${path} exceeds the maximum.`;
            break;
        case 'boolean':
            if (typeof value !== 'boolean') return `${path} must be a boolean.`;
            break;
        case 'array':
            if (!Array.isArray(value)) return `${path} must be an array.`;
            if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} has too few items.`;
            if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} has too many items.`;
            if (schema.items) {
                for (let index = 0; index < value.length; index++) {
                    const error = validateValue(schema.items, value[index], `${path}[${index}]`, depth + 1);
                    if (error) return error;
                }
            }
            break;
        default:
            return `${path} uses an unsupported schema type.`;
    }

    if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) {
        return `${path} must match one of the allowed values.`;
    }

    return null;
}

function errorResult(name, code, message, durationMs = 0) {
    return {
        ok: false,
        name,
        error: { code, message },
        durationMs: Math.max(0, Math.round(durationMs)),
    };
}

/**
 * Minimal in-process tool registry for the SillyAgent harness.
 * Tool handlers are trusted application code; callers can only select registered tools.
 */
export class ToolRegistry {
    #tools = new Map();

    /**
     * Register a trusted built-in tool.
     * @param {object} definition Tool metadata and handler.
     */
    registerTool(definition) {
        const { name, description, inputSchema, execute } = definition ?? {};
        const toolset = definition?.toolset ?? 'core';
        const permission = definition?.permission ?? 'read';
        const enabled = definition?.enabled ?? true;
        const timeoutMs = definition?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name)) {
            throw new TypeError('Tool names must be 2-64 characters and use lowercase letters, numbers, dots, underscores, or hyphens.');
        }
        if (this.#tools.has(name)) {
            throw new Error(`Tool "${name}" is already registered.`);
        }
        if (typeof description !== 'string' || description.trim().length === 0 || description.length > 1000) {
            throw new TypeError('Tool description must contain between 1 and 1000 characters.');
        }
        if (!TOOLSET_PATTERN.test(toolset)) {
            throw new TypeError('Toolset names must be 1-32 lowercase letters, numbers, underscores, or hyphens.');
        }
        if (!PERMISSIONS.has(permission)) {
            throw new TypeError(`Unsupported tool permission: ${String(permission)}`);
        }
        if (typeof enabled !== 'boolean') {
            throw new TypeError('Tool enabled must be a boolean.');
        }
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
            throw new TypeError(`Tool timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
        }
        if (typeof execute !== 'function') {
            throw new TypeError('Tool execute must be a function.');
        }

        validateSchemaDefinition(inputSchema);
        if (inputSchema.type !== 'object') {
            throw new TypeError('Tool input schema root must have type "object".');
        }

        this.#tools.set(name, {
            name,
            description: description.trim(),
            inputSchema: cloneJson(inputSchema),
            toolset,
            permission,
            enabled,
            timeoutMs,
            execute,
        });
    }

    hasTool(name) {
        return this.#tools.has(name);
    }

    /**
     * List tools without exposing executable handlers.
     * @param {object} options Filtering options.
     * @returns {object[]} Public tool descriptors.
     */
    listTools({ toolsets, includeDisabled = false } = {}) {
        const allowedToolsets = toolsets ? new Set(toolsets) : null;

        return [...this.#tools.values()]
            .filter(tool => includeDisabled || tool.enabled)
            .filter(tool => !allowedToolsets || allowedToolsets.has(tool.toolset))
            .map(({ name, description, inputSchema, toolset, permission, enabled, timeoutMs }) => ({
                name,
                description,
                inputSchema: cloneJson(inputSchema),
                toolset,
                permission,
                enabled,
                timeoutMs,
            }));
    }

    /**
     * Return tool definitions in OpenAI-compatible function-calling format.
     * @param {object} options Filtering options.
     * @returns {object[]} Function definitions.
     */
    getFunctionDefinitions(options = {}) {
        return this.listTools(options).map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
            },
        }));
    }

    /**
     * Execute a registered tool after validating its input and permission policy.
     * @param {string} name Registered tool name.
     * @param {*} input Tool input.
     * @param {object} options Execution options.
     * @returns {Promise<object>} JSON-safe result envelope.
     */
    async executeTool(name, input, {
        context = {},
        allowedToolsets,
        allowedWriteToolsets,
        allowWrites = false,
        allowExternal = false,
    } = {}) {
        const startedAt = performance.now();
        const tool = this.#tools.get(name);

        if (!tool) return errorResult(name, 'unknown_tool', 'No tool with that name is registered.');
        if (!tool.enabled) return errorResult(name, 'tool_disabled', 'This tool is disabled.');
        if (allowedToolsets && !new Set(allowedToolsets).has(tool.toolset)) {
            return errorResult(name, 'toolset_not_allowed', 'This toolset is not allowed for the current request.');
        }
        if (tool.permission === 'write' && !allowWrites) {
            return errorResult(name, 'permission_denied', 'This tool requires write permission.');
        }
        if (tool.permission === 'write' && allowedWriteToolsets && !new Set(allowedWriteToolsets).has(tool.toolset)) {
            return errorResult(name, 'permission_denied', 'This toolset does not have write permission for the current request.');
        }
        if (tool.permission === 'external' && !allowExternal) {
            return errorResult(name, 'permission_denied', 'This tool requires external-access permission.');
        }

        const validationError = validateValue(tool.inputSchema, input);
        if (validationError) return errorResult(name, 'invalid_input', validationError);

        let safeInput;
        try {
            safeInput = cloneJson(input);
        } catch {
            return errorResult(name, 'invalid_input', 'Tool input must be JSON-serializable.');
        }

        const controller = new AbortController();
        let timeoutId;
        try {
            const timeout = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    controller.abort();
                    const error = new Error(`Tool execution exceeded ${tool.timeoutMs} milliseconds.`);
                    error.code = 'tool_timeout';
                    reject(error);
                }, tool.timeoutMs);
            });

            const resultPromise = Promise.resolve().then(() => tool.execute({
                input: safeInput,
                context,
                signal: controller.signal,
            }));
            const rawResult = await Promise.race([resultPromise, timeout]);
            const serialized = JSON.stringify(rawResult);

            if (typeof serialized !== 'string') {
                return errorResult(name, 'invalid_result', 'Tool returned a value that cannot be represented as JSON.', performance.now() - startedAt);
            }
            if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) {
                return errorResult(name, 'result_too_large', `Tool results must be ${MAX_RESULT_BYTES} bytes or smaller.`, performance.now() - startedAt);
            }

            return {
                ok: true,
                name,
                result: JSON.parse(serialized),
                durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            };
        } catch (error) {
            const code = ['tool_timeout', 'state_conflict'].includes(error?.code) ? error.code : 'tool_failed';
            const message = code === 'tool_timeout' || code === 'state_conflict'
                ? error.message
                : 'Tool execution failed.';
            return errorResult(name, code, message, performance.now() - startedAt);
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

export const toolRegistry = new ToolRegistry();
