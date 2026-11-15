#!/usr/bin/env node
import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const WEBSITE_ROOT = path.resolve(__dirname, "..", "website");

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none';";

function buildEtag(stat) {
  const mtimeNs = stat.mtimeNs ?? BigInt(Math.trunc(Number(stat.mtimeMs) * 1e6));
  const size = typeof stat.size === "bigint" ? stat.size : BigInt(stat.size);
  return `"${size.toString(16)}-${mtimeNs.toString(16)}"`;
}

function matchesIfNoneMatch(headerValue, etag) {
  if (!headerValue) {
    return false;
  }
  const normalized = headerValue.trim();
  if (normalized === "*") {
    return true;
  }
  const bareTarget = etag.replace(/^W\//, "");
  return normalized.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === etag || trimmed.replace(/^W\//, "") === bareTarget;
  });
}

function isNotModifiedSince(headerValue, mtimeDate) {
  if (!headerValue) {
    return false;
  }
  const imsMs = Date.parse(headerValue);
  if (Number.isNaN(imsMs)) {
    return false;
  }
  const mtimeSecMs = Math.floor(mtimeDate.getTime() / 1000) * 1000;
  return mtimeSecMs <= imsMs;
}

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
});

/**
 * Resolves a request pathname safely inside `rootDir`.
 * Returns `null` if path traversal outside `rootDir` is attempted.
 */
export function resolveWebsitePath(urlPathname, rootDir = WEBSITE_ROOT) {
  const decoded = decodeURIComponent((urlPathname || "/").split("?")[0]);
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.resolve(rootDir, "." + normalized);
  const relative = path.relative(rootDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}

export function createWebsiteServer(rootDir = WEBSITE_ROOT) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method Not Allowed");
        return;
      }

      const filePath = resolveWebsitePath(req.url || "/", rootDir);
      if (!filePath) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }

      const stat = await fs.stat(filePath, { bigint: true }).catch(() => null);
      if (!stat || !stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      const etag = buildEtag(stat);
      const lastModified = stat.mtime.toUTCString();
      const baseHeaders = {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        ETag: etag,
        "Last-Modified": lastModified,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      };

      const ifNoneMatch = req.headers["if-none-match"];
      const notModified = ifNoneMatch
        ? matchesIfNoneMatch(ifNoneMatch, etag)
        : isNotModifiedSince(req.headers["if-modified-since"], stat.mtime);

      if (notModified) {
        res.writeHead(304, baseHeaders);
        res.end();
        return;
      }

      const headers = {
        ...baseHeaders,
        "Content-Length": stat.size.toString(),
      };

      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return;
      }

      const stream = createReadStream(filePath);
      res.on("close", () => {
        if (!res.writableFinished && !stream.destroyed) {
          stream.destroy();
        }
      });
      stream.on("open", () => {
        res.writeHead(200, headers);
        stream.pipe(res);
      });
      stream.on("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}`);
        } else {
          res.destroy(error);
        }
      });
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal Server Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const portFlagIndex = args.indexOf("--port");
  const port =
    portFlagIndex >= 0 && args[portFlagIndex + 1]
      ? Number.parseInt(args[portFlagIndex + 1], 10)
      : Number.parseInt(process.env.PORT || "4173", 10);
  const host = process.env.HOST || "127.0.0.1";

  const server = createWebsiteServer(WEBSITE_ROOT);
  server.listen(port, host, () => {
    console.log(`Argon Browser website listening on http://${host}:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
