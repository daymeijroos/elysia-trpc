"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trpc = exports.compile = void 0;
const elysia_1 = require("elysia");
const server_1 = require("@trpc/server");
const fetch_1 = require("@trpc/server/adapters/fetch");
const observable_1 = require("@trpc/server/observable");
const utils_1 = require("./utils");
function compile(schema) {
    const check = (0, elysia_1.getSchemaValidator)(schema, {});
    if (!check)
        throw new Error('Invalid schema');
    return (value) => {
        if (check.Check(value))
            return value;
        const { path, message } = [...check.Errors(value)][0];
        throw new server_1.TRPCError({
            message: `${message} for ${path}`,
            code: 'BAD_REQUEST'
        });
    };
}
exports.compile = compile;
const getPath = (url) => {
    const start = url.indexOf('/', 9);
    const end = url.indexOf('?', start);
    if (end === -1)
        return url.slice(start);
    return url.slice(start, end);
};
const trpc = (router, { endpoint = '/trpc', ...options } = {
    endpoint: '/trpc'
}) => (eri) => {
    let app = eri
        .onParse(async ({ request: { url } }) => {
        if (getPath(url).startsWith(endpoint))
            return true;
    })
        .get(`${endpoint}/*`, async ({ query, request }) => {
        return (0, fetch_1.fetchRequestHandler)({
            ...options,
            req: request,
            router,
            endpoint
        });
    })
        .post(`${endpoint}/*`, async ({ query, request }) => {
        return (0, fetch_1.fetchRequestHandler)({
            ...options,
            req: request,
            router,
            endpoint
        });
    });
    const observers = new Map();
    app.ws(endpoint, {
        async message(ws, message) {
            const messages = Array.isArray(message)
                ? message
                : [message];
            let observer;
            for (const incoming of messages) {
                if (!incoming.method || !incoming.params) {
                    continue;
                }
                if (incoming.method === 'subscription.stop') {
                    observer?.unsubscribe();
                    observers.delete(ws.data.id.toString());
                    return void ws.send(JSON.stringify({
                        id: incoming.id,
                        jsonrpc: incoming.jsonrpc,
                        result: {
                            type: 'stopped'
                        }
                    }));
                }
                const result = await (0, server_1.callProcedure)({
                    procedures: router._def.procedures,
                    path: incoming.params.path,
                    rawInput: incoming.params.input?.json,
                    type: incoming.method,
                    ctx: {}
                });
                if (incoming.method !== 'subscription')
                    return void ws.send(JSON.stringify((0, utils_1.transformTRPCResponse)(router, {
                        id: incoming.id,
                        jsonrpc: incoming.jsonrpc,
                        result: {
                            type: 'data',
                            data: result
                        }
                    })));
                ws.send(JSON.stringify({
                    id: incoming.id,
                    jsonrpc: incoming.jsonrpc,
                    result: {
                        type: 'started'
                    }
                }));
                if (!(0, observable_1.isObservable)(result))
                    throw new server_1.TRPCError({
                        message: `Subscription ${incoming.params.path} did not return an observable`,
                        code: 'INTERNAL_SERVER_ERROR'
                    });
                observer = result.subscribe({
                    next(data) {
                        ws.send(JSON.stringify((0, utils_1.transformTRPCResponse)(router, {
                            id: incoming.id,
                            jsonrpc: incoming.jsonrpc,
                            result: {
                                type: 'data',
                                data
                            }
                        })));
                    },
                    error(err) {
                        ws.send(JSON.stringify((0, utils_1.transformTRPCResponse)(router, {
                            id: incoming.id,
                            jsonrpc: incoming.jsonrpc,
                            error: router.getErrorShape({
                                error: (0, utils_1.getTRPCErrorFromUnknown)(err),
                                type: incoming.method,
                                path: incoming.params.path,
                                input: incoming.params.input,
                                ctx: {}
                            })
                        })));
                    },
                    complete() {
                        ws.send(JSON.stringify((0, utils_1.transformTRPCResponse)(router, {
                            id: incoming.id,
                            jsonrpc: incoming.jsonrpc,
                            result: {
                                type: 'stopped'
                            }
                        })));
                    }
                });
                observers.set(ws.data.id.toString(), observer);
            }
        },
        close(ws) {
            observers.get(ws.data.id.toString())?.unsubscribe();
            observers.delete(ws.data.id.toString());
        }
    });
    return app;
};
exports.trpc = trpc;
