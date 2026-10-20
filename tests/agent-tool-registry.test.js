import { describe, test, expect } from '@jest/globals';

import { ToolRegistry } from '../src/agent/tool-registry.js';
import { registerBuiltinTools } from '../src/agent/builtin-tools.js';

const objectSchema = {
    type: 'object',
    properties: {
        value: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['value'],
    additionalProperties: false,
};

describe('ToolRegistry', () => {
    test('registers and lists tools without exposing handlers', () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            name: 'test.echo',
            description: 'Return the supplied value.',
            inputSchema: objectSchema,
            execute: async ({ input }) => input,
        });

        const tools = registry.getFunctionDefinitions();
        expect(tools).toHaveLength(1);
        expect(tools[0].function.name).toBe('test.echo');
        expect(tools[0].function.parameters).toEqual(objectSchema);
        expect(tools[0].execute).toBeUndefined();
    });

    test('rejects invalid names, duplicates and malformed schemas', () => {
        const registry = new ToolRegistry();
        const base = {
            name: 'test.echo',
            description: 'Return the supplied value.',
            inputSchema: objectSchema,
            execute: async () => ({}),
        };

        expect(() => registry.registerTool({ ...base, name: 'Bad Name' })).toThrow();
        registry.registerTool(base);
        expect(() => registry.registerTool(base)).toThrow(/already registered/);
        expect(() => registry.registerTool({ ...base, name: 'test.bad', inputSchema: { type: 'missing' } })).toThrow();
    });

    test('filters toolsets and disabled tools', () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            name: 'test.read',
            description: 'Read a test value.',
            toolset: 'core',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => 'read',
        });
        registry.registerTool({
            name: 'test.disabled',
            description: 'Disabled test tool.',
            toolset: 'roleplay',
            enabled: false,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => 'disabled',
        });

        expect(registry.listTools({ toolsets: ['core'] })).toHaveLength(1);
        expect(registry.listTools()).toHaveLength(1);
        expect(registry.listTools({ includeDisabled: true })).toHaveLength(2);
    });

    test('validates required properties, types, ranges and unknown properties', async () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            name: 'test.echo',
            description: 'Return the supplied value.',
            inputSchema: objectSchema,
            execute: async ({ input }) => input,
        });

        expect((await registry.executeTool('test.echo', { value: 3 })).ok).toBe(true);
        expect((await registry.executeTool('test.echo', {})).error.code).toBe('invalid_input');
        expect((await registry.executeTool('test.echo', { value: 6 })).error.code).toBe('invalid_input');
        expect((await registry.executeTool('test.echo', { value: 3, extra: true })).error.code).toBe('invalid_input');
    });

    test('requires explicit permission for write and external tools', async () => {
        const registry = new ToolRegistry();
        const definition = {
            name: 'test.write',
            description: 'A test write operation.',
            permission: 'write',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => ({ changed: true }),
        };
        registry.registerTool(definition);
        expect((await registry.executeTool('test.write', {})).error.code).toBe('permission_denied');
        expect((await registry.executeTool('test.write', {}, { allowWrites: true })).ok).toBe(true);
    });

    test('rejects unknown tools and disallowed toolsets', async () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            name: 'test.echo',
            description: 'Return the supplied value.',
            inputSchema: objectSchema,
            execute: async ({ input }) => input,
        });

        expect((await registry.executeTool('test.missing', {})).error.code).toBe('unknown_tool');
        expect((await registry.executeTool('test.echo', { value: 2 }, { allowedToolsets: ['external'] })).error.code).toBe('toolset_not_allowed');
    });

    test('times out long-running tools and aborts the handler signal', async () => {
        const registry = new ToolRegistry();
        let aborted = false;
        registry.registerTool({
            name: 'test.slow',
            description: 'A deliberately slow test tool.',
            timeoutMs: 10,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: async ({ signal }) => {
                signal.addEventListener('abort', () => { aborted = true; }, { once: true });
                await new Promise(resolve => setTimeout(resolve, 50));
                return { late: true };
            },
        });

        const result = await registry.executeTool('test.slow', {});
        expect(result.error.code).toBe('tool_timeout');
        expect(aborted).toBe(true);
    });

    test('limits serialized tool results', async () => {
        const registry = new ToolRegistry();
        registry.registerTool({
            name: 'test.large',
            description: 'Return a deliberately large result.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => ({ text: 'x'.repeat(40 * 1024) }),
        });

        expect((await registry.executeTool('test.large', {})).error.code).toBe('result_too_large');
    });

    test('rolls dice within the requested range and returns the total', async () => {
        const registry = new ToolRegistry();
        registerBuiltinTools(registry);

        const result = await registry.executeTool('roleplay_roll_dice', { count: 4, sides: 6 });
        expect(result.ok).toBe(true);
        expect(result.result.rolls).toHaveLength(4);
        expect(result.result.rolls.every(roll => roll >= 1 && roll <= 6)).toBe(true);
        expect(result.result.total).toBe(result.result.rolls.reduce((sum, roll) => sum + roll, 0));
        expect((await registry.executeTool('roleplay_roll_dice', { count: 21, sides: 6 })).error.code).toBe('invalid_input');
    });
    test('restricts write access to explicitly allowed toolsets', async () => {
        const registry = new ToolRegistry();
        const base = {
            description: 'A test write operation.',
            permission: 'write',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => ({ changed: true }),
        };
        registry.registerTool({ ...base, name: 'test.memory_write', toolset: 'memory' });
        registry.registerTool({ ...base, name: 'test.skill_write', toolset: 'skills' });

        expect((await registry.executeTool('test.memory_write', {}, {
            allowWrites: true,
            allowedWriteToolsets: ['skills'],
        })).error.code).toBe('permission_denied');
        expect((await registry.executeTool('test.skill_write', {}, {
            allowWrites: true,
            allowedWriteToolsets: ['skills'],
        })).ok).toBe(true);
    });

});
