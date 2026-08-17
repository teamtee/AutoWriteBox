import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicErrorCode, publicHttpError, sendJsonError } from '../http-error.js';

const filesystemError = (code, message = `${code}: /private/local/path`) =>
  Object.assign(new Error(message), { code });

test('文件系统故障映射为稳定 5xx 错误且不泄露本地路径', () => {
  assert.deepEqual(publicHttpError(filesystemError('ENOSPC')), {
    status: 507, error: 'STORAGE_FULL',
  });
  assert.deepEqual(publicHttpError(filesystemError('EROFS')), {
    status: 500, error: 'STORAGE_PERMISSION_DENIED',
  });
  assert.deepEqual(publicHttpError(filesystemError('EIO')), {
    status: 500, error: 'STORAGE_IO_ERROR',
  });
  assert.deepEqual(publicHttpError(filesystemError('EMFILE')), {
    status: 503, error: 'STORAGE_FILE_LIMIT',
  });
  assert.deepEqual(publicHttpError(filesystemError('ENOTDIR')), {
    status: 500, error: 'STORAGE_PATH_INVALID',
  });
  assert.doesNotMatch(publicErrorCode(filesystemError('ENOSPC')), /private|path/);
});

test('损坏存储 JSON 和未知内部异常不会回显解析文本或堆栈', () => {
  assert.deepEqual(publicHttpError(new SyntaxError('Unexpected token at /secret/book.json')), {
    status: 500, error: 'STORAGE_JSON_INVALID',
  });
  assert.deepEqual(publicHttpError(new Error('unexpected failure at /secret/file')), {
    status: 500, error: 'INTERNAL_ERROR',
  });
  assert.deepEqual(publicHttpError(new Error('UNKNOWN_INTERNAL_INVARIANT')), {
    status: 500, error: 'INTERNAL_ERROR',
  });
  assert.deepEqual(publicHttpError(new Error('BAD_BOOK_UPDATED_AT_ROLLBACK')), {
    status: 500, error: 'INTERNAL_ERROR',
  });
  assert.deepEqual(publicHttpError(new Error(`LLM_FINISH_${'A'.repeat(200)}`)), {
    status: 500, error: 'INTERNAL_ERROR',
  });
});

test('Express 路由参数解码错误按客户端路径问题返回', () => {
  const error = Object.assign(new URIError('Failed to decode param /private/path'), {
    status: 400,
  });
  assert.deepEqual(publicHttpError(error), { status: 400, error: 'BAD_ID' });
});

test('业务错误保留语义化 HTTP 状态并可直接发送 JSON', () => {
  assert.deepEqual(publicHttpError(new Error('BOOK_NOT_FOUND')), {
    status: 404, error: 'BOOK_NOT_FOUND',
  });
  assert.deepEqual(publicHttpError(new Error('BOOK_ALREADY_EXISTS')), {
    status: 409, error: 'BOOK_ALREADY_EXISTS',
  });
  assert.deepEqual(publicHttpError(new Error('BOOK_TITLE_CONFLICT')), {
    status: 409, error: 'BOOK_TITLE_CONFLICT',
  });
  assert.deepEqual(publicHttpError(new Error('BOOK_DELETE_CONFLICT')), {
    status: 409, error: 'BOOK_DELETE_CONFLICT',
  });
  assert.deepEqual(publicHttpError(new Error('NEXT_SECTION_CONFLICT')), {
    status: 409, error: 'NEXT_SECTION_CONFLICT',
  });
  assert.deepEqual(publicHttpError(new Error('NEXT_CHAPTER_CONFLICT')), {
    status: 409, error: 'NEXT_CHAPTER_CONFLICT',
  });
  assert.deepEqual(publicHttpError(new Error('GENERATION_CONTEXT_CONFLICT')), {
    status: 409, error: 'GENERATION_CONTEXT_CONFLICT',
  });
  assert.deepEqual(publicHttpError(new Error('CHAPTER_PLAN_QUALITY_DOWNGRADE')), {
    status: 409, error: 'CHAPTER_PLAN_QUALITY_DOWNGRADE',
  });
  assert.deepEqual(publicHttpError(new Error('CHAPTER_PLAN_DESIGN_DOWNGRADE')), {
    status: 409, error: 'CHAPTER_PLAN_DESIGN_DOWNGRADE',
  });
  assert.deepEqual(publicHttpError(new Error('CHAPTER_PLAN_RHYTHM_DOWNGRADE')), {
    status: 409, error: 'CHAPTER_PLAN_RHYTHM_DOWNGRADE',
  });
  assert.deepEqual(publicHttpError(new Error('STYLE_BIBLE_FAILED')), {
    status: 502, error: 'STYLE_BIBLE_FAILED',
  });
  assert.deepEqual(publicHttpError(new Error('STRUCTURE_TRANSACTION_RECOVERED')), {
    status: 409, error: 'STRUCTURE_TRANSACTION_RECOVERED',
  });
  assert.deepEqual(publicHttpError(new Error('REVIEW_CONTEXT_STALE')), {
    status: 409, error: 'REVIEW_CONTEXT_STALE',
  });
  assert.deepEqual(publicHttpError(new Error('BACKUP_TOO_LARGE')), {
    status: 413, error: 'BACKUP_TOO_LARGE',
  });
  assert.deepEqual(publicHttpError(new Error('MANUSCRIPT_TOO_LARGE')), {
    status: 413, error: 'MANUSCRIPT_TOO_LARGE',
  });
  assert.deepEqual(publicHttpError(new Error('MANUSCRIPT_EMPTY')), {
    status: 400, error: 'MANUSCRIPT_EMPTY',
  });
  assert.deepEqual(publicHttpError(new Error('BAD_MANUSCRIPT_SOURCE')), {
    status: 400, error: 'BAD_MANUSCRIPT_SOURCE',
  });
  assert.deepEqual(publicHttpError(new Error('BACKUP_EXPORT_BUSY')), {
    status: 429, error: 'BACKUP_EXPORT_BUSY',
  });
  assert.deepEqual(publicHttpError(new Error('BACKUP_DOWNLOAD_NOT_FOUND')), {
    status: 404, error: 'BACKUP_DOWNLOAD_NOT_FOUND',
  });
  assert.deepEqual(publicHttpError(new Error('STORAGE_FILE_TOO_LARGE')), {
    status: 500, error: 'STORAGE_FILE_TOO_LARGE',
  });
  assert.deepEqual(publicHttpError(new Error('STORAGE_DATA_INVALID')), {
    status: 500, error: 'STORAGE_DATA_INVALID',
  });
  assert.deepEqual(publicHttpError(new Error('STORAGE_PATH_UNSAFE')), {
    status: 500, error: 'STORAGE_PATH_UNSAFE',
  });
  assert.deepEqual(publicHttpError(new Error('STORAGE_DIRECTORY_LIMIT_EXCEEDED')), {
    status: 500, error: 'STORAGE_DIRECTORY_LIMIT_EXCEEDED',
  });
  assert.deepEqual(publicHttpError(new Error('BACKUP_BOOK_INVALID')), {
    status: 500, error: 'BACKUP_BOOK_INVALID',
  });
  assert.deepEqual(publicHttpError(new Error('BACKUP_SECTION_INVALID')), {
    status: 500, error: 'BACKUP_SECTION_INVALID',
  });
  assert.deepEqual(publicHttpError(new Error('TRASH_BOOK_INVALID')), {
    status: 500, error: 'TRASH_BOOK_INVALID',
  });
  for (const code of [
    'BOOK_SECTIONS_INVALID', 'BOOK_SECTIONS_LIMIT_EXCEEDED',
    'SECTION_CHAPTERS_INVALID', 'SECTION_CHAPTERS_LIMIT_EXCEEDED',
    'BOOK_CHAPTERS_LIMIT_EXCEEDED', 'CHAPTER_ID_MISMATCH',
  ]) {
    assert.deepEqual(publicHttpError(new Error(code)), {
      status: 500, error: 'STORAGE_DATA_INVALID',
    });
  }
  assert.deepEqual(publicHttpError(new Error('BAD_PREMISE')), {
    status: 400, error: 'BAD_PREMISE',
  });
  for (const code of ['LLM_MODEL_INVALID', 'LLM_API_KEY_INVALID']) {
    assert.deepEqual(publicHttpError(new Error(code)), { status: 400, error: code });
  }
  assert.deepEqual(publicHttpError(new Error('LLM_HTTP_429: quota exceeded')), {
    status: 502, error: 'LLM_HTTP_429: quota exceeded',
  });
  assert.deepEqual(publicHttpError(new Error('LLM_STREAM_ERROR: LLM_SSE_INVALID_EVENT')), {
    status: 502, error: 'LLM_STREAM_ERROR: LLM_SSE_INVALID_EVENT',
  });
  assert.deepEqual(publicHttpError(new Error('LLM_TIMEOUT')), {
    status: 504, error: 'LLM_TIMEOUT',
  });
  for (const code of [
    'STRUCTURE_TRANSACTION_INVALID',
    'STRUCTURE_TRANSACTION_TOO_LARGE',
    'STRUCTURE_TRANSACTION_UNREADABLE',
    'STRUCTURE_TRANSACTION_TARGET_CONFLICT',
    'CHAPTER_DIGEST_TRANSACTION_INVALID',
    'CHAPTER_DIGEST_TRANSACTION_TOO_LARGE',
    'CHAPTER_DIGEST_TRANSACTION_UNREADABLE',
    'CHAPTER_DIGEST_TRANSACTION_TARGET_CONFLICT',
  ]) {
    assert.deepEqual(publicHttpError(new Error(code)), {
      status: 500, error: 'STORAGE_DATA_INVALID',
    });
  }

  const response = {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  sendJsonError(response, filesystemError('ENOSPC'));
  assert.equal(response.statusCode, 507);
  assert.deepEqual(response.payload, { error: 'STORAGE_FULL' });
});
