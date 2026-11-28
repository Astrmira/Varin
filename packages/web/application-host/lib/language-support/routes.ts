import type { Express, Request, RequestHandler, Response } from "express";
import { buffer } from "node:stream/consumers";
import { addAbortSignal } from "node:stream";
import type { LanguageSupportRuntime } from "./runtime.js";
import type { LanguageSupportAPI } from "@varin/application-client";
import { LanguageSupportError } from "@varin/application-client";

const sendError = (res: Response, error: unknown) => {
  if (error instanceof LanguageSupportError) {
    return res.status(error.status ?? 400).json({ error: error.message, reason: error.reason });
  }
  const message = error instanceof Error ? error.message : "Language support request failed";
  return res.status(500).json({ error: message, reason: "failed" });
};

const readBody = (req: Request): Record<string, unknown> => (
  req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {}
);

const stringField = (value: unknown): string => typeof value === "string" ? value : "";

export const registerLanguageSupportRoutes = (app: Express, {
  languageSupport,
  uiAuthController,
}: {
  languageSupport: LanguageSupportAPI & Pick<LanguageSupportRuntime, 'prepareServer'>;
  uiAuthController?: { requireAuth?: RequestHandler };
}): void => {
  const requireAuth = uiAuthController?.requireAuth ?? ((_req, _res, next) => next());

  app.post("/api/language-support/status", requireAuth, async (req, res) => {
    try {
      return res.json(await languageSupport.getStatus({ workspaceId: stringField(readBody(req).workspaceId) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/language-support/install", requireAuth, async (req, res) => {
    try {
      return res.json(await languageSupport.install({ languageId: stringField(readBody(req).languageId) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/language-support/server/:action', requireAuth, async (req, res) => {
    try {
      if (req.params.action === 'import') {
        if (!req.is('application/octet-stream')) return res.status(415).json({ error: 'Expected a language server archive' });
        const request = { workspaceId: stringField(req.query.workspaceId), languageId: stringField(req.query.languageId) };
        return res.json(await languageSupport.prepareServer(request, signal => buffer(addAbortSignal(signal, req))));
      }
      const body = readBody(req);
      const request = { workspaceId: stringField(body.workspaceId), languageId: stringField(body.languageId) };
      if (req.params.action === 'prepare') return res.json(await languageSupport.prepareServer(request));
      if (req.params.action === 'cancel') { await languageSupport.cancelServerPreparation(request); return res.json({ status: 'cancelled' }); }
      return res.status(404).json({ error: 'Unknown language server action' });
    } catch (error) { return sendError(res, error); }
  });

  app.post("/api/language-support/cancel", requireAuth, async (req, res) => {
    try {
      return res.json(await languageSupport.cancelInstall({ languageId: stringField(readBody(req).languageId) }));
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post("/api/language-support/import", requireAuth, async (req, res) => {
    try {
      const body = readBody(req);
      return res.json(await languageSupport.importUserGrammar({
        languageId: stringField(body.languageId),
        path: stringField(body.path),
      }));
    } catch (error) {
      return sendError(res, error);
    }
  });
};
