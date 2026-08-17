#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function fingerprint(content) {
  return createHash('sha256').update(content).digest('base64url');
}

const [, , manifestArgument, outputArgument] = process.argv;

if (!manifestArgument || !outputArgument) {
  fail('用法：node scripts/export-blind-read.js <正文候选清单.json> <盲读稿.txt>');
} else {
  const manifestPath = resolve(manifestArgument);
  const outputPath = resolve(outputArgument);
  const manifestDirectory = dirname(manifestPath);

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.kind !== 'chapter-draft-candidate-manifest') {
      throw new Error('清单 kind 不是 chapter-draft-candidate-manifest');
    }
    if (!Array.isArray(manifest.chapters) || manifest.chapters.length === 0) {
      throw new Error('清单没有章节');
    }

    const chapters = [...manifest.chapters].sort((left, right) => left.index - right.index);
    const sections = [`《${manifest.bookTitle}》`];
    let totalNonWhitespaceCharacters = 0;

    for (const chapter of chapters) {
      const chapterPath = resolve(manifestDirectory, chapter.path);
      const body = await readFile(chapterPath, 'utf8');
      const actualFingerprint = fingerprint(body);
      const actualCharacters = body.replace(/\s/gu, '').length;
      if (actualFingerprint !== chapter.bodyFingerprint) {
        throw new Error(`第 ${chapter.index} 章正文指纹与清单不一致`);
      }
      if (actualCharacters !== chapter.nonWhitespaceCharacters) {
        throw new Error(`第 ${chapter.index} 章字符数与清单不一致`);
      }
      if (/^#|```/mu.test(body)) {
        throw new Error(`第 ${chapter.index} 章混入标题、围栏或作者说明`);
      }
      totalNonWhitespaceCharacters += actualCharacters;
      sections.push(`第${String(chapter.index).padStart(2, '0')}章 ${chapter.title}\n\n${body.trim()}`);
    }

    if (totalNonWhitespaceCharacters !== manifest.totalNonWhitespaceCharacters) {
      throw new Error('十章字符总数与清单不一致');
    }

    const output = `${sections.join('\n\n\n')}\n`;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, output, 'utf8');
    process.stdout.write(`${JSON.stringify({
      outputPath,
      chapters: chapters.length,
      sourceCharacters: totalNonWhitespaceCharacters,
      outputFingerprint: fingerprint(output),
    })}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
