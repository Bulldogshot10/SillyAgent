import express from 'express';

import { registerBuiltinTools } from '../agent/builtin-tools.js';
import { toolRegistry } from '../agent/tool-registry.js';

registerBuiltinTools();

export const router = express.Router();

const MAX_REQUEST_BYTES = 16 * 1024;

router.get('/', (_request, response) => {
    return response.json({
        tools: toolRegistry.getFunctionDefinitions({ toolsets: ['roleplay'] }),
    });
});

router.post('/execute', async (request, response) => {
    const body = request.body ?? {};
    let requestBytes;

    try {
        requestBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_request', message: 'Request body must be JSON-serializable.' },
        });
    }

    if (requestBytes > MAX_REQUEST_BYTES) {
        return response.status(413).json({
            ok: false,
            error: { code: 'request_too_large', message: 'Tool requests must be 16 KiB or smaller.' },
        });
    }

    if (typeof body.name !== 'string' || !Object.hasOwn(body, 'arguments')) {
        return response.status(400).json({
            ok: false,
            error: { code: 'invalid_request', message: 'Expected a tool name and an arguments object.' },
        });
    }

    const result = await toolRegistry.executeTool(body.name, body.arguments, {
        context: { source: 'agent-tools-api' },
    });

    if (result.ok) {
        return response.json(result);
    }

    const status = {
        invalid_input: 400,
        unknown_tool: 404,
        tool_disabled: 403,
        toolset_not_allowed: 403,
        permission_denied: 403,
        tool_timeout: 504,
        result_too_large: 500,
        invalid_result: 500,
        tool_failed: 500,
    }[result.error.code] ?? 500;

    return response.status(status).json(result);
});
