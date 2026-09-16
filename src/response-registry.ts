/**
 * Response handler registry.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * at import time don't hit a TDZ error on the const-array declaration.
 * index.ts imports src/modules/index.js for its side effects, which triggers
 * module registrations that would otherwise happen before index.ts's own
 * const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

/**
 * `true`: this handler owned the question and handled the click (the card may
 * be terminalized). `false`: not this handler's question. `'refused'`: this
 * handler owned the question but REJECTED the click (unauthorized clicker);
 * nothing changed, so the card must keep its buttons for the right person.
 */
export type ResponseOutcome = boolean | 'refused';
export type ResponseHandler = (payload: ResponsePayload) => Promise<ResponseOutcome>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}
