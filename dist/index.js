import { getSchemaValidator } from 'elysia';
import { callProcedure, TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { isObservable } from '@trpc/server/observable';
import { transformTRPCResponse, getTRPCErrorFromUnknown } from './utils';
export function compile(schema) {
    const check = getSchemaValidator(schema, {});
    if (!check)
        throw new Error('Invalid schema');
    return (value) => {
        if (check.Check(value))
            return value;
        const { path, message } = [...check.Errors(value)][0];
        throw new TRPCError({
            message: `${message} for ${path}`,
            code: 'BAD_REQUEST'
        });
    };
}
const getPath = (url) => {
    const start = url.indexOf('/', 9);
    const end = url.indexOf('?', start);
    if (end === -1)
        return url.slice(start);
    return url.slice(start, end);
};
export const trpc = (router, { endpoint = '/trpc', ...options } = {
    endpoint: '/trpc'
}) => (eri) => {
    let app = eri
        .onParse(async ({ request: { url } }) => {
        if (getPath(url).startsWith(endpoint))
            return true;
    })
        .get(`${endpoint}/*`, async ({ query, request }) => {
        return fetchRequestHandler({
            ...options,
            req: request,
            router,
            endpoint
        });
    })
        .post(`${endpoint}/*`, async ({ query, request }) => {
        return fetchRequestHandler({
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
                const result = await callProcedure({
                    procedures: router._def.procedures,
                    path: incoming.params.path,
                    rawInput: incoming.params.input?.json,
                    type: incoming.method,
                    ctx: {}
                });
                if (incoming.method !== 'subscription')
                    return void ws.send(JSON.stringify(transformTRPCResponse(router, {
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
                if (!isObservable(result))
                    throw new TRPCError({
                        message: `Subscription ${incoming.params.path} did not return an observable`,
                        code: 'INTERNAL_SERVER_ERROR'
                    });
                observer = result.subscribe({
                    next(data) {
                        ws.send(JSON.stringify(transformTRPCResponse(router, {
                            id: incoming.id,
                            jsonrpc: incoming.jsonrpc,
                            result: {
                                type: 'data',
                                data
                            }
                        })));
                    },
                    error(err) {
                        ws.send(JSON.stringify(transformTRPCResponse(router, {
                            id: incoming.id,
                            jsonrpc: incoming.jsonrpc,
                            error: router.getErrorShape({
                                error: getTRPCErrorFromUnknown(err),
                                type: incoming.method,
                                path: incoming.params.path,
                                input: incoming.params.input,
                                ctx: {}
                            })
                        })));
                    },
                    complete() {
                        ws.send(JSON.stringify(transformTRPCResponse(router, {
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
