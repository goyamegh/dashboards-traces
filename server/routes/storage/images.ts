/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Benchmark Images API — content-addressed evaluation-condition snapshots.
 *
 * An image freezes the "controls" of an evaluation (test-case contents +
 * evaluator/judge conditions) under a SHA-256 digest. Runs sharing a digest
 * are comparable by construction. Images are find-or-create on run creation
 * (see evaluationRuns.ts) — this router only exposes read/tag/delete.
 */

import { Router, Request, Response } from 'express';
import { getStorageModule } from '../../adapters/index.js';
import { buildImageDoc } from '../../../lib/benchmarkImage.js';

const router = Router();

// POST /api/storage/images - Build an image from stored test cases (find-or-create)
// Body: { testCaseIds: string[], evalConditions?: { evaluatorId?, judgeModelId? }, tags?: string[] }
// Used by `benchmark doctor --migrate-images` to convert legacy benchmarks into
// tagged images. Content-addressed: posting the same content returns the same image.
router.post('/api/storage/images', async (req: Request, res: Response) => {
  try {
    const { testCaseIds, evalConditions, tags, dryRun } = req.body;
    if (!Array.isArray(testCaseIds) || testCaseIds.length === 0) {
      return res.status(400).json({ error: 'testCaseIds is required and must be a non-empty array' });
    }
    const storage = getStorageModule();
    const testCases = [];
    const missing: string[] = [];
    for (const id of testCaseIds) {
      const tc = await storage.testCases.getById(id);
      if (tc) testCases.push(tc);
      else missing.push(id);
    }
    if (testCases.length === 0) {
      return res.status(400).json({ error: `None of the test cases exist: ${missing.join(', ')}` });
    }
    const doc = buildImageDoc({ testCases, evalConditions });
    const wantTags = Array.isArray(tags) ? tags.map((t: string) => String(t).trim()).filter(Boolean) : [];

    // Preview-only: report the digest/tags/missing-ids this call WOULD
    // produce without creating or updating anything in storage. Used by
    // `benchmark doctor --migrate-images` (no --apply) so the migration
    // plan shown to the operator is byte-for-byte the real digest, not a
    // guess -- the same accuracy guarantee dry-run debris/dup detection
    // already has. Read failures are NOT swallowed here (unlike the
    // find-or-create path, which is naturally idempotent) -- a dry-run
    // preview's whole job is to be trustworthy, so a storage read error
    // must surface as a 500, not silently report "would create" during an
    // outage (codex_review finding).
    if (dryRun === true) {
      const existing = await storage.images.getByDigest(doc.digest);
      const wouldAddTags = existing ? wantTags.filter((t) => !existing.tags.includes(t)) : wantTags;
      // When the image already exists, preview the REAL stored doc (with
      // its real createdAt/testCaseFingerprints/tags) rather than a
      // freshly re-built `buildImageDoc()` -- a fabricated doc could
      // silently disagree with what's actually stored (codex_review
      // finding). Only synthesize a doc for the "doesn't exist yet" case,
      // where there is nothing real to show.
      const previewImage = existing
        ? { ...existing, tags: [...existing.tags, ...wouldAddTags] }
        : { ...doc, tags: wouldAddTags };
      return res.status(200).json({
        image: previewImage,
        dryRun: true,
        alreadyExists: existing !== null,
        // Even when the image already exists, --apply may still need to
        // add tags (e.g. a benchmark renamed since the image was created)
        // -- callers should not read alreadyExists alone as "--apply is a
        // no-op" (codex_review finding).
        ...(wouldAddTags.length > 0 ? { wouldAddTags } : {}),
        ...(missing.length > 0 ? { missingTestCaseIds: missing } : {}),
      });
    }

    const image = await storage.images.create(doc);
    // Union requested tags onto the (possibly pre-existing) image
    const newTags = wantTags.filter((t) => !image.tags.includes(t));
    const finalImage = newTags.length > 0
      ? await storage.images.update(image.digest, { tags: [...image.tags, ...newTags] })
      : image;
    res.status(201).json({ image: finalImage, ...(missing.length > 0 ? { missingTestCaseIds: missing } : {}) });
  } catch (error: any) {
    console.error('[StorageAPI] Create image failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/images - List benchmark images
router.get('/api/storage/images', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const { from, size } = req.query;
    const result = await storage.images.getAll({
      from: from ? parseInt(from as string, 10) : 0,
      size: size ? parseInt(size as string, 10) : 100,
    });
    res.json({ images: result.items, total: result.total });
  } catch (error: any) {
    console.error('[StorageAPI] List images failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/storage/images/:digest - Get image + its runs (grouped comparison set)
router.get('/api/storage/images/:digest', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const digest = req.params.digest;
    const image = await storage.images.getByDigest(digest);
    if (!image) {
      return res.status(404).json({ error: `Image not found: ${digest}` });
    }
    // All runs sharing this digest ran under identical conditions —
    // this IS the comparable set. Pageable via `size`/`from` (default 500/0)
    // so an image with >500 runs isn't silently truncated with no way to
    // fetch the rest — `runsTotal` always reflects the true count.
    //
    // KNOWN GAP (tracked, not fixed here): this only searches the
    // EvaluationRun collection. Legacy BenchmarkRun docs (embedded in a
    // Benchmark's `runs[]`, created by POST /benchmarks/:id/execute) now
    // carry `imageDigest` too (see that route), but nothing here queries
    // benchmarks by an embedded run's digest — doing so needs a
    // storage-layer query capability neither adapter has today (embedded
    // `runs[]` isn't indexed for that kind of search). So a legacy-path
    // run's digest is stamped and content-addressed, but won't yet surface
    // in this comparable-runs view. Narrower, deliberately-scoped fix for
    // now; wiring this read path is a separate follow-up.
    const { from, size } = req.query;
    const runs = await storage.evaluationRuns.list({
      imageDigest: digest,
      from: from ? parseInt(from as string, 10) : 0,
      size: size ? parseInt(size as string, 10) : 500,
    });
    res.json({ image, runs: runs.items, runsTotal: runs.total });
  } catch (error: any) {
    console.error('[StorageAPI] Get image failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/storage/images/:digest/tags - Add a tag (docker-style label, not identity)
router.post('/api/storage/images/:digest/tags', async (req: Request, res: Response) => {
  try {
    const { tag } = req.body;
    if (!tag || typeof tag !== 'string' || !tag.trim()) {
      return res.status(400).json({ error: 'tag is required and must be a non-empty string' });
    }
    const storage = getStorageModule();
    const digest = req.params.digest;
    const image = await storage.images.getByDigest(digest);
    if (!image) {
      return res.status(404).json({ error: `Image not found: ${digest}` });
    }
    const trimmed = tag.trim();
    if (image.tags.includes(trimmed)) {
      return res.json({ image }); // idempotent
    }
    const updated = await storage.images.update(digest, { tags: [...image.tags, trimmed] });
    res.json({ image: updated });
  } catch (error: any) {
    console.error('[StorageAPI] Tag image failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/images/:digest/tags/:tag - Remove a tag
router.delete('/api/storage/images/:digest/tags/:tag', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const { digest, tag } = req.params;
    const image = await storage.images.getByDigest(digest);
    if (!image) {
      return res.status(404).json({ error: `Image not found: ${digest}` });
    }
    const updated = await storage.images.update(digest, {
      tags: image.tags.filter((t) => t !== tag),
    });
    res.json({ image: updated });
  } catch (error: any) {
    console.error('[StorageAPI] Untag image failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/storage/images/:digest - Delete an image (runs keep their digest stamp)
router.delete('/api/storage/images/:digest', async (req: Request, res: Response) => {
  try {
    const storage = getStorageModule();
    const result = await storage.images.delete(req.params.digest);
    if (!result.deleted) {
      return res.status(404).json({ error: `Image not found: ${req.params.digest}` });
    }
    res.json({ deleted: true });
  } catch (error: any) {
    console.error('[StorageAPI] Delete image failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export default router;
