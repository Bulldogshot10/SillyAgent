import express from 'express';

const MAX_AGENT_TOOLS_REQUEST_BYTES = 16 * 1024;
const parseAgentToolsJson = express.json({ limit: MAX_AGENT_TOOLS_REQUEST_BYTES });

/**
 * Bound the body before the application's general-purpose large JSON parser.
 * The agent-tools API accepts JSON requests only when a body is present.
 * @param {import('express').Request} request Express request.
 * @param {import('express').Response} response Express response.
 * @param {import('express').NextFunction} next Express next callback.
 */
export function agentToolsBodyLimit(request, response, next) {
    const contentLength = request.headers['content-length'];
    const hasBody = (contentLength !== undefined && contentLength !== '0')
        || request.headers['transfer-encoding'] !== undefined;

    if (!hasBody) return next();

    if (!request.is('application/json')) {
        return response.status(415).json({
            ok: false,
            error: {
                code: 'unsupported_media_type',
                message: 'Agent tools requests with a body must use application/json.',
            },
        });
    }

    return parseAgentToolsJson(request, response, error => {
        if (!error) return next();

        if (error.type === 'entity.too.large') {
            return response.status(413).json({
                ok: false,
                error: {
                    code: 'request_too_large',
                    message: 'Tool requests must be 16 KiB or smaller.',
                },
            });
        }

        if (error.type === 'entity.parse.failed') {
            return response.status(400).json({
                ok: false,
                error: {
                    code: 'invalid_request',
                    message: 'Request body must be valid JSON.',
                },
            });
        }

        return next(error);
    });
}
