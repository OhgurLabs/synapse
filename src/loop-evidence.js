/**
 * Phase 2A — Portable Evidence Packet Exporter, Offline Verifier & Operator Approval Gate
 * (Hardened per GPT-6.2 Sol #88 Review).
 */

import Ajv from 'ajv';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, openSync, writeSync, closeSync, unlinkSync, fstatSync, opendirSync, readSync, constants as fsConstants } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, resolve as pathResolve, sep } from 'path';
import {
  GIT_SHA_RE, SHA256_RE, canonicalJson, sha256Buffer, sha256Hex,
} from './loop-store.js';
import { LoopError, normalizeSafeRelativePath } from './loops.js';
import { withRepoIntegrationLock } from './orchestrator/git-worktrees.js';

const ajv = new Ajv({ allErrors: true, strict: false });

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function resolveEvidencePrivatePaths(stateManager, projectId, repoDir = null) {
  if (!projectId) return [];
  const project = stateManager?.getProject?.(projectId);
  const vaultPath = stateManager?.getProjectContextConfig?.(projectId)?.vault?.path ?? project?.contextConfig?.vault?.path;
  if (!vaultPath || vaultPath === 'vault') return [];

  let privatePath;
  try { privatePath = normalizeSafeRelativePath(String(vaultPath).trim()); } catch {}
  const repoRoot = repoDir || stateManager?.resolveGitRepoRoot?.(projectId) || project?.projectDir;
  if (repoRoot && project?.projectDir && privatePath) {
    // A subdirectory project resolves its vault relative to the enclosing Git repository.
    const gitPath = relative(repoRoot, pathResolve(project.projectDir, privatePath)).split(sep).join('/');
    if (gitPath && gitPath !== '..' && !gitPath.startsWith('../')) return [...new Set([privatePath, gitPath])];
  }
  throw new LoopError('EVIDENCE_PRIVATE_PATH_UNRESOLVED', 'Cannot resolve the configured vault path', { statusCode: 409 });
}

export function formatEvidenceVerifyCommand(runId, privatePaths = []) {
  const shellQuote = value => /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
  const flags = [...new Set(privatePaths)].map(path => '--private-path ' +
    shellQuote(path.startsWith('-') ? `./${path}` : path));
  return ['node scripts/verify-loop-evidence.mjs', ...flags, shellQuote(`synapse-evidence-${runId}.json`)].join(' ');
}

function verifyBundleSource(runIsoGit, unbundleOut, runId, refSha, privatePaths, errors) {
  const refs = unbundleOut.split(/\r?\n/);
  if (refs.length !== 1) {
    errors.push('Evidence Git bundle has unexpected refs');
    return false;
  }
  const expectedProofRef = `refs/synapse-proof/${runId}`;
  const [sha, ref] = refs[0].trim().split(/\s+/);
  const bundleHead = ref === expectedProofRef ? sha : null;
  if (bundleHead !== refSha) {
    errors.push(`Git bundle HEAD (${bundleHead}) != approvedSourceSha (${refSha})`);
    return false;
  }
  const privateGitPaths = [
    ':(glob,icase)**/vault', ':(glob,icase)**/vault/**',
    ':(glob,icase)**/.proposals', ':(glob,icase)**/.proposals/**',
    ':(glob,icase)**/.git', ':(glob,icase)**/.git/**',
    ...privatePaths.map(path => `:(literal)${path}`),
  ];
  if (!runIsoGit(['log', '--full-history', '-1', '--format=%H', refSha, '--', ...privateGitPaths])) return true;
  errors.push('Evidence Git bundle contains private vault history');
  return false;
}

export function computeAnchorSetSha256(anchors = []) {
  const normalized = [...anchors]
    .sort((a, b) => `${a.anchorId}:${a.attemptId}`.localeCompare(`${b.anchorId}:${b.attemptId}`))
    .map(a => ({
      anchorId: a.anchorId,
      nodeId: a.nodeId,
      attemptId: a.attemptId,
      subjectSha: a.subjectSha || null,
      inputSha256: a.inputSha256,
      runnerDigest: a.runnerDigest,
      exitCode: a.exitCode,
      signal: a.signal,
      outcome: a.outcome,
      stdoutSha256: a.stdout?.sha256 || null,
      stderrSha256: a.stderr?.sha256 || null,
    }));
  return sha256Hex(canonicalJson(normalized));
}

function collectFilesStrictNoSymlinks(rootDir) {
  const canonicalRoot = realpathSync(rootDir);
  const files = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        throw new LoopError('PACKET_SYMLINK', `Symlink prohibited inside Evidence Packet: "${relative(canonicalRoot, full)}"`);
      }
      if (lst.isDirectory()) walk(full);
      else if (lst.isFile()) {
        const real = realpathSync(full);
        if (!real.startsWith(canonicalRoot + sep)) {
          throw new LoopError('PACKET_PATH_ESCAPE', `File escapes Evidence Packet root: "${full}"`);
        }
        files.push(relative(canonicalRoot, real).replace(/\\/g, '/'));
      } else {
        throw new LoopError('PACKET_INVALID_ENTRY', `Unsupported file type in Evidence Packet: "${relative(canonicalRoot, full)}"`);
      }
    }
  };
  walk(canonicalRoot);
  return files.sort();
}

export function exportEvidencePacket({
  loopStore,
  run,
  manifest,
  approvalEvent = null,
  projectDir = null,
  destDir = null,
  archivePrivatePaths = [],
}) {
  if (!loopStore || !run || !manifest) {
    throw new LoopError('EXPORT_INVALID_ARGS', 'exportEvidencePacket requires loopStore, run, and manifest');
  }
  const finalDest = destDir || join(loopStore.packetsDir, `${run.runId}-${approvalEvent?.eventId || 'artifact'}`);
  const assertVerifiedPacket = (packetDir) => {
    const snapshot = captureEvidencePacketSnapshot(packetDir);
    const result = verifyEvidencePacketSnapshot(snapshot, { archivePrivatePaths });
    if (!result.ok) {
      throw new LoopError('PACKET_SELF_VERIFY_FAILED', `Exported packet failed self-verification: ${result.errors.join('; ')}`);
    }
    return { snapshot, result };
  };
  if (existsSync(finalDest)) {
    const { snapshot, result } = assertVerifiedPacket(finalDest);
    return {
      packetDir: finalDest,
      evidencePacketSha256: result.evidencePacketSha256,
      checksumManifestSha256: result.checksumManifestSha256,
      packet: JSON.parse(snapshot.memberBuffers.get('evidence-packet.json').toString('utf8')),
    };
  }

  const stagingDir = `${finalDest}.staging.${process.pid}.${randomUUID().slice(0, 8)}`;
  mkdirSync(stagingDir, { recursive: true });

  try {
    const writeFile = (relPath, rawBuf) => {
      const norm = normalizeSafeRelativePath(relPath);
      const abs = pathResolve(stagingDir, norm);
      if (!abs.startsWith(pathResolve(stagingDir) + sep)) {
        throw new LoopError('PACKET_PATH_ESCAPE', `Unsafe packet member path: ${relPath}`);
      }
      mkdirSync(dirname(abs), { recursive: true });
      const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(String(rawBuf), 'utf8');
      writeFileSync(abs, buf);
      return {
        path: norm,
        sha256: sha256Buffer(buf),
        bytes: buf.length,
      };
    };

    const { packet, packetRef } = assembleEvidencePacket({
      run, manifest, approvalEvent, writeFile,
      readArtifact: ref => loopStore.readArtifactBytes(ref.sha256),
      writeSourceBundle() {
        if (!projectDir || !existsSync(join(projectDir, '.git'))) {
          throw new LoopError('PR_BUNDLE_REPO_MISSING', 'PR evidence mode requires projectDir Git repo to export source.bundle');
        }
        const bundleRel = 'source.bundle';
        const bundleAbs = join(stagingDir, bundleRel);
        const tempProofRef = `refs/synapse-proof/${run.runId}`;
        runGit(projectDir, ['update-ref', tempProofRef, approvalEvent.approvedSourceSha]);
        try {
          runGit(projectDir, ['bundle', 'create', bundleAbs, tempProofRef]);
        } finally {
          try { runGit(projectDir, ['update-ref', '-d', tempProofRef]); } catch {}
        }
        const bBytes = readSnapshotMember(bundleAbs, MAX_EVIDENCE_MEMBER_BYTES);
        return {
          path: bundleRel,
          sha256: sha256Buffer(bBytes),
          bytes: bBytes.length,
        };
      },
    });

    const allMembers = collectFilesStrictNoSymlinks(stagingDir).filter(p => p !== 'SHA256SUMS').sort();
    const sumLines = allMembers.map(rel => {
      const digest = sha256Buffer(readFileSync(join(stagingDir, rel)));
      return `${digest}  ${rel}`;
    });
    const sumBuf = Buffer.from(sumLines.join('\n') + '\n', 'utf8');
    writeFileSync(join(stagingDir, 'SHA256SUMS'), sumBuf);
    const checksumManifestSha256 = sha256Buffer(sumBuf);

    assertVerifiedPacket(stagingDir);

    mkdirSync(dirname(finalDest), { recursive: true });
    renameSync(stagingDir, finalDest);

    return {
      packetDir: finalDest,
      evidencePacketSha256: packetRef.sha256,
      checksumManifestSha256,
      packet,
    };
  } catch (err) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function assembleEvidencePacket({ run, manifest, approvalEvent, writeFile, readArtifact, writeSourceBundle }) {
  const manifestCanonical = canonicalJson(manifest);
  const manifestRef = writeFile('loop-manifest.json', Buffer.from(manifestCanonical, 'utf8'));

  // P2 #3: Namespace isolated node outputs by (nodeId, attemptId) so independent sibling nodes
  // emitting the same relative filename NEVER silently overwrite or drop each other!
  const artifactRefs = [];
  const seenPaths = new Set();
  const copyNamespacedArtifact = (ref, namespacePrefix) => {
    if (!ref || !ref.sha256) return null;
    const norm = normalizeSafeRelativePath(ref.path);
    const destRel = namespacePrefix
      ? normalizeSafeRelativePath(`artifacts/${namespacePrefix}/${norm}`)
      : (norm.startsWith('artifacts/') ? norm : normalizeSafeRelativePath(`artifacts/${norm}`));
    if (seenPaths.has(destRel)) {
      return artifactRefs.find(a => a.path === destRel);
    }
    seenPaths.add(destRel);
    const raw = readArtifact(ref);
    const written = writeFile(destRel, raw);
    artifactRefs.push(written);
    return written;
  };

  const nodeReportMap = new Map();
  for (const [nodeId, attId] of Object.entries(run.selectedAttempts || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const att = (run.nodeAttempts?.[nodeId] || []).find(a => a.attemptId === attId);
    if (!att) continue;
    for (const out of (att.outputs || [])) {
      const written = copyNamespacedArtifact(out, `${nodeId}/${attId}`);
      nodeReportMap.set(`${nodeId}:${attId}:${out.sha256}`, written);
    }
  }

  // Export only the selected attempt's AnchorResult per declared anchor node (no duplicates)
  const selectedAnchorResults = (run.anchors || []).filter(a => run.selectedAttempts?.[a.nodeId] === a.attemptId);
  const packetAnchors = selectedAnchorResults.map(a => {
    const stdoutWritten = copyNamespacedArtifact(a.stdout, `${a.nodeId}/${a.attemptId}`);
    const stderrWritten = copyNamespacedArtifact(a.stderr, `${a.nodeId}/${a.attemptId}`);
    return {
      ...a,
      stdout: stdoutWritten,
      stderr: stderrWritten,
    };
  });

  let prSection = null;
  if (manifest.evidence?.mode === 'pr') {
    const source = run.provenance?.source;
    const designatedCheckerId = manifest.evidence.checkerNodeId;
    const checkerSelAttemptId = run.selectedAttempts?.[designatedCheckerId];
    const review = run._checkerReview;
    if (
      !source?.postIntegrationHeadSha
      || !review
      || review.nodeId !== designatedCheckerId
      || review.attemptId !== checkerSelAttemptId
      || !approvalEvent
    ) {
      throw new LoopError('PR_EVIDENCE_INCOMPLETE', 'PR evidence packet requires designated checker selected attempt review and operator approval');
    }
    const reportWritten = nodeReportMap.get(`${review.nodeId}:${review.attemptId}:${review.report.sha256}`)
      || copyNamespacedArtifact(review.report, `${review.nodeId}/${review.attemptId}`);

    const sourceBundleRef = writeSourceBundle();

    prSection = {
      projectId: run.provenance?.scope?.projectId || manifest.scope?.projectId || 'default',
      prId: source.prId,
      repoId: source.repoId || 'default',
      sourceRef: source.sourceRef,
      baseSha: source.baseSha,
      postIntegrationHeadSha: source.postIntegrationHeadSha,
      approvedSourceSha: approvalEvent.approvedSourceSha,
      sourceBundle: sourceBundleRef,
      review: {
        nodeId: review.nodeId,
        attemptId: review.attemptId,
        sessionId: review.sessionId,
        agentId: review.agentId,
        agentInstanceId: review.agentInstanceId,
        provider: review.provider,
        model: review.model,
        reviewedSourceSha: review.reviewedSourceSha,
        disposition: 'approve',
        report: reportWritten,
      },
      approval: {
        eventId: approvalEvent.eventId,
        principalId: approvalEvent.principalId,
        principalKind: 'operator',
        approvedAt: approvalEvent.approvedAt,
        approvedSourceSha: approvalEvent.approvedSourceSha,
        reviewSha256: approvalEvent.reviewSha256,
        anchorSetSha256: approvalEvent.anchorSetSha256,
      },
    };
  }

  const runSnapshot = {
    ...structuredClone(run),
    phase: 'terminal',
    verdict: 'passed',
    reasonCode: null,
  };
  const runRef = writeFile('loop-run.json', Buffer.from(JSON.stringify(runSnapshot, null, 2) + '\n', 'utf8'));

  const packetObj = {
    schemaVersion: 1,
    run: {
      runId: run.runId,
      loopId: run.pin.loopId,
      loopVersion: run.pin.loopVersion,
      manifestHash: run.pin.manifestHash,
      verdict: 'passed',
    },
    files: {
      manifest: manifestRef,
      runRecord: runRef,
      artifacts: artifactRefs.sort((a, b) => a.path.localeCompare(b.path)),
    },
    anchors: packetAnchors,
    pr: prSection,
  };
  const packetRef = writeFile('evidence-packet.json', Buffer.from(JSON.stringify(packetObj, null, 2) + '\n', 'utf8'));
  return { packet: packetObj, packetRef };
}

/**
 * Zero-network offline verifier for an extracted Evidence Packet directory
 * (Hardened per GPT-6.2 Sol P1 #2, #5, #6).
 */
export function verifyEvidencePacketDir(packetDir, { archivePrivatePaths = [] } = {}) {
  try {
    return verifyEvidencePacketSnapshot(captureEvidencePacketSnapshot(packetDir), { archivePrivatePaths });
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Operator approval & lock-protected, durably resumable idempotent PR finalization
 * (Hardened per GPT-6.2 Sol P1 #4 & P1 #11).
 */
export async function approveLoopRun({
  loopStore,
  prStore = null,
  projectDir = null,
  archivePrivatePaths = [],
  runId,
  principalId,
  approvedSourceSha,
  reviewSha256,
  anchorSetSha256,
  approvalEventId = null,
}) {
  if (!principalId || typeof principalId !== 'string') {
    throw new LoopError('OPERATOR_REQUIRED', 'Authenticated operator principalId is required', { statusCode: 403 });
  }
  const initialRun = loopStore.getRun(runId);
  if (!initialRun) throw new LoopError('RUN_NOT_FOUND', `Run "${runId}" not found`, { statusCode: 404 });

  const published = loopStore.getLoopVersion(initialRun.pin.loopId, initialRun.pin.loopVersion);
  const manifest = published.manifest;

  // P1 #4: PR mode REQUIRES projectDir and sourceRef for live server-side Git HEAD verification!
  if (manifest.evidence?.mode === 'pr') {
    if (!projectDir || !existsSync(join(projectDir, '.git')) || !initialRun.provenance?.source?.sourceRef) {
      throw new LoopError(
        'MISSING_LIVE_REPO',
        'PR approval requires projectDir Git repo and provenance.source.sourceRef for live HEAD verification',
        { statusCode: 409 }
      );
    }
  }

  const finalizeUnderLock = async () => {
    // P1 #11: Re-read run state INSIDE the repo lock!
    const run = loopStore.getRun(runId);
    const source = run.provenance?.source;
    const review = run._checkerReview;
    const projectId = manifest.scope?.projectId || 'default';

    // Validate digests up front against run's selected checker & anchors
    const designatedCheckerId = manifest.evidence?.checkerNodeId;
    if (
      manifest.evidence?.mode === 'pr'
      && (!review || review.nodeId !== designatedCheckerId || review.attemptId !== run.selectedAttempts?.[designatedCheckerId])
    ) {
      throw new LoopError('PR_EVIDENCE_INCOMPLETE', 'Designated checker review missing or mismatched', { statusCode: 409 });
    }
    const expectedReviewSha = review?.report?.sha256 || null;
    const selectedAnchors = (run.anchors || []).filter(a => run.selectedAttempts?.[a.nodeId] === a.attemptId);
    const expectedAnchorSetSha = computeAnchorSetSha256(selectedAnchors);

    if (!expectedReviewSha || reviewSha256 !== expectedReviewSha) {
      throw new LoopError('REVIEW_DIGEST_MISMATCH', 'Approval reviewSha256 does not match checker review report digest', { statusCode: 409 });
    }
    if (anchorSetSha256 !== expectedAnchorSetSha) {
      throw new LoopError('ANCHOR_DIGEST_MISMATCH', 'Approval anchorSetSha256 does not match run anchor set digest', { statusCode: 409 });
    }

    // Idempotent replay when already finalized
    if (run.phase === 'terminal' && run.verdict === 'passed') {
      const existingApproval = loopStore.getLatestApprovalForRun(runId);
      if (
        existingApproval
        && existingApproval.runId === runId
        && existingApproval.approvedSourceSha === approvedSourceSha
        && existingApproval.reviewSha256 === reviewSha256
        && existingApproval.anchorSetSha256 === anchorSetSha256
      ) {
        const intent = loopStore.getFinalizationIntent(runId, existingApproval.eventId);
        if (intent && intent.status === 'completed') {
          return {
            alreadyFinalized: true,
            run,
            approval: existingApproval,
            packetDir: intent.packetDir,
            evidencePacketSha256: intent.evidencePacketSha256,
            checksumManifestSha256: intent.checksumManifestSha256,
          };
        }
      }
      throw new LoopError('APPROVAL_REPLAY_MISMATCH', 'Run already finalized with different approval parameters', { statusCode: 409 });
    }

    // P1 #11: Allow resuming cleanly from BOTH 'awaiting_approval' AND interrupted 'finalizing'!
    if (run.phase !== 'awaiting_approval' && run.phase !== 'finalizing') {
      throw new LoopError('RUN_NOT_AWAITING_APPROVAL', `Run "${runId}" is in phase "${run.phase}", not "awaiting_approval" or "finalizing"`, { statusCode: 409 });
    }

    // Live Git HEAD re-read under lock
    if (projectDir && source?.sourceRef) {
      const liveHead = runGit(projectDir, ['rev-parse', source.sourceRef]);
      if (liveHead !== source.postIntegrationHeadSha || liveHead !== approvedSourceSha) {
        if (prStore && source.prId) {
          try { prStore.invalidateApprovalOnShaChange(projectId, source.prId, liveHead); } catch {}
        }
        loopStore.updateRunAtomic(runId, (r) => {
          r.phase = 'terminal';
          r.verdict = 'flagged';
          r.reasonCode = 'SOURCE_SHA_CHANGED';
          r.provenance.endedAt = new Date().toISOString();
          return r;
        });
        throw new LoopError(
          'SOURCE_SHA_CHANGED',
          `PR source ref "${source.sourceRef}" moved to ${liveHead} (expected ${source.postIntegrationHeadSha})`,
          { statusCode: 409 }
        );
      }
    }

    // P1 #11: Validate approvalEventId reuse matches exact (runId, principalId, approvedSourceSha, reviewSha256, anchorSetSha256)!
    let approval = null;
    if (approvalEventId) {
      const existing = loopStore.getApprovalEvent(approvalEventId);
      if (existing) {
        if (
          existing.runId !== runId
          || existing.principalId !== principalId
          || existing.approvedSourceSha !== approvedSourceSha
          || existing.reviewSha256 !== reviewSha256
          || existing.anchorSetSha256 !== anchorSetSha256
        ) {
          throw new LoopError('APPROVAL_REPLAY_MISMATCH', `Approval event "${approvalEventId}" belongs to a different run/principal/SHA/digest`, { statusCode: 409 });
        }
        approval = existing;
      }
    } else if (run.phase === 'finalizing') {
      // Resume interrupted finalization using existing recorded approval for this run if it matches
      const prior = loopStore.getLatestApprovalForRun(runId);
      if (
        prior
        && prior.runId === runId
        && prior.principalId === principalId
        && prior.approvedSourceSha === approvedSourceSha
        && prior.reviewSha256 === reviewSha256
        && prior.anchorSetSha256 === anchorSetSha256
      ) {
        approval = prior;
      }
    }

    if (!approval) {
      approval = loopStore.recordApprovalEvent({
        ...(approvalEventId ? { eventId: approvalEventId } : {}),
        runId,
        principalId,
        principalKind: 'operator',
        approvedSourceSha,
        reviewSha256,
        anchorSetSha256,
      });
    }

    loopStore.upsertFinalizationIntent({
      runId,
      approvalEventId: approval.eventId,
      approvedSourceSha,
      status: 'pending',
    });

    if (run.phase !== 'finalizing') {
      loopStore.updateRunAtomic(runId, (r) => {
        r.phase = 'finalizing';
        return r;
      });
    }

    const exported = exportEvidencePacket({
      loopStore,
      run: loopStore.getRun(runId),
      manifest,
      approvalEvent: approval,
      projectDir,
      archivePrivatePaths,
    });

    // Re-check live HEAD once more right before attaching proof
    if (projectDir && source?.sourceRef) {
      const recheckHead = runGit(projectDir, ['rev-parse', source.sourceRef]);
      if (recheckHead !== approvedSourceSha) {
        if (prStore && source.prId) {
          try { prStore.invalidateApprovalOnShaChange(projectId, source.prId, recheckHead); } catch {}
        }
        loopStore.updateRunAtomic(runId, (r) => {
          r.phase = 'terminal';
          r.verdict = 'flagged';
          r.reasonCode = 'SOURCE_SHA_CHANGED';
          r.provenance.endedAt = new Date().toISOString();
          return r;
        });
        throw new LoopError('SOURCE_SHA_CHANGED', `PR source ref drifted during finalization (${recheckHead})`, { statusCode: 409 });
      }
    }

    let filesChanged = 0;
    for (const node of (manifest.nodes || [])) {
      filesChanged += (node.outputs || []).filter(o => o.storage === 'git').length;
    }

    // P1 #11 & New P1: Granular idempotent PR writes — check proof, review, and operator action INDEPENDENTLY!
    if (prStore && source?.prId) {
      const existingPr = prStore.getPR(projectId, source.prId);
      const hasProof = existingPr?.verificationProof?.kind === 'loop-evidence-v1'
        && existingPr.verificationProof.runId === runId
        && existingPr.verificationProof.approvedSourceSha === approvedSourceSha
        && existingPr.verificationProof.evidencePacketSha256 === exported.evidencePacketSha256
        && existingPr.verificationProof.checksumManifestSha256 === exported.checksumManifestSha256
        && existingPr.verificationProof.stale !== true;
      if (!hasProof) {
        prStore.attachVerificationProof(projectId, source.prId, {
          kind: 'loop-evidence-v1',
          runId,
          approvedSourceSha,
          headSha: approvedSourceSha,
          overallPass: true,
          verifyPass: true,
          verifyCommand: formatEvidenceVerifyCommand(runId, archivePrivatePaths),
          filesChanged,
          evidencePacketSha256: exported.evidencePacketSha256,
          checksumManifestSha256: exported.checksumManifestSha256,
          ran: { verify: true },
        });
      }

      const packetTag = `packet=${exported.evidencePacketSha256}`;
      const approvalTag = `approval=${approval.eventId}`;

      const prAfterProof = prStore.getPR(projectId, source.prId);
      const hasReview = Array.isArray(prAfterProof?.reviews) && prAfterProof.reviews.some(
        r => r.reviewer === principalId
          && r.status === 'approved'
          && r.approvedSourceSha === approvedSourceSha
          && !r.stale
          && r.loopRunId === runId
          && r.evidencePacketSha256 === exported.evidencePacketSha256
          && r.approvalEventId === approval.eventId
      );
      if (!hasReview) {
        prStore.addReview(projectId, source.prId, {
          reviewer: principalId,
          status: 'approved',
          summary: `Operator approved Loop ${run.pin.loopId}@v${run.pin.loopVersion} (${runId}) at ${approvedSourceSha} ${packetTag} ${approvalTag}`,
          approvedSourceSha,
          loopRunId: runId,
          evidencePacketSha256: exported.evidencePacketSha256,
          approvalEventId: approval.eventId,
        });
      }

      const prAfterReview = prStore.getPR(projectId, source.prId);
      const hasOperatorAction = Array.isArray(prAfterReview?.operatorActions) && prAfterReview.operatorActions.some(
        a => a.action === 'approve'
          && a.by === principalId
          && a.loopRunId === runId
          && a.evidencePacketSha256 === exported.evidencePacketSha256
          && a.approvalEventId === approval.eventId
      );
      if (!hasOperatorAction) {
        prStore.recordOperatorAction(projectId, source.prId, 'approve', {
          by: principalId,
          note: `Loop ${runId} ${packetTag} ${approvalTag}`,
          loopRunId: runId,
          evidencePacketSha256: exported.evidencePacketSha256,
          approvalEventId: approval.eventId,
        });
      }
    }

    loopStore.upsertFinalizationIntent({
      runId,
      approvalEventId: approval.eventId,
      approvedSourceSha,
      evidencePacketSha256: exported.evidencePacketSha256,
      checksumManifestSha256: exported.checksumManifestSha256,
      packetDir: exported.packetDir,
      status: 'completed',
    });

    const finalRun = loopStore.updateRunAtomic(runId, (r) => {
      r.phase = 'terminal';
      r.verdict = 'passed';
      r.reasonCode = null;
      r.provenance.endedAt = new Date().toISOString();
      r._evidence = {
        packetDir: exported.packetDir,
        evidencePacketSha256: exported.evidencePacketSha256,
        checksumManifestSha256: exported.checksumManifestSha256,
        approvalEventId: approval.eventId,
      };
      return r;
    });

    return {
      alreadyFinalized: false,
      run: finalRun,
      approval,
      packetDir: exported.packetDir,
      evidencePacketSha256: exported.evidencePacketSha256,
      checksumManifestSha256: exported.checksumManifestSha256,
    };
  };

  return projectDir ? withRepoIntegrationLock(projectDir, finalizeUnderLock) : finalizeUnderLock();
}

/**
 * Verify an already-captured, bounded in-memory packet snapshot ({ memberBuffers, sumsBytes })
 * purely in memory without writing packet files to disk or reopening mutable paths (zero TOCTOU).
 * For PR sourceBundle verification, writes the SHA-256-verified bundle Buffer to an
 * unlinked O_EXCL file descriptor (zero filesystem pathname) passed via /proc/self/fd/0
 * to `git --no-replace-objects bundle unbundle` inside an isolated empty Git repo.
 */
export function verifyEvidencePacketSnapshot({ memberBuffers, sumsBytes }, { archivePrivatePaths = [] } = {}) {
  const errors = [];
  if (!(memberBuffers instanceof Map) || !Buffer.isBuffer(sumsBytes)) {
    return { ok: false, errors: ['Invalid packet snapshot buffers'] };
  }
  if (sumsBytes.length > MAX_EVIDENCE_SUMS_BYTES) {
    return { ok: false, errors: ['SHA256SUMS exceeds the byte limit'] };
  }
  if (memberBuffers.size >= MAX_EVIDENCE_ENTRIES) return { ok: false, errors: ['Too many evidence members'] };
  let totalBytes = sumsBytes.length;
  for (const [path, bytes] of memberBuffers) {
    try { archivePath(path, archivePrivatePaths); }
    catch (err) { return { ok: false, errors: [err.message] }; }
    if (!Buffer.isBuffer(bytes)) return { ok: false, errors: [`Invalid packet member buffer: "${path}"`] };
    if (bytes.length > MAX_EVIDENCE_MEMBER_BYTES) {
      return { ok: false, errors: [`Evidence member "${path}" exceeds the byte limit (${MAX_EVIDENCE_MEMBER_BYTES})`] };
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_EVIDENCE_PACKET_BYTES) {
      return { ok: false, errors: ['Evidence packet exceeds the total byte limit'] };
    }
  }

  const rawSums = sumsBytes.toString('utf8');
  const sumLines = rawSums.split(/\r?\n/).filter(l => l.length > 0);
  const checksumMap = new Map();
  const sumPathsOrder = [];

  for (const line of sumLines) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!m) { errors.push(`Malformed SHA256SUMS line: "${line}"`); continue; }
    const [, digest, rawRel] = m;
    let norm;
    try { norm = normalizeSafeRelativePath(rawRel); } catch (e) {
      errors.push(`Unsafe path in SHA256SUMS: "${rawRel}" (${e.message})`);
      continue;
    }
    if (norm !== rawRel) { errors.push(`Non-canonical path in SHA256SUMS: "${rawRel}"`); continue; }
    if (norm === 'SHA256SUMS') { errors.push('SHA256SUMS must not list itself'); continue; }
    if (checksumMap.has(norm)) { errors.push(`Duplicate path in SHA256SUMS: "${norm}"`); continue; }
    checksumMap.set(norm, digest);
    sumPathsOrder.push(norm);
  }

  const sortedOrder = [...sumPathsOrder].sort();
  if (JSON.stringify(sumPathsOrder) !== JSON.stringify(sortedOrder)) {
    errors.push('SHA256SUMS entries are not sorted by relative path');
  }

  const actualMembers = [...memberBuffers.keys()].sort();
  for (const m of actualMembers) {
    if (m === 'SHA256SUMS') { errors.push('Duplicate SHA256SUMS in snapshot'); continue; }
    if (!checksumMap.has(m)) errors.push(`Extra unlisted file in packet: "${m}"`);
  }
  for (const [rel, expectedDigest] of checksumMap) {
    const buf = memberBuffers.get(rel);
    if (!Buffer.isBuffer(buf)) { errors.push(`Missing file listed in SHA256SUMS: "${rel}"`); continue; }
    const actualDigest = sha256Buffer(buf);
    if (actualDigest !== expectedDigest) {
      errors.push(`SHA-256 mismatch for "${rel}": expected ${expectedDigest}, got ${actualDigest}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  let packet, manifest, runRecord;
  try {
    packet = readArchiveJson(memberBuffers.get('evidence-packet.json'));
    manifest = readArchiveJson(memberBuffers.get('loop-manifest.json'));
    runRecord = readArchiveJson(memberBuffers.get('loop-run.json'));
  } catch (err) {
    return { ok: false, errors: [`Failed to parse core packet JSON: ${err.message}`] };
  }
  const isPlainObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
  if (!isPlainObj(packet) || !isPlainObj(manifest) || !isPlainObj(runRecord)) {
    return { ok: false, errors: ['Core packet JSON documents must be JSON objects'] };
  }

  if (packet.schemaVersion !== 1) errors.push(`Unsupported evidence-packet schemaVersion: ${packet.schemaVersion}`);
  if (packet.run?.verdict !== 'passed') errors.push(`Evidence packet verdict must be "passed", got "${packet.run?.verdict}"`);

  const recomputedManifestHash = sha256Hex(canonicalJson(manifest));
  if (packet.run?.manifestHash !== recomputedManifestHash || runRecord.pin?.manifestHash !== recomputedManifestHash) {
    errors.push(`Manifest hash mismatch (recomputed ${recomputedManifestHash})`);
  }
  if (packet.run?.runId !== runRecord.runId || packet.run?.loopId !== manifest.loopId || packet.run?.loopVersion !== manifest.loopVersion) {
    errors.push('Run/manifest identity mismatch between evidence-packet.json, loop-run.json, and loop-manifest.json');
  }

  const checkFileRef = (ref, label) => {
    if (!ref || typeof ref.path !== 'string' || !SHA256_RE.test(String(ref.sha256 || ''))) {
      errors.push(`Invalid FileRef for ${label}`);
      return false;
    }
    let norm;
    try { norm = normalizeSafeRelativePath(ref.path); } catch (e) {
      errors.push(`Unsafe FileRef path for ${label}: ${e.message}`);
      return false;
    }
    if (norm !== ref.path) { errors.push(`Non-canonical FileRef path for ${label}: "${ref.path}"`); return false; }
    const memDigest = checksumMap.get(norm);
    const buf = memberBuffers.get(norm);
    if (!memDigest || memDigest !== ref.sha256 || !Buffer.isBuffer(buf)) {
      errors.push(`FileRef digest mismatch for ${label} ("${norm}")`);
      return false;
    }
    if (buf.length !== ref.bytes) {
      errors.push(`FileRef byte length mismatch for ${label} ("${norm}"): ${buf.length} != ${ref.bytes}`);
      return false;
    }
    return true;
  };

  checkFileRef(packet.files?.manifest, 'files.manifest');
  checkFileRef(packet.files?.runRecord, 'files.runRecord');
  for (const a of (packet.files?.artifacts || [])) checkFileRef(a, `artifact:${a?.path}`);

  // Parsed schema objects are unique per snapshot. Keep Ajv's cache scoped to this verification.
  const snapshotAjv = new Ajv({ allErrors: true, strict: false });
  const declaredAnchors = manifest.anchors || [];
  if (declaredAnchors.length === 0) errors.push('Evidence packet claims passed verdict with zero declared Anchors');
  const anchorResultsById = new Map();
  for (const a of (packet.anchors || [])) {
    if (!a || !a.anchorId) { errors.push('Malformed Anchor result entry in packet'); continue; }
    if (anchorResultsById.has(a.anchorId)) { errors.push(`Duplicate Anchor result for anchorId "${a.anchorId}"`); continue; }
    anchorResultsById.set(a.anchorId, a);
  }

  const manifestNodeById = new Map((manifest.nodes || []).map(n => [n.nodeId, n]));
  for (const spec of declaredAnchors) {
    const res = anchorResultsById.get(spec.anchorId);
    if (!res) { errors.push(`Missing Anchor result for declared anchor "${spec.anchorId}"`); continue; }
    const manifestAnchorNode = typeof res.nodeId === 'string' ? manifestNodeById.get(res.nodeId) : null;
    if (!manifestAnchorNode || manifestAnchorNode.kind !== 'anchor' || manifestAnchorNode.anchorId !== spec.anchorId) {
      errors.push(`Anchor "${spec.anchorId}" nodeId "${res.nodeId}" does not match a manifest anchor node for "${spec.anchorId}"`);
    }
    const selAttId = typeof res.nodeId === 'string' ? runRecord.selectedAttempts?.[res.nodeId] : null;
    if (typeof res.attemptId !== 'string' || !res.attemptId || typeof selAttId !== 'string' || selAttId !== res.attemptId) {
      errors.push(`Anchor "${spec.anchorId}" attemptId "${res.attemptId}" does not match selected attempt "${selAttId}" for "${res.nodeId}"`);
    }
    if (res.outcome !== 'passed' || res.exitCode !== 0 || res.signal !== null) {
      errors.push(`Anchor "${spec.anchorId}" did not pass cleanly (outcome=${res.outcome}, exit=${res.exitCode}, signal=${res.signal})`);
    }
    if (res.runnerDigest !== spec.implementationDigest) {
      errors.push(`Anchor "${spec.anchorId}" runnerDigest mismatch`);
    }
    const stdoutOk = checkFileRef(res.stdout, `anchor:${spec.anchorId}:stdout`);
    checkFileRef(res.stderr, `anchor:${spec.anchorId}:stderr`);
    if (!res.proof || typeof res.proof !== 'object') {
      errors.push(`Anchor "${spec.anchorId}" is missing res.proof object`);
      continue;
    }
    if (stdoutOk) {
      let stdoutProof = null;
      try { stdoutProof = JSON.parse(memberBuffers.get(res.stdout.path).toString('utf8')); } catch (parseErr) {
        errors.push(`Anchor "${spec.anchorId}" captured stdout is not valid JSON proof: ${parseErr.message}`);
      }
      if (!stdoutProof || typeof stdoutProof !== 'object' || canonicalJson(stdoutProof) !== canonicalJson(res.proof)) {
        errors.push(`Anchor "${spec.anchorId}" res.proof does not match captured stdout JSON`);
      }
    }
    const validateProof = snapshotAjv.compile(spec.proofSchema || { type: 'object' });
    if (!validateProof(res.proof)) {
      errors.push(`Anchor "${spec.anchorId}" proof fails proofSchema`);
    } else {
      const aMap = new Map((res.proof.assertions || []).map(x => [x?.id, x]));
      for (const reqId of spec.requiredAssertions) {
        if (aMap.get(reqId)?.passed !== true) {
          errors.push(`Anchor "${spec.anchorId}" missing passed required assertion "${reqId}"`);
        }
      }
    }
  }

  if (manifest.evidence?.mode === 'pr') {
    const pr = packet.pr;
    if (!pr) {
      errors.push('PR evidence mode requires non-null packet.pr');
    } else {
      if (pr.review?.nodeId !== manifest.evidence.checkerNodeId) {
        errors.push(`PR review nodeId "${pr.review?.nodeId}" != designated checkerNodeId "${manifest.evidence.checkerNodeId}"`);
      }
      if (runRecord.selectedAttempts?.[manifest.evidence.checkerNodeId] !== pr.review?.attemptId) {
        errors.push(`PR review attemptId "${pr.review?.attemptId}" != selected attempt for "${manifest.evidence.checkerNodeId}"`);
      }
      const shas = [
        ['postIntegrationHeadSha', pr.postIntegrationHeadSha],
        ['approvedSourceSha', pr.approvedSourceSha],
        ['review.reviewedSourceSha', pr.review?.reviewedSourceSha],
        ['approval.approvedSourceSha', pr.approval?.approvedSourceSha],
        ['run.provenance.source.postIntegrationHeadSha', runRecord.provenance?.source?.postIntegrationHeadSha],
      ];
      for (const [label, sha] of shas) {
        if (!GIT_SHA_RE.test(String(sha || ''))) errors.push(`Invalid Git SHA for ${label}: "${sha}"`);
      }
      const refSha = pr.approvedSourceSha;
      for (const [label, sha] of shas) {
        if (sha !== refSha) errors.push(`SHA disagreement: ${label} (${sha}) != approvedSourceSha (${refSha})`);
      }
      for (const a of (packet.anchors || [])) {
        if (a.subjectSha !== refSha) errors.push(`Anchor "${a.anchorId}" subjectSha (${a.subjectSha}) != approvedSourceSha (${refSha})`);
      }
      if (pr.review?.disposition !== 'approve') errors.push(`Checker disposition must be "approve", got "${pr.review?.disposition}"`);
      if (pr.approval?.principalKind !== 'operator') errors.push(`Approval principalKind must be "operator", got "${pr.approval?.principalKind}"`);
      const reportOk = checkFileRef(pr.review?.report, 'pr.review.report');
      if (pr.review?.report?.sha256 !== pr.approval?.reviewSha256) {
        errors.push(`Approval reviewSha256 (${pr.approval?.reviewSha256}) != review report sha256 (${pr.review?.report?.sha256})`);
      }
      const recomputedAnchorSet = computeAnchorSetSha256(packet.anchors || []);
      if (recomputedAnchorSet !== pr.approval?.anchorSetSha256) {
        errors.push(`Approval anchorSetSha256 (${pr.approval?.anchorSetSha256}) != recomputed (${recomputedAnchorSet})`);
      }
      if (reportOk) {
        try {
          const repJson = JSON.parse(memberBuffers.get(pr.review.report.path).toString('utf8'));
          if (typeof repJson.reviewedSourceSha !== 'string' || repJson.reviewedSourceSha !== refSha) {
            errors.push(`Review report JSON reviewedSourceSha (${repJson.reviewedSourceSha}) != ${refSha}`);
          }
          if (repJson.disposition !== 'approve') errors.push('Review report JSON disposition must be "approve"');
        } catch (e) {
          errors.push(`Failed to parse review report JSON: ${e.message}`);
        }
      }
      if (!pr.sourceBundle) {
        errors.push('PR evidence mode requires pr.sourceBundle for offline Git verification');
      } else {
        const bundleOk = checkFileRef(pr.sourceBundle, 'pr.sourceBundle');
        if (bundleOk && errors.length === 0) {
          const bundleBuf = memberBuffers.get(pr.sourceBundle.path);
          const tmpVerifyDir = mkdtempSync(join(tmpdir(), 'synapse-verify-bundle-'));
          try {
            const isolatedGitEnv = {
              PATH: process.env.PATH,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_NO_REPLACE_OBJECTS: '1',
            };
            const runIsoGit = (args) => execFileSync('git', ['--no-replace-objects', ...args], {
              cwd: tmpVerifyDir, env: isolatedGitEnv, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            }).trim();
            runIsoGit(['init', '-q']);
            // Pass the exact SHA-256-verified in-memory bundle Buffer through an unlinked O_EXCL fd (zero pathname on disk!)
            const unlinkedPath = join(tmpVerifyDir, '.unlinked-bundle');
            const bundleFd = openSync(unlinkedPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
            let unbundleOut;
            try {
              unlinkSync(unlinkedPath);
              let written = 0;
              while (written < bundleBuf.length) {
                written += writeSync(bundleFd, bundleBuf, written, bundleBuf.length - written, written);
              }
              unbundleOut = execFileSync('git', ['--no-replace-objects', 'bundle', 'unbundle', '/proc/self/fd/0'], {
                cwd: tmpVerifyDir, env: isolatedGitEnv, timeout: 10_000, encoding: 'utf8', stdio: [bundleFd, 'pipe', 'pipe'],
              }).trim();
            } finally {
              closeSync(bundleFd);
            }
            if (verifyBundleSource(runIsoGit, unbundleOut, runRecord.runId, refSha, archivePrivatePaths, errors)) {
              for (const node of (manifest.nodes || [])) {
                const gitOuts = (node.outputs || []).filter(o => o.storage === 'git');
                if (gitOuts.length === 0) continue;
                const selAttId = runRecord.selectedAttempts?.[node.nodeId];
                const att = typeof selAttId === 'string' && selAttId
                  ? (runRecord.nodeAttempts?.[node.nodeId] || []).find(a => a.attemptId === selAttId)
                  : null;
                if (!att) {
                  errors.push(`Missing selected attempt "${selAttId}" for node "${node.nodeId}" with declared Git outputs`);
                  continue;
                }
                for (const go of gitOuts) {
                  const normPath = normalizeSafeRelativePath(go.path);
                  const attOut = (att.outputs || []).find(o => normalizeSafeRelativePath(o.path) === normPath);
                  if (!attOut || !SHA256_RE.test(String(attOut.sha256 || '')) || !Number.isInteger(attOut.bytes) || attOut.bytes < 0) {
                    errors.push(`Missing or malformed selected-attempt Git output record for "${normPath}" on node "${node.nodeId}"`);
                    continue;
                  }
                  if (attOut.deleted === true) {
                    const lsOut = execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', 'ls-tree', '--name-only', refSha, '--', normPath], {
                      cwd: tmpVerifyDir, env: isolatedGitEnv, timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                    }).trim();
                    if (lsOut.length > 0) errors.push(`Deleted/renamed Git output "${normPath}" still exists at ${refSha}`);
                    else if (attOut.bytes !== 0 || attOut.sha256 !== sha256Buffer(Buffer.alloc(0))) {
                      errors.push(`Deleted/renamed Git output "${normPath}" has invalid tombstone digest`);
                    }
                    continue;
                  }
                  const blobBytes = execFileSync('git', ['--no-replace-objects', 'show', `${refSha}:${normPath}`], {
                    cwd: tmpVerifyDir, env: isolatedGitEnv, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
                  });
                  const blobSha = sha256Buffer(blobBytes);
                  if (blobSha !== attOut.sha256 || blobBytes.length !== attOut.bytes) {
                    errors.push(`Git output "${normPath}" at ${refSha} does not match selected-attempt digest (${blobSha} != ${attOut.sha256})`);
                  }
                }
              }
            }
          } catch (gitErr) {
            errors.push(`Git bundle verification failed: ${gitErr.message}`);
          } finally {
            rmSync(tmpVerifyDir, { recursive: true, force: true });
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    evidencePacketSha256: checksumMap.get('evidence-packet.json') || null,
    checksumManifestSha256: sha256Buffer(sumsBytes),
    summary: {
      runId: packet.run?.runId || null,
      loopId: packet.run?.loopId || null,
      loopVersion: packet.run?.loopVersion || null,
      verdict: packet.run?.verdict || null,
      manifestHash: packet.run?.manifestHash || null,
      approvedSourceSha: packet.pr?.approvedSourceSha || null,
      anchorsVerified: declaredAnchors.length,
      membersVerified: memberBuffers.size,
      anchorVerdict: errors.length === 0 ? 'passed' : null,
      checker: packet.pr?.review ? {
        agentId: packet.pr.review.agentId || null,
        provider: packet.pr.review.provider || null,
        sha256: packet.pr.review.report?.sha256 || null,
      } : null,
    },
  };
}


const MAX_EVIDENCE_DEPTH = 16;
const MAX_EVIDENCE_ENTRIES = 512;
const MAX_EVIDENCE_PATH_BYTES = 512;
const MAX_EVIDENCE_SUMS_BYTES = 256 * 1024;
export const MAX_EVIDENCE_MEMBER_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_PACKET_BYTES = 16 * 1024 * 1024;
export const MAX_EVIDENCE_ARCHIVE_BYTES = 24 * 1024 * 1024;

function readSnapshotMember(path, limit) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new LoopError('EVIDENCE_MEMBER_NOT_FILE', 'Evidence member must be a regular file', { statusCode: 409 });
    if (stat.nlink !== 1) throw new LoopError('EVIDENCE_HARDLINK_DENIED', 'Evidence member must have a single link', { statusCode: 409 });
    const capacity = Math.min(stat.size, limit);
    if (stat.size > limit || capacity < 0) {
      throw new LoopError('EVIDENCE_PACKET_TOO_LARGE', `Evidence member "${basename(path)}" exceeds the byte limit (${limit})`, { statusCode: 413 });
    }
    const bytes = Buffer.alloc(capacity);
    let offset = 0;
    while (offset < capacity) {
      const count = readSync(fd, bytes, offset, capacity - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== capacity || readSync(fd, Buffer.alloc(1), 0, 1, null) !== 0) {
      throw new LoopError('EVIDENCE_MEMBER_CHANGED', 'Evidence member changed while being read', { statusCode: 409 });
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Capture each member once under held directory descriptors, without following symlinks. */
export function captureEvidencePacketSnapshot(packetDir, { authorizeRoot = () => true } = {}) {
  const errWith = (code, statusCode = 409) => new LoopError(code, code, { statusCode });
  let rootFd;
  try {
    // Reject redirects in the configured path, including ancestors of the packet root.
    const absoluteDir = pathResolve(packetDir);
    if (realpathSync(absoluteDir) !== absoluteDir) throw errWith('EVIDENCE_SYMLINK_DENIED');
    rootFd = openSync(absoluteDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (err instanceof LoopError) throw err;
    throw errWith('EVIDENCE_PACKET_INVALID', err.code === 'ENOENT' ? 404 : 409);
  }
  try {
    const canonicalDir = realpathSync(`/proc/self/fd/${rootFd}`);
    if (canonicalDir !== pathResolve(packetDir) || !authorizeRoot(canonicalDir)) {
      throw errWith('EVIDENCE_PACKET_SCOPE_DENIED', 403);
    }
    // Walk the entire packet tree from the held-open rootFd, keeping each ancestor dirFd open while opening children!
    const memberBuffers = new Map();
    let sumsBytes = null;
    let totalBytes = 0;
    let entryCount = 0;

    const walkFromFd = (dirFd, relPrefix, depth = 0) => {
      if (depth > MAX_EVIDENCE_DEPTH) throw errWith('EVIDENCE_PACKET_DEPTH_EXCEEDED', 413);
      // Stream directory entries with opendirSync so giant directories abort at MAX_EVIDENCE_ENTRIES in O(limit) RAM/CPU
      const names = [];
      const dirStream = opendirSync(`/proc/self/fd/${dirFd}`);
      try {
        while (true) {
          const dirent = dirStream.readSync();
          if (!dirent) break;
          entryCount++;
          if (entryCount > MAX_EVIDENCE_ENTRIES) throw errWith('EVIDENCE_PACKET_TOO_MANY_ENTRIES', 413);
          names.push(dirent.name);
        }
      } finally {
        dirStream.closeSync();
      }
      names.sort();
      for (const name of names) {
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
          throw errWith('EVIDENCE_MEMBER_PATH_INVALID', 409);
        }
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        if (Buffer.byteLength(rel) > MAX_EVIDENCE_PATH_BYTES) throw errWith('EVIDENCE_MEMBER_PATH_INVALID', 409);
        const childProcPath = `/proc/self/fd/${dirFd}/${name}`;
        const st = lstatSync(childProcPath);
        if (st.isSymbolicLink()) throw errWith('EVIDENCE_SYMLINK_DENIED', 409);
        if (st.isDirectory()) {
          const subFd = openSync(childProcPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
          try {
            walkFromFd(subFd, rel, depth + 1);
          } finally {
            closeSync(subFd);
          }
        } else if (st.isFile()) {
          const memberLimit = rel === 'SHA256SUMS' ? MAX_EVIDENCE_SUMS_BYTES : MAX_EVIDENCE_MEMBER_BYTES;
          const buf = readSnapshotMember(childProcPath, Math.min(memberLimit, MAX_EVIDENCE_PACKET_BYTES - totalBytes));
          totalBytes += buf.length;
          if (rel === 'SHA256SUMS') sumsBytes = buf;
          else memberBuffers.set(rel, buf);
        } else {
          throw errWith('EVIDENCE_MEMBER_NOT_FILE', 409);
        }
      }
    };

    walkFromFd(rootFd, '');
    if (!sumsBytes) throw errWith('EVIDENCE_PACKET_INVALID', 409);
    return { canonicalDir, memberBuffers, sumsBytes };
  } finally {
    closeSync(rootFd);
  }
}

const ARCHIVE_SCHEMA = 'synapse-evidence-archive/v1';
const CORE_MEMBERS = ['evidence-packet.json', 'loop-manifest.json', 'loop-run.json'];
const invalidArchive = (message) => new LoopError('EVIDENCE_ARCHIVE_INVALID', message, { statusCode: 409 });

function archivePath(path, privatePaths = []) {
  if (typeof path !== 'string' || Buffer.byteLength(path) > MAX_EVIDENCE_PATH_BYTES ||
      path.split('/').length > MAX_EVIDENCE_DEPTH + 1 || normalizeSafeRelativePath(path) !== path) {
    throw invalidArchive('Unsafe evidence archive member path');
  }
  const segments = path.toLowerCase().split('/');
  const normalized = '/' + segments.join('/') + '/';
  if (segments.some(s => ['vault', '.proposals', '.git'].includes(s)) ||
      privatePaths.some(p => normalized.includes('/' + p.toLowerCase() + '/'))) {
    throw invalidArchive('Evidence archive contains a private path');
  }
}

function boundedArchiveSnapshot(snapshot, privatePaths = []) {
  const { memberBuffers, sumsBytes } = snapshot;
  if (!(memberBuffers instanceof Map) || !Buffer.isBuffer(sumsBytes) || memberBuffers.has('SHA256SUMS')) {
    throw invalidArchive('Invalid evidence snapshot');
  }
  if (memberBuffers.size >= MAX_EVIDENCE_ENTRIES || sumsBytes.length > MAX_EVIDENCE_SUMS_BYTES) {
    throw invalidArchive('Evidence archive exceeds entry or checksum limits');
  }
  let total = sumsBytes.length;
  const entries = new Set(['SHA256SUMS']);
  for (const [path, bytes] of memberBuffers) {
    archivePath(path, privatePaths);
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_EVIDENCE_MEMBER_BYTES) {
      throw invalidArchive('Invalid evidence archive member size');
    }
    total += bytes.length;
    const parts = path.split('/');
    while (parts.length) {
      const parent = parts.join('/');
      if (parent !== path && memberBuffers.has(parent)) throw invalidArchive('Conflicting evidence archive paths');
      entries.add(parent);
      parts.pop();
    }
    if (total > MAX_EVIDENCE_PACKET_BYTES || entries.size > MAX_EVIDENCE_ENTRIES) {
      throw invalidArchive('Evidence archive exceeds size or entry limits');
    }
  }
  if (sumsBytes.toString('utf8').split('\n', MAX_EVIDENCE_ENTRIES + 2).length > MAX_EVIDENCE_ENTRIES) {
    throw invalidArchive('Evidence archive has too many checksum lines');
  }
}

/** Reconstruct artifact-mode evidence directly from durable FileRefs and the pinned manifest. */
export function captureArtifactPacketSnapshot({ loopStore, run, manifest }) {
  if (manifest.evidence?.mode === 'pr') throw invalidArchive('PR evidence requires a finalized packet');
  const memberBuffers = new Map();
  const sums = new Map();
  let total = 0;
  const artifactRoot = pathResolve(loopStore.artifactsDir);
  if (realpathSync(artifactRoot) !== artifactRoot) throw invalidArchive('Unsafe artifact storage root');
  const rootFd = openSync(artifactRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    if (realpathSync(`/proc/self/fd/${rootFd}`) !== artifactRoot) throw invalidArchive('Unsafe artifact storage root');
    assembleEvidencePacket({
      run, manifest,
      readArtifact(ref) {
        if (!SHA256_RE.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
          throw invalidArchive('Invalid durable artifact reference');
        }
        const bytes = readSnapshotMember(`/proc/self/fd/${rootFd}/${ref.sha256}`,
          Math.min(MAX_EVIDENCE_MEMBER_BYTES, MAX_EVIDENCE_PACKET_BYTES - total, ref.bytes));
        if (bytes.length !== ref.bytes || sha256Buffer(bytes) !== ref.sha256) throw invalidArchive('Durable artifact digest mismatch');
        return bytes;
      },
      writeFile(path, bytes) {
        archivePath(path);
        total += bytes.length;
        if (memberBuffers.size >= MAX_EVIDENCE_ENTRIES - 1 || bytes.length > MAX_EVIDENCE_MEMBER_BYTES || total > MAX_EVIDENCE_PACKET_BYTES) {
          throw new LoopError('EVIDENCE_PACKET_TOO_LARGE', 'Evidence packet exceeds configured limits', { statusCode: 413 });
        }
        const sha256 = sha256Buffer(bytes);
        memberBuffers.set(path, bytes);
        sums.set(path, sha256);
        return { path, sha256, bytes: bytes.length };
      },
    });
  } finally {
    closeSync(rootFd);
  }
  const sumsBytes = Buffer.from([...sums.keys()].sort().map(path => `${sums.get(path)}  ${path}\n`).join(''));
  const snapshot = { memberBuffers, sumsBytes };
  boundedArchiveSnapshot(snapshot);
  return snapshot;
}

function readArchiveJson(bytes) {
  // Bound recursive consumers (canonical hashing, proof schemas) before decoding.
  const input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let nesting = 0;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted && c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '{' || c === '[') && ++nesting > 64) {
      throw invalidArchive('Evidence JSON exceeds depth limit');
    } else if (!quoted && (c === '}' || c === ']')) nesting--;
  }
  return JSON.parse(input);
}

function validateArchiveMembers({ memberBuffers }, privatePaths) {
  const [packet, manifest, run] = CORE_MEMBERS.map(p => readArchiveJson(memberBuffers.get(p)));
  if (run.phase !== 'terminal' || run.verdict !== 'passed' ||
      run.pin?.loopId !== packet.run?.loopId || run.pin?.loopVersion !== packet.run?.loopVersion) {
    throw invalidArchive('Run record does not bind to a passed packet');
  }
  const refs = new Set(CORE_MEMBERS);
  const include = (ref, expectedPrefix, exact = false) => {
    if (!ref || (exact ? ref.path !== expectedPrefix : !ref.path?.startsWith(expectedPrefix))) {
      throw invalidArchive('Evidence file reference has an unexpected path');
    }
    refs.add(ref.path);
  };
  include(packet.files?.manifest, 'loop-manifest.json', true);
  include(packet.files?.runRecord, 'loop-run.json', true);
  const durableArtifacts = new Map();
  const bindArtifact = (nodeId, attemptId, ref) => {
    if (!ref?.sha256) return;
    const path = `artifacts/${nodeId}/${attemptId}/${normalizeSafeRelativePath(ref.path)}`;
    archivePath(path, privatePaths);
    const prior = durableArtifacts.get(path);
    if (prior && (prior.sha256 !== ref.sha256 || prior.bytes !== ref.bytes)) {
      throw invalidArchive('Conflicting artifact records in the durable run');
    }
    durableArtifacts.set(path, ref);
  };
  for (const [nodeId, attemptId] of Object.entries(run.selectedAttempts || {})) {
    const attempt = (run.nodeAttempts?.[nodeId] || []).find(a => a.attemptId === attemptId);
    for (const ref of attempt?.outputs || []) bindArtifact(nodeId, attemptId, ref);
  }
  for (const anchor of run.anchors || []) {
    if (run.selectedAttempts?.[anchor.nodeId] !== anchor.attemptId) continue;
    bindArtifact(anchor.nodeId, anchor.attemptId, anchor.stdout);
    bindArtifact(anchor.nodeId, anchor.attemptId, anchor.stderr);
  }
  const review = run._checkerReview;
  if (manifest.evidence?.mode === 'pr' && review) bindArtifact(review.nodeId, review.attemptId, review.report);
  const artifacts = packet.files.artifacts || [];
  const artifactPaths = new Set();
  for (const ref of artifacts) {
    include(ref, 'artifacts/');
    const durable = durableArtifacts.get(ref.path);
    if (artifactPaths.has(ref.path) || durable?.sha256 !== ref.sha256 || durable?.bytes !== ref.bytes) {
      throw invalidArchive('Packet artifact is duplicated or unbound to its durable record');
    }
    artifactPaths.add(ref.path);
  }
  if (artifactPaths.size !== durableArtifacts.size) throw invalidArchive('Packet is missing a durable artifact');
  const declared = new Set((manifest.anchors || []).map(a => a.anchorId));
  for (const anchor of packet.anchors || []) {
    const durable = (run.anchors || []).find(a => a.anchorId === anchor.anchorId &&
      a.nodeId === anchor.nodeId && a.attemptId === anchor.attemptId);
    if (!declared.has(anchor.anchorId) || !durable) throw invalidArchive('Unexpected Anchor in evidence archive');
    const prefix = `artifacts/${anchor.nodeId}/${anchor.attemptId}/`;
    for (const stream of ['stdout', 'stderr']) {
      const original = durable[stream];
      const ref = anchor[stream];
      include(ref, prefix + normalizeSafeRelativePath(original?.path), true);
      if (ref.sha256 !== original.sha256 || ref.bytes !== original.bytes) {
        throw invalidArchive('Anchor stream differs from its durable record');
      }
    }
    readArchiveJson(memberBuffers.get(anchor.stdout.path));
  }
  if (manifest.evidence?.mode === 'pr') {
    const pr = packet.pr;
    include(pr?.sourceBundle, 'source.bundle', true);
    if (!review || ['nodeId', 'attemptId', 'sessionId', 'agentId', 'agentInstanceId', 'provider', 'model', 'reviewedSourceSha', 'disposition']
      .some(key => pr.review?.[key] !== review[key]) ||
      pr.review.report?.sha256 !== review.report?.sha256) {
      throw invalidArchive('Checker identity or digest differs from the durable run');
    }
    include(pr.review.report,
      `artifacts/${review.nodeId}/${review.attemptId}/${normalizeSafeRelativePath(review.report?.path)}`, true);
    readArchiveJson(memberBuffers.get(pr.review.report.path));
  } else if (packet.pr != null) {
    throw invalidArchive('Unexpected PR section for artifact evidence');
  }
  if (refs.size !== memberBuffers.size || [...refs].some(path => !memberBuffers.has(path))) {
    throw invalidArchive('Unexpected or missing evidence archive member');
  }
  return packet;
}

function archiveMetadata(snapshot, packet) {
  return {
    runId: packet.run?.runId,
    loopId: packet.run?.loopId,
    loopVersion: packet.run?.loopVersion,
    manifestHash: packet.run?.manifestHash,
    approvedSourceSha: packet.pr?.approvedSourceSha || null,
    evidencePacketSha256: sha256Buffer(snapshot.memberBuffers.get('evidence-packet.json')),
    checksumManifestSha256: sha256Buffer(snapshot.sumsBytes),
  };
}

function encodeArchive(snapshot, metadata) {
  const { memberBuffers, sumsBytes } = snapshot;
  const members = [...memberBuffers, ['SHA256SUMS', sumsBytes]]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => [path, bytes.toString('base64')]);
  return Buffer.from(JSON.stringify({ schemaVersion: ARCHIVE_SCHEMA, metadata, members }) + '\n');
}

/** Encode the exact bytes of a bounded packet after verification. */
export function buildEvidenceArchive(snapshot, { privatePaths = [] } = {}) {
  boundedArchiveSnapshot(snapshot, privatePaths);
  const packet = validateArchiveMembers(snapshot, privatePaths);
  const metadata = archiveMetadata(snapshot, packet);
  const result = verifyEvidencePacketSnapshot(snapshot, { archivePrivatePaths: privatePaths });
  if (!result.ok) throw invalidArchive('Evidence packet failed verification');
  return encodeArchive(snapshot, metadata);
}

/** Parse the canonical archive format without extracting files. */
export function parseEvidenceArchive(input, { privatePaths = [] } = {}) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) throw invalidArchive('Evidence archive must be JSON bytes');
  if (Buffer.byteLength(input) > MAX_EVIDENCE_ARCHIVE_BYTES) throw invalidArchive('Evidence archive exceeds byte limit');
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const envelope = readArchiveJson(raw);
  if (envelope?.schemaVersion !== ARCHIVE_SCHEMA || !Array.isArray(envelope.members) ||
      envelope.members.length > MAX_EVIDENCE_ENTRIES) {
    throw invalidArchive('Unsupported evidence archive schema or entry count');
  }
  const memberBuffers = new Map();
  let sumsBytes;
  let total = 0;
  for (const entry of envelope.members) {
    if (!Array.isArray(entry) || entry.length !== 2) throw invalidArchive('Malformed evidence archive entry');
    const [path, base64] = entry;
    archivePath(path, privatePaths);
    const cap = path === 'SHA256SUMS' ? MAX_EVIDENCE_SUMS_BYTES : MAX_EVIDENCE_MEMBER_BYTES;
    if (typeof base64 !== 'string' || base64.length > Math.ceil(cap / 3) * 4) {
      throw invalidArchive('Invalid base64 evidence archive entry');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || bytes.length > cap) {
      throw invalidArchive('Invalid base64 evidence archive entry');
    }
    total += bytes.length;
    if (total > MAX_EVIDENCE_PACKET_BYTES || memberBuffers.has(path) || (path === 'SHA256SUMS' && sumsBytes)) {
      throw invalidArchive('Duplicate evidence archive entry or size limit exceeded');
    }
    if (path === 'SHA256SUMS') sumsBytes = bytes;
    else memberBuffers.set(path, bytes);
  }
  const snapshot = { memberBuffers, sumsBytes };
  boundedArchiveSnapshot(snapshot, privatePaths);
  const packet = validateArchiveMembers(snapshot, privatePaths);
  const metadata = archiveMetadata(snapshot, packet);
  // A single wire representation rejects duplicate JSON keys, extra metadata and moved digests.
  if (!raw.equals(encodeArchive(snapshot, metadata))) throw invalidArchive('Noncanonical archive or metadata mismatch');
  return { ...snapshot, metadata };
}

export function verifyEvidenceArchive(input, { archivePrivatePaths = [] } = {}) {
  try {
    const snapshot = parseEvidenceArchive(input, { privatePaths: archivePrivatePaths });
    return verifyEvidencePacketSnapshot(snapshot, { archivePrivatePaths });
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}
