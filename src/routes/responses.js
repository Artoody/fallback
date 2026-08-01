import express from "express";
import { getCodexModelCatalog } from "../codex/modelCatalog.js";
import {
  adaptResponsesRequest,
  ResponsesRequestError,
} from "../codex/requestAdapter.js";
import {
  ResponsesStreamAdapter,
  responsesUsageToStoreUsage,
  translateGeminiInteraction,
} from "../codex/responseAdapter.js";
import { StateEnvelopeError } from "../codex/stateEnvelope.js";

function errorBody(error, fallbackCode = "gateway_error") {
  return {
    error: {
      message: String(error?.message || "The gateway could not complete the request."),
      type: error instanceof ResponsesRequestError ? "invalid_request_error" : "server_error",
      param: error?.param || null,
      code: error?.code || fallbackCode,
    },
  };
}

function upstreamError(result) {
  const error = new Error(result?.error || "Gemini could not complete the request.");
  error.code = result?.allKeysExhausted ? "all_keys_exhausted" : "upstream_error";
  return error;
}

function setRetryAfter(res, retryAfterMs) {
  if (retryAfterMs > 0) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
}

export function createResponsesRouter({
  requireClientAuth,
  interactionsClient,
  stateEnvelope,
  trackUsage = () => {},
  emitLive = () => {},
} = {}) {
  const router = express.Router();

  router.get("/models", requireClientAuth, (req, res) => {
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json(getCodexModelCatalog());
  });

  router.post("/responses", requireClientAuth, async (req, res) => {
    if (!stateEnvelope) {
      return res.status(503).json(
        errorBody(
          Object.assign(new Error("The Responses API is disabled until RESPONSES_STATE_SECRET is configured."), {
            code: "responses_api_disabled",
          })
        )
      );
    }

    let adapted;
    try {
      adapted = adaptResponsesRequest(req.body, {
        clientId: req.client.id,
        stateEnvelope,
      });
    } catch (error) {
      if (error instanceof ResponsesRequestError || error instanceof StateEnvelopeError) {
        return res.status(error.status || 400).json(errorBody(error));
      }
      throw error;
    }

    const controller = new AbortController();
    const abortUpstream = () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected."));
    };
    req.once("aborted", abortUpstream);
    res.once("close", abortUpstream);

    emitLive({
      type: "request",
      message: `Codex Responses${adapted.stream ? " (stream)" : ""}`,
      clientName: req.client.name,
      model: adapted.model.slug,
      detail: adapted.stream ? "stream" : "normal",
    });

    try {
      if (!adapted.stream) {
        const result = await interactionsClient.create({
          request: adapted.geminiRequest,
          stream: false,
          signal: controller.signal,
        });
        if (!result.ok) {
          setRetryAfter(res, result.retryAfterMs);
          trackUsage(req, { ok: false }, { type: "responses", model: adapted.model.slug });
          return res.status(result.status || 502).json(errorBody(upstreamError(result)));
        }

        const response = translateGeminiInteraction(result.data, {
          model: adapted.model.slug,
          registry: adapted.registry,
          stateEnvelope,
          clientId: req.client.id,
          request: req.body,
        });
        trackUsage(
          req,
          {
            ok: true,
            data: { usageMetadata: responsesUsageToStoreUsage(response.usage) },
            usedKeyIndex: result.usedKeyIndex,
          },
          { type: "responses", model: adapted.model.slug }
        );
        emitLive({
          type: "success",
          message: `Codex Responses completed with key #${result.usedKeyIndex + 1}`,
          clientName: req.client.name,
          model: adapted.model.slug,
          keyIndex: result.usedKeyIndex,
        });
        return res.json(response);
      }

      let headersStarted = false;
      const writeEvent = (event) => {
        if (!headersStarted || res.writableEnded) return;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        res.flush?.();
      };
      const adapter = new ResponsesStreamAdapter({
        model: adapted.model.slug,
        registry: adapted.registry,
        stateEnvelope,
        clientId: req.client.id,
        request: req.body,
        emit: writeEvent,
      });

      const result = await interactionsClient.create({
        request: adapted.geminiRequest,
        stream: true,
        signal: controller.signal,
        onStart: (keyIndex) => {
          headersStarted = true;
          res.status(200);
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders?.();
          emitLive({
            type: "success",
            message: `Codex stream started with key #${keyIndex + 1}`,
            clientName: req.client.name,
            model: adapted.model.slug,
            keyIndex,
          });
        },
        onEvent: (event) => adapter.handle(event),
      });

      if (!result.ok && !headersStarted) {
        setRetryAfter(res, result.retryAfterMs);
        trackUsage(req, { ok: false }, { type: "responses_stream", model: adapted.model.slug });
        return res.status(result.status || 502).json(errorBody(upstreamError(result)));
      }

      if (!adapter.finished) {
        adapter.finish(
          result.ok
            ? result.data || { status: "completed", steps: [] }
            : {
                status: "failed",
                error: { code: "upstream_stream_error", message: result.error },
              }
        );
      }
      const ok = Boolean(result.ok);
      trackUsage(
        req,
        {
          ok,
          data: ok
            ? { usageMetadata: responsesUsageToStoreUsage(adapter.finalResponse?.usage) }
            : undefined,
          usedKeyIndex: result.usedKeyIndex,
        },
        { type: "responses_stream", model: adapted.model.slug }
      );
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ResponsesRequestError || error instanceof StateEnvelopeError) {
        if (!res.headersSent) return res.status(error.status || 400).json(errorBody(error));
      }
      throw error;
    } finally {
      req.removeListener("aborted", abortUpstream);
      res.removeListener("close", abortUpstream);
    }
  });

  return router;
}
