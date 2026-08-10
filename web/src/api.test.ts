import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  activateApiProfile, addChapter, addSection, ApiResponseError, createBook, createClientBookId, createWritingAssetReference, deactivateMemoryFact, decideMemoryCandidate, deleteApiProfile, deleteBook, deletePlatformConfirmation,
  deleteWritingAsset, discoverApiModels, downloadBookBackup, downloadBookManuscript, extractBookNativeWritingAsset, extractWritingAsset, getChapter, getChapterPublicationPreflight, getConfig, getStorageDiagnostics, getWritingAssets,
  getApiProfiles, getBookMemory, importBookBackup, isAmbiguousApiFailure, isApiErrorCode, listBooks, listDeletedBooks,
  parseSSELines,
  readableApiError, recomputeChapterMemory, renameBook, reviewChapter, saveApiBookBinding,
  saveApiProfile, saveApiTaskRoutes,
  saveConfig, savePlatformConfirmation, saveSerializationSettings, saveWritingAssetBookBinding, streamGen, versionSave,
} from './api';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('request cancellation', () => {
  it('passes the settings abort signal to fetch', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      baseUrl: '', model: '', apiKey: '', chapterWordTarget: 2000,
      requestTimeoutMs: 300000, revision: 'R'.repeat(43),
    }), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    await getConfig(controller.signal);

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/config', {
      signal: controller.signal,
    });
  });
});

describe('writing asset API', () => {
  it('loads, extracts and deletes assets with the expected contracts', async () => {
    globalThis.fetch = vi.fn(async (path, init) => {
      if (path === '/api/writing-assets' && !init) {
        return new Response(JSON.stringify({ revision: 'R'.repeat(43), assets: [] }));
      }
      if (path === '/api/writing-assets/extract') {
        return new Response(JSON.stringify({ revision: 'N'.repeat(43), asset: { id: 'asset_1' } }));
      }
      if (path === '/api/writing-assets/reference') {
        return new Response(JSON.stringify({ revision: 'L'.repeat(43), asset: { id: 'asset_2' } }));
      }
      if (path === '/api/writing-assets/books/book_test/sections/section_test/chapters/chapter_test/native') {
        return new Response(JSON.stringify({ revision: 'T'.repeat(43), asset: { id: 'asset_3' } }));
      }
      if (path === '/api/writing-assets/books/book_test') {
        return new Response(JSON.stringify({ revision: 'B'.repeat(43), binding: {} }));
      }
      return new Response(JSON.stringify({ ok: true, revision: 'D'.repeat(43) }));
    }) as unknown as typeof fetch;

    await expect(getWritingAssets()).resolves.toEqual({ revision: 'R'.repeat(43), assets: [] });
    await extractWritingAsset({
      name: '资产', sourceName: '来源', sourceKind: 'self', sourceText: '样本',
    });
    await createWritingAssetReference({
      name: '索引', sourceName: '网页', sourceKind: 'link-only',
      referenceUrl: 'https://example.com/reference',
    });
    await extractBookNativeWritingAsset(
      'book_test', 'section_test', 'chapter_test', '本书原生',
    );
    const binding = {
      nativeAssetId: null, primaryAssetId: null,
      auxiliaryAssetIds: [], sceneAssetIds: {}, chapterScenes: {},
    };
    await saveWritingAssetBookBinding('book_test', binding, 'L'.repeat(43));
    await deleteWritingAsset(`asset_${'a'.repeat(32)}`, 'N'.repeat(43));

    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/api/writing-assets/extract', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        name: '资产', sourceName: '来源', sourceKind: 'self', sourceText: '样本',
      }),
    }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3, '/api/writing-assets/reference', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        name: '索引', sourceName: '网页', sourceKind: 'link-only',
        referenceUrl: 'https://example.com/reference',
      }),
    }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(4, '/api/writing-assets/books/book_test/sections/section_test/chapters/chapter_test/native', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ name: '本书原生' }),
    }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(5, '/api/writing-assets/books/book_test', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ binding, expectedRevision: 'L'.repeat(43) }),
    }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(6, `/api/writing-assets/asset_${'a'.repeat(32)}`, expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ expectedRevision: 'N'.repeat(43) }),
    }));
  });

  it('maps asset extraction failures to actionable text', () => {
    expect(readableApiError('ASSET_EXTRACTION_FAILED')).toContain('没有创建资产');
    expect(readableApiError('ASSET_SOURCE_TOO_LARGE')).toContain('10 万字符');
    expect(readableApiError('ASSET_DUPLICATE')).toContain('未重复调用模型');
    expect(readableApiError('BAD_ASSET_RIGHTS_NOTE')).toContain('权利说明');
    expect(readableApiError('ASSET_NATIVE_SOURCE_UNPUBLISHED')).toContain('已确认发布');
  });
});

describe('long-term memory API', () => {
  it('recomputes candidates against an explicit body fingerprint', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      bodyFingerprint: 'F'.repeat(43), memoryCandidates: [], memoryRevision: 'R'.repeat(43),
    }))) as unknown as typeof fetch;
    await recomputeChapterMemory('book one', 'section one', 'chapter one', 'F'.repeat(43));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book%20one/sections/section%20one/chapters/chapter%20one/memory/recompute',
      expect.objectContaining({
        method: 'POST', body: JSON.stringify({ expectedBodyFingerprint: 'F'.repeat(43) }),
      }),
    );
  });

  it('sends explicit source and memory revisions with a candidate decision', async () => {
    const response = {
      candidate: { id: `memory_${'a'.repeat(32)}`, status: 'accepted' },
      candidates: [], memoryRevision: 'N'.repeat(43),
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    await expect(decideMemoryCandidate(
      'book one', 'section one', 'chapter one', `memory_${'a'.repeat(32)}`,
      'replace', 'F'.repeat(43), 'R'.repeat(43),
    )).resolves.toEqual(response);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      `/api/books/book%20one/sections/section%20one/chapters/chapter%20one/`
        + `memory-candidates/memory_${'a'.repeat(32)}/decision`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          action: 'replace',
          expectedBodyFingerprint: 'F'.repeat(43),
          expectedMemoryRevision: 'R'.repeat(43),
        }),
      }),
    );
  });

  it('maps conflicts and stale candidates to actionable text', () => {
    expect(readableApiError('MEMORY_CONFLICT')).toContain('显式替换');
    expect(readableApiError('MEMORY_SOURCE_STALE')).toContain('正文已经变化');
  });

  it('loads the central library and deactivates a fact with its revision', async () => {
    globalThis.fetch = vi.fn(async (path) => new Response(JSON.stringify(
      String(path).endsWith('/memory')
        ? { facts: [], plotSummary: '', sectionSummaryCount: 0, memoryRevision: 'R'.repeat(43) }
        : { fact: { id: `memory_${'a'.repeat(32)}`, status: 'stale' }, memoryRevision: 'N'.repeat(43) },
    ), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    await getBookMemory('book one');
    await deactivateMemoryFact('book one', `memory_${'a'.repeat(32)}`, 'R'.repeat(43));

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/books/book%20one/memory');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2, `/api/books/book%20one/memory-facts/memory_${'a'.repeat(32)}/deactivate`,
      expect.objectContaining({
        method: 'POST', body: JSON.stringify({ expectedMemoryRevision: 'R'.repeat(43) }),
      }),
    );
  });
});

describe('publication preflight API', () => {
  it('anchors the read-only check to the current saved body fingerprint', async () => {
    const response = {
      bodyFingerprint: 'F'.repeat(43), checkedAt: '2026-08-10T00:00:00.000Z',
      status: 'attention', characterCount: 1200, paragraphCount: 30,
      reviewCurrent: false, duplicateCount: 0, duplicateMatches: [], checks: [],
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    await expect(getChapterPublicationPreflight(
      'book one', 'section one', 'chapter one', 'F'.repeat(43),
    )).resolves.toEqual(response);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book%20one/sections/section%20one/chapters/chapter%20one/publication/preflight',
      expect.objectContaining({
        method: 'POST', body: JSON.stringify({ expectedBodyFingerprint: 'F'.repeat(43) }),
      }),
    );
  });
});

describe('API profile library', () => {
  it('loads, saves, activates and deletes profiles with separate revisions', async () => {
    globalThis.fetch = vi.fn(async (path) => {
      const value = String(path);
      if (value === '/api/config/profiles') return new Response(JSON.stringify({
        version: 1, activeProfileId: null, profiles: [], revision: 'P'.repeat(43),
      }));
      if (value.endsWith('/activate')) return new Response(JSON.stringify({
        config: { model: 'smart', revision: 'C'.repeat(43) },
        library: { version: 1, activeProfileId: 'profile_1', profiles: [], revision: 'N'.repeat(43) },
      }));
      if (value.includes('/profile_')) return new Response(JSON.stringify({ ok: true, revision: 'D'.repeat(43) }));
      return new Response(JSON.stringify({ profile: { id: 'profile_1' }, revision: 'S'.repeat(43) }));
    }) as unknown as typeof fetch;

    await getApiProfiles();
    await saveApiProfile({
      name: '主服务', note: '', models: ['fast', 'smart'], selectedModel: 'fast',
      useCurrentConfig: true,
    }, 'P'.repeat(43), 'C'.repeat(43));
    await activateApiProfile('profile_1', 'smart', 'S'.repeat(43), 'C'.repeat(43));
    await deleteApiProfile('profile_1', 'N'.repeat(43));

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/config/profiles');
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3, '/api/config/profiles/profile_1/activate', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        model: 'smart', expectedProfilesRevision: 'S'.repeat(43),
        expectedConfigRevision: 'C'.repeat(43),
      }),
    }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(4, '/api/config/profiles/profile_1', expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ expectedRevision: 'N'.repeat(43) }),
    }));
  });

  it('用不同修订号发现当前配置或方案的模型', async () => {
    const result = {
      ok: true, models: ['fast', 'smart'], truncated: false,
      currentModel: 'fast', currentModelAvailable: true,
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(result))) as unknown as typeof fetch;

    await expect(discoverApiModels({
      target: 'current', expectedConfigRevision: 'C'.repeat(43),
    })).resolves.toEqual(result);
    await discoverApiModels({
      target: 'profile', profileId: 'profile_1', expectedProfilesRevision: 'P'.repeat(43),
    });

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/config/models', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        target: 'current', expectedConfigRevision: 'C'.repeat(43),
      }),
    }));
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/api/config/models', expect.objectContaining({
      method: 'POST', body: JSON.stringify({
        target: 'profile', profileId: 'profile_1', expectedProfilesRevision: 'P'.repeat(43),
      }),
    }));
    expect(readableApiError('LLM_MODELS_RESPONSE_INVALID')).toContain('/models');
  });

  it('保存五类任务的显式模型分工', async () => {
    const taskRoutes = {
      chapter: { profileId: 'profile_1', model: 'smart' },
      outline: null, digest: null, review: null, title: null,
    };
    const response = {
      version: 1, activeProfileId: null, profiles: [], taskRoutes,
      revision: 'N'.repeat(43),
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(response))) as unknown as typeof fetch;

    await expect(saveApiTaskRoutes(taskRoutes, 'P'.repeat(43))).resolves.toEqual(response);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/config/profiles/routing', expect.objectContaining({
        method: 'POST', body: JSON.stringify({
          taskRoutes, expectedRevision: 'P'.repeat(43),
        }),
      }),
    );
    expect(readableApiError('BAD_API_TASK_ROUTES')).toContain('已删除');
  });

  it('保存或清除单书固定模型', async () => {
    const response = {
      version: 1, activeProfileId: null, profiles: [],
      taskRoutes: { chapter: null, outline: null, digest: null, review: null, title: null },
      bookBindings: [{ bookId: 'book-one', profileId: 'profile_1', model: 'smart' }],
      revision: 'N'.repeat(43),
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(response))) as unknown as typeof fetch;

    await saveApiBookBinding(
      'book-one', { profileId: 'profile_1', model: 'smart' }, 'P'.repeat(43),
    );
    await saveApiBookBinding('book-one', null, 'N'.repeat(43));

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1, '/api/config/profiles/books/book-one', expect.objectContaining({
        method: 'POST', body: JSON.stringify({
          binding: { profileId: 'profile_1', model: 'smart' },
          expectedRevision: 'P'.repeat(43),
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2, '/api/config/profiles/books/book-one', expect.objectContaining({
        method: 'POST', body: JSON.stringify({
          binding: null, expectedRevision: 'N'.repeat(43),
        }),
      }),
    );
  });
});

describe('parseSSELines', () => {
  it('解析多条 data 行并保留残尾', () => {
    const { events, rest } = parseSSELines(
      'data: {"delta":"你"}\n\ndata: {"delta":"好"}\n\ndata: {"del', ''
    );
    expect(events).toEqual([{ delta: '你' }, { delta: '好' }]);
    expect(rest).toMatch(/del/);
  });
  it('解析 done 事件', () => {
    const { events } = parseSSELines('data: {"done":true}\n\n', '');
    expect(events).toEqual([{ done: true }]);
  });
  it('以首个终止帧为边界，忽略同一网络块中的后续异常或正文', () => {
    expect(parseSSELines(
      'data: {"done":true}\n\ndata: {broken json}\n\ndata: {"delta":"不应接受"}\n\n',
      '',
    ).events).toEqual([{ done: true }]);
    expect(parseSSELines(
      'data: {"error":"LLM_TIMEOUT"}\n\ndata: {"done":true}\n\n',
      '',
    ).events).toEqual([{ error: 'LLM_TIMEOUT' }]);
  });
  it('兼容 CRLF 格式的 SSE', () => {
    const { events, rest } = parseSSELines('data: {"delta":"你好"}\r\n\r\ndata: {"done":true}\r\n\r\n', '');
    expect(events).toEqual([{ delta: '你好' }, { done: true }]);
    expect(rest).toBe('');
  });
  it('忽略服务端用于保持代理连接的 SSE 注释心跳', () => {
    const { events, rest } = parseSSELines(
      ': keepalive\n\ndata: {"delta":"继续"}\n\n: keepalive\n\n', '',
    );
    expect(events).toEqual([{ delta: '继续' }]);
    expect(rest).toBe('');
  });
  it('拒绝已经完整分帧的损坏 JSON，不把它误当作半包静默丢弃', () => {
    expect(() => parseSSELines(
      'data: {"delta":"损坏"\n\ndata: {"done":true}\n\n', '',
    )).toThrow('生成中断：响应格式无效');
  });
  it('拒绝类型异常或没有已知字段的事件', () => {
    expect(() => parseSSELines('data: {"done":"true"}\n\n', ''))
      .toThrow('生成中断：响应格式无效');
    expect(() => parseSSELines('data: {"unknown":true}\n\n', ''))
      .toThrow('生成中断：响应格式无效');
  });
  it('拒绝冲突状态、false 标记和夹带未知字段的事件', () => {
    for (const payload of [
      '{"error":"LLM_BUSY","done":true}',
      '{"delta":"半章","saved":true}',
      '{"saved":false}',
      '{"done":false}',
      '{"done":true,"unknown":"payload"}',
    ]) {
      expect(() => parseSSELines(`data: ${payload}\n\n`, ''))
        .toThrow('生成中断：响应格式无效');
    }
  });
  it('接受规划完成元数据，拒绝终止帧重复携带版本历史', () => {
    expect(parseSSELines(
      'data: {"done":true,"sections":"规划结果","parsedTitles":["起源","终局"]}\n\n', '',
    ).events).toEqual([{
      done: true, sections: '规划结果', parsedTitles: ['起源', '终局'],
    }]);
    expect(parseSSELines(
      'data: {"done":true,"sections":"无法解析","parseError":true}\n\n', '',
    ).events).toEqual([{ done: true, sections: '无法解析', parseError: true }]);
    expect(() => parseSSELines(
      'data: {"done":true,"versions":["旧版","新版"],"cursor":1}\n\n', '',
    )).toThrow('生成中断：响应格式无效');
    expect(() => parseSSELines(
      'data: {"done":true,"chapterId":"chapter-01","sections":"混合协议"}\n\n', '',
    )).toThrow('生成中断：响应格式无效');
  });
  it('接受完整分部结构卡并拒绝标题错位或缺字段', () => {
    const parsedSections = [{
      title: '起源', summary: '开端', promise: '能力谜团', goal: '活下去',
      obstacle: '追杀', progress: '发现组织', climax: '车站突围',
      payoff: '首次反杀', stateChange: '身份暴露',
    }, {
      title: '终局', summary: '决战', promise: '清算真凶', goal: '终结组织',
      obstacle: '盟友背叛', progress: '进入核心区', climax: '总部决战',
      payoff: '真相公开', stateChange: '旧秩序瓦解',
    }];
    const payload = JSON.stringify({
      done: true, sections: '规划结果', parsedTitles: ['起源', '终局'], parsedSections,
    });
    expect(parseSSELines(`data: ${payload}\n\n`, '').events[0]).toEqual({
      done: true, sections: '规划结果', parsedTitles: ['起源', '终局'], parsedSections,
    });
    expect(() => parseSSELines(`data: ${JSON.stringify({
      done: true, sections: '规划', parsedTitles: ['错位', '终局'], parsedSections,
    })}\n\n`, '')).toThrow('生成中断：响应格式无效');
    expect(() => parseSSELines(`data: ${JSON.stringify({
      done: true, sections: '规划', parsedTitles: ['起源', '终局'],
      parsedSections: parsedSections.map(({ payoff: _payoff, ...item }) => item),
    })}\n\n`, '')).toThrow('生成中断：响应格式无效');
  });
  it('按服务端合同限制终止帧 ID、错误码和规划列表', () => {
    const tooManyTitles = Array.from({ length: 101 }, (_, index) => `部${index}`);
    for (const payload of [
      '{"error":"lowercase error"}',
      JSON.stringify({ error: 'A'.repeat(129) }),
      '{"done":true,"chapterId":"../escape"}',
      '{"done":true,"sections":"规划","parsedTitles":["只有一个"]}',
      '{"done":true,"sections":"规划","parsedTitles":["超过八个字符的分部标题","终局"]}',
      JSON.stringify({ done: true, sections: '规划', parsedTitles: tooManyTitles }),
    ]) {
      expect(() => parseSSELines(`data: ${payload}\n\n`, ''))
        .toThrow('生成中断：响应格式无效');
    }
  });
  it('按章节和大纲终止帧分别限制后处理告警', () => {
    expect(parseSSELines(
      'data: {"done":true,"chapterId":"chapter-01","postprocessWarnings":["digest","review"]}\n\n', '',
    ).events).toEqual([{
      done: true,
      chapterId: 'chapter-01',
      postprocessWarnings: ['digest', 'review'],
    }]);
    expect(parseSSELines(
      'data: {"done":true,"postprocessWarnings":["title"]}\n\n', '',
    ).events).toEqual([{ done: true, postprocessWarnings: ['title'] }]);

    for (const payload of [
      '{"done":true,"chapterId":"chapter-01","postprocessWarnings":[]}',
      '{"done":true,"chapterId":"chapter-01","postprocessWarnings":["digest","digest"]}',
      '{"done":true,"chapterId":"chapter-01","postprocessWarnings":["unknown"]}',
      '{"done":true,"chapterId":"chapter-01","postprocessWarnings":["title"]}',
      '{"done":true,"postprocessWarnings":["review"]}',
      '{"done":true,"postprocessWarnings":["title","review"]}',
      '{"done":true,"sections":"规划","postprocessWarnings":["digest"]}',
      '{"done":true,"sections":"规划","postprocessWarnings":["title"]}',
    ]) {
      expect(() => parseSSELines(`data: ${payload}\n\n`, ''))
        .toThrow('生成中断：响应格式无效');
    }
  });
  it('拒绝无分帧终止符的超大响应残尾', () => {
    expect(() => parseSSELines('x'.repeat(1_700_001), ''))
      .toThrow('生成中断：响应内容超过安全上限');
  });
  it('streamGen 在累计正文超限时中止请求且不接受 done', async () => {
    let requestSignal: AbortSignal | undefined;
    const oversized = '文'.repeat(200_001);
    globalThis.fetch = vi.fn(async (_path, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(
        `data: ${JSON.stringify({ delta: oversized })}\n\ndata: {"done":true}\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const dones: boolean[] = [];
    streamGen('/api/gen/chapter', {}, {
      onDone: (event) => dones.push(Boolean(event.done)),
      onError: (message) => errors.push(message),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestSignal?.aborted).toBe(true);
    expect(errors).toEqual(['生成中断：响应内容超过安全上限']);
    expect(dones).toEqual([]);
  });
  it('streamGen 拒绝用无限注释帧绕过正文上限的累计传输', async () => {
    let requestSignal: AbortSignal | undefined;
    const heartbeat = new TextEncoder().encode(`: ${'x'.repeat(1024 * 1024)}\n\n`);
    const reader = {
      read: vi.fn(async () => ({ done: false, value: heartbeat })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    globalThis.fetch = vi.fn(async (_path, init) => {
      requestSignal = init?.signal ?? undefined;
      return { ok: true, body: { getReader: () => reader } } as unknown as Response;
    }) as unknown as typeof fetch;
    const errors: string[] = [];

    const handle = streamGen('/api/gen/chapter', {}, {
      onError: (message) => errors.push(message),
    });
    await handle.settled;

    expect(reader.read).toHaveBeenCalledTimes(16);
    expect(requestSignal?.aborted).toBe(true);
    expect(errors).toEqual(['生成中断：响应内容超过安全上限']);
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
  it('streamGen 不会把同帧 error + done 同时报成失败和成功', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"error":"LLM_BUSY","done":true}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const errors: string[] = [];
    const dones: boolean[] = [];
    streamGen('/api/gen/chapter', {}, {
      onError: (message) => errors.push(message),
      onDone: (event) => dones.push(Boolean(event.done)),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual(['生成中断：响应格式无效']);
    expect(dones).toEqual([]);
  });
  it('streamGen 遇到损坏完整帧时中止请求且不接受后续 done', async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_path, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(
        'data: {"delta":"损坏"\n\ndata: {"done":true}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    const dones: boolean[] = [];
    streamGen('/api/gen/chapter', {}, {
      onDone: (event) => dones.push(Boolean(event.done)),
      onError: (message) => errors.push(message),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestSignal?.aborted).toBe(true);
    expect(errors).toEqual(['生成中断：响应格式无效']);
    expect(dones).toEqual([]);
  });
  it('streamGen 将非 2xx JSON 响应收敛为 onError', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'BAD_PATH' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

    const errors: string[] = [];
    streamGen('/api/gen/bad', {}, { onError: (m) => errors.push(m) });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual(['页面请求的内容位置无效，请刷新后重试']);
  });
  it('streamGen 将模型配置错误转换为可操作提示', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"error":"LLM_BASE_URL_REQUIRED"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const errors: string[] = [];
    streamGen('/api/gen/chapter', {}, { onError: (m) => errors.push(m) });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual(['请先在 API 设置中填写 Base URL']);
  });
  it('streamGen 在错误终止事件后忽略后续 done，避免同时报失败与成功', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"error":"LLM_BUSY"}\n\ndata: {"done":true}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const errors: string[] = [];
    const dones: boolean[] = [];
    streamGen('/api/gen/chapter', {}, {
      onError: (message) => errors.push(message),
      onDone: (event) => dones.push(Boolean(event.done)),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual(['当前已有较多生成任务，请等待其中一个完成后再试']);
    expect(dones).toEqual([]);
  });
  it('streamGen 在 SSE 正常断开但缺少终止事件时触发 onError', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"delta":"半截"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const deltas: string[] = [];
    const errors: string[] = [];
    streamGen('/api/gen/chapter', {}, {
      onDelta: (d) => deltas.push(d),
      onError: (m) => errors.push(m),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deltas).toEqual(['半截']);
    expect(errors).toEqual(['生成中断：响应未完成']);
  });
  it('streamGen 在响应结束时解析未以空行结尾的终止事件', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"done":true}',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const dones: boolean[] = [];
    const errors: string[] = [];
    streamGen('/api/gen/chapter', {}, {
      onDone: (e) => dones.push(Boolean(e.done)),
      onError: (m) => errors.push(m),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dones).toEqual([true]);
    expect(errors).toEqual([]);
  });
  it('streamGen 在正文落盘事件到达时调用 onSaved', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"saved":true,"chapterId":"chapter-02"}\n\ndata: {"done":true}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const saved: string[] = [];
    streamGen('/api/gen/chapter', {}, {
      onSaved: (event) => saved.push(event.chapterId || ''),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saved).toEqual(['chapter-02']);
  });
  it('streamGen 将异步 onDone 失败收敛为 onError', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"done":true}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const errors: string[] = [];
    streamGen('/api/gen/chapter', {}, {
      onDone: async () => { throw new Error('TREE_RELOAD_FAILED'); },
      onError: (m) => errors.push(m),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual(['TREE_RELOAD_FAILED']);
  });
  it('streamGen 在本地流事件回调失败时主动中止服务端请求', async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_path, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(
        'data: {"delta":"正文"}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    streamGen('/api/gen/chapter', {}, {
      onDelta: async () => { throw new Error('UI_RENDER_FAILED'); },
      onError: (message) => errors.push(message),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requestSignal?.aborted).toBe(true);
    expect(errors).toEqual(['UI_RENDER_FAILED']);
  });
  it('streamGen 本地失败时取消未读响应体并释放 reader 锁', async () => {
    const reader = {
      read: vi.fn(async () => ({
        done: false,
        value: new TextEncoder().encode('data: {"delta":"正文"}\n\n'),
      })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response)) as unknown as typeof fetch;

    const handle = streamGen('/api/gen/chapter', {}, {
      onDelta: async () => { throw new Error('UI_RENDER_FAILED'); },
    });
    await handle.settled;

    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
  it('streamGen 严格拒绝编码损坏的 SSE 并清理 reader', async () => {
    let requestSignal: AbortSignal | undefined;
    const reader = {
      read: vi.fn(async () => ({ done: false, value: new Uint8Array([0xff]) })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    globalThis.fetch = vi.fn(async (_path, init) => {
      requestSignal = init?.signal ?? undefined;
      return { ok: true, body: { getReader: () => reader } } as unknown as Response;
    }) as unknown as typeof fetch;
    const errors: string[] = [];

    const handle = streamGen('/api/gen/chapter', {}, {
      onError: (message) => errors.push(message),
    });
    await handle.settled;

    expect(requestSignal?.aborted).toBe(true);
    expect(errors).toEqual(['生成中断：响应编码无效']);
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
  it('streamGen 用户取消读取时不把浏览器 TypeError 误报为生成失败', async () => {
    let rejectRead!: (error: Error) => void;
    const reader = {
      read: vi.fn(() => new Promise<never>((_resolve, reject) => { rejectRead = reject; })),
      cancel: vi.fn(async () => {}),
      releaseLock: vi.fn(),
    };
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      body: { getReader: () => reader },
    } as unknown as Response)) as unknown as typeof fetch;
    const errors: string[] = [];
    const handle = streamGen('/api/gen/chapter', {}, {
      onError: (message) => errors.push(message),
    });

    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledOnce());
    handle.abort();
    rejectRead(new TypeError('body stream aborted'));
    await handle.settled;

    expect(errors).toEqual([]);
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });
  it('streamGen 的 settled 等待取消中的事件回调真正收尾', async () => {
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_path, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(
        'data: {"delta":"正文"}\n\ndata: {"done":true}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;

    let release!: () => void;
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
    const callbackCanFinish = new Promise<void>((resolve) => { release = resolve; });
    const handle = streamGen('/api/gen/chapter', {}, {
      onDelta: async () => {
        started();
        await callbackCanFinish;
      },
    });

    await callbackStarted;
    handle.abort();
    let settled = false;
    void handle.settled.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(requestSignal?.aborted).toBe(true);

    release();
    await expect(handle.settled).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
  it('streamGen 的 settled 等待异步错误核对回调完成', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"error":"LLM_BUSY"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
    let release!: () => void;
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
    const callbackCanFinish = new Promise<void>((resolve) => { release = resolve; });
    const handle = streamGen('/api/gen/chapter', {}, {
      onError: async () => {
        started();
        await callbackCanFinish;
      },
    });

    await callbackStarted;
    let settled = false;
    void handle.settled.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(handle.settled).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
  it('streamGen 不递归重试抛错的 onError 或留下未处理拒绝', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      'data: {"error":"LLM_BUSY"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as unknown as typeof fetch;

    const onError = vi.fn(async () => { throw new Error('UI_ALREADY_UNMOUNTED'); });
    streamGen('/api/gen/chapter', {}, { onError });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith('当前已有较多生成任务，请等待其中一个完成后再试');
  });
});

describe('book creation request IDs', () => {
  it('generates independent IDs in the server accepted format', () => {
    const first = createClientBookId();
    const second = createClientBookId();

    expect(first).toMatch(/^book_[0-9a-f]{32}$/);
    expect(second).toMatch(/^book_[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it('sends the preallocated ID with a new-book request', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: `book_${'a'.repeat(32)}` }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const requestedBookId = `book_${'a'.repeat(32)}`;
    await createBook('故事设想', undefined, requestedBookId);

    expect(JSON.parse(capturedBody)).toEqual({
      premise: '故事设想', requestedBookId,
    });
  });
});

describe('structure creation anchors', () => {
  it('sends both non-empty and empty last-item anchors', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      const id = requests.length === 1 ? 'section-03' : 'chapter-01';
      return new Response(JSON.stringify({ id }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await addSection('book-1', '终局', 'ai', 'section-02', '【本部目标】终结组织');
    await addChapter('book-1', 'section-03', '序章', null);

    expect(requests).toEqual([
      {
        url: '/api/books/book-1/sections',
        body: {
          title: '终局', titleSource: 'ai', expectedLastSectionId: 'section-02',
          outline: '【本部目标】终结组织',
        },
      },
      {
        url: '/api/books/book-1/sections/section-03/chapters',
        body: { title: '序章', expectedLastChapterId: null },
      },
    ]);
  });
});

describe('book rename anchor', () => {
  it('sends the title visible before editing as a precondition', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ id: 'book-1', title: '新书名' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await renameBook('book-1', '新书名', '旧书名');

    expect(JSON.parse(capturedBody)).toEqual({
      title: '新书名', expectedTitle: '旧书名',
    });
  });
});

describe('book delete anchor', () => {
  it('sends the shelf updatedAt as a required deletion precondition', async () => {
    let captured: { method?: string; headers?: HeadersInit; body?: BodyInit | null } = {};
    globalThis.fetch = vi.fn(async (_url, init) => {
      captured = init ?? {};
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await deleteBook('book-1', '2026-08-06T00:00:00.123Z');

    expect(captured.method).toBe('DELETE');
    expect(captured.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(captured.body))).toEqual({
      expectedUpdatedAt: '2026-08-06T00:00:00.123Z',
    });
  });
});

describe('serialization settings API', () => {
  it('posts the daily goal with its optimistic revision', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        dailyWordGoal: 6000, revision: 'N'.repeat(43),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const result = await saveSerializationSettings('book / 1', 6000, 'R'.repeat(43));

    expect(capturedUrl).toBe('/api/books/book%20%2F%201/serialization/settings');
    expect(JSON.parse(capturedBody)).toEqual({
      dailyWordGoal: 6000, expectedRevision: 'R'.repeat(43),
    });
    expect(result.dailyWordGoal).toBe(6000);
  });

  it('saves and deletes platform confirmation records with encoded paths and revisions', async () => {
    const requests: Array<{ url: string; method?: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      requests.push({
        url: String(url), method: init?.method,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(JSON.stringify({
        dailyWordGoal: 2000, platformConfirmations: [],
        revision: 'N'.repeat(43),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const input = {
      platform: '起点读书', rulesUrl: 'https://example.test/rules',
      aiPolicyUrl: 'https://example.test/ai', contractReference: '已核对合同',
      officialApiStatus: 'not-found' as const, apiDocsUrl: '',
      confirmRules: true, confirmAiPolicy: true, confirmContract: true,
      confirmNoBypass: true,
    };

    await savePlatformConfirmation('book / 1', input, 'R'.repeat(43));
    await deletePlatformConfirmation('book / 1', `platform_${'a'.repeat(32)}`, 'N'.repeat(43));

    expect(requests[0]).toEqual({
      url: '/api/books/book%20%2F%201/platform-confirmations',
      method: 'POST', body: { ...input, expectedRevision: 'R'.repeat(43) },
    });
    expect(requests[1]).toEqual({
      url: `/api/books/book%20%2F%201/platform-confirmations/platform_${'a'.repeat(32)}`,
      method: 'DELETE', body: { expectedRevision: 'N'.repeat(43) },
    });
  });
});

describe('config API', () => {
  it('sends the loaded revision as expectedRevision without persisting it as a config field', async () => {
    let capturedBody = '';
    const revision = 'R'.repeat(43);
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        baseUrl: 'https://example.test/v1', model: 'model-new', apiKey: 'sk-****',
        chapterWordTarget: 2400, requestTimeoutMs: 180000, revision: 'N'.repeat(43),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const saved = await saveConfig({
      baseUrl: 'https://example.test/v1', model: 'model-new', apiKey: 'sk-****',
      chapterWordTarget: 2400, requestTimeoutMs: 180000, revision,
    });

    expect(saved.revision).toBe('N'.repeat(43));
    expect(JSON.parse(capturedBody)).toEqual({
      baseUrl: 'https://example.test/v1',
      model: 'model-new',
      apiKey: 'sk-****',
      chapterWordTarget: 2400,
      requestTimeoutMs: 180000,
      expectedRevision: revision,
    });
  });
});

describe('book backup API', () => {
  it('prepares exports before handing the large download directly to the browser', async () => {
    const link = {
      href: '',
      download: '',
      hidden: false,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const documentRef = {
      createElement: vi.fn(() => link),
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      downloadUrl: '/api/backups/download/123e4567-e89b-12d3-a456-426614174000',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    await downloadBookBackup('book_123', documentRef);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book_123/backup/prepare',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    expect(link.href).toBe('/api/backups/download/123e4567-e89b-12d3-a456-426614174000');
    expect(link.download).toBe('book_123.novelbox.json');
    expect(link.hidden).toBe(true);
    expect(documentRef.body.appendChild).toHaveBeenCalledWith(link);
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it('does not report or trigger a download when backup preparation fails', async () => {
    const link = { click: vi.fn() };
    const documentRef = {
      createElement: vi.fn(() => link),
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'BACKUP_BOOK_INVALID',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    await expect(downloadBookBackup('book_bad', documentRef)).rejects.toThrow('作品主数据异常');

    expect(documentRef.createElement).not.toHaveBeenCalled();
    expect(link.click).not.toHaveBeenCalled();
  });

  it('prepares a pure-text manuscript and returns skipped chapter statistics', async () => {
    const link = {
      href: '', download: '', hidden: false, click: vi.fn(), remove: vi.fn(),
    };
    const documentRef = {
      createElement: vi.fn(() => link), body: { appendChild: vi.fn() },
    } as unknown as Document;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      downloadUrl: '/api/backups/download/123e4567-e89b-12d3-a456-426614174000',
      source: 'current', totalChapterCount: 9, exportedChapterCount: 8,
      skippedChapterCount: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    const result = await downloadBookManuscript('book text', 'current', documentRef);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book%20text/manuscript/prepare',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'current' }),
      },
    );
    expect(result).toEqual({
      source: 'current', totalChapterCount: 9, exportedChapterCount: 8,
      skippedChapterCount: 1,
    });
    expect(link.href).toContain('/api/backups/download/');
    expect(link.download).toBe('book text.current.txt');
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it('shows a specific message when no non-empty manuscript can be exported', () => {
    expect(readableApiError('MANUSCRIPT_EMPTY')).toContain('没有可导出的非空正文');
    expect(readableApiError('BAD_MANUSCRIPT_SOURCE')).toContain('来源无效');
  });

  it('uploads backup bytes as octet-stream and returns the imported book', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify({ id: 'book_new', title: '导入书' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const file = new Blob(['{"format":"backup"}'], { type: 'application/json' });
    const requestedBookId = `book_${'b'.repeat(32)}`;
    const imported = await importBookBackup(file, requestedBookId);
    expect(imported.id).toBe('book_new');
    expect(capturedInit?.headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'X-Novelbox-Book-Id': requestedBookId,
    });
    expect(capturedInit?.body).toBe(file);
  });

  it('rejects empty and oversized backup files before starting an upload', async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const emptyFailure = await importBookBackup(new Blob([])).catch((error) => error);
    const oversizedFailure = await importBookBackup({
      size: 100 * 1024 * 1024 + 1,
    } as Blob).catch((error) => error);

    expect(emptyFailure).toBeInstanceOf(ApiResponseError);
    expect(emptyFailure.code).toBe('BACKUP_INVALID');
    expect(oversizedFailure).toBeInstanceOf(ApiResponseError);
    expect(oversizedFailure.code).toBe('BACKUP_TOO_LARGE');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('distinguishes an explicit server rejection from an unconfirmed transport failure', async () => {
    const rejected = new ApiResponseError('BACKUP_INVALID', 400);
    expect(isAmbiguousApiFailure(rejected)).toBe(false);
    expect(rejected.status).toBe(400);
    expect(isAmbiguousApiFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isAmbiguousApiFailure(new SyntaxError('truncated JSON'))).toBe(true);
  });

  it('treats 5xx responses as unconfirmed because storage may fail after the rename committed', () => {
    expect(isAmbiguousApiFailure(
      new ApiResponseError('STORAGE_IO_ERROR', 500, 'STORAGE_IO_ERROR'),
    )).toBe(true);
    expect(isAmbiguousApiFailure(
      new ApiResponseError('STORAGE_FULL', 507, 'STORAGE_FULL'),
    )).toBe(true);
    expect(isAmbiguousApiFailure(
      new ApiResponseError('BACKUP_EXPORT_BUSY', 429, 'BACKUP_EXPORT_BUSY'),
    )).toBe(false);
  });

  it('preserves the server error code and sends the expected version revision', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ error: 'VERSION_CONFLICT' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    let failure: unknown;
    try {
      await versionSave('book-1', 'outline', '本地草稿', 'R'.repeat(43));
    } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(ApiResponseError);
    expect(isApiErrorCode(failure, 'VERSION_CONFLICT')).toBe(true);
    expect(isAmbiguousApiFailure(failure)).toBe(false);
    expect(JSON.parse(capturedBody)).toEqual({
      path: 'outline',
      text: '本地草稿',
      expectedRevision: 'R'.repeat(43),
    });
  });

  it('does not render or classify an oversized JSON error payload', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'A'.repeat(129),
    }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    let failure: unknown;
    try {
      await versionSave('book-1', 'outline', '本地草稿', 'R'.repeat(43));
    } catch (error) { failure = error; }

    expect(failure).toBeInstanceOf(ApiResponseError);
    expect((failure as ApiResponseError).message).toBe('HTTP 409');
    expect((failure as ApiResponseError).code).toBeUndefined();
  });

  it('treats a truncated successful import response as unconfirmed', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"id":"book_new"', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    let failure: unknown;
    try { await importBookBackup(new Blob(['{}'])); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(isAmbiguousApiFailure(failure)).toBe(true);
  });
});

describe('storage diagnostics API', () => {
  it('uses the explicit deep query only for a user-requested full scan', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true, mode: 'deep', scannedBooks: 1, issues: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    await getStorageDiagnostics(true);

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/storage/diagnostics?deep=1');
  });

  it('将书架、完整性检查和回收站的取消信号传给 fetch', async () => {
    globalThis.fetch = vi.fn(async (url) => new Response(JSON.stringify(
      String(url).includes('/diagnostics')
        ? { ok: true, mode: 'quick', scannedBooks: 0, issues: [] }
        : [],
    ), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const controller = new AbortController();

    await listBooks(controller.signal);
    await getStorageDiagnostics(false, controller.signal);
    await listDeletedBooks(controller.signal);

    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, '/api/books', {
      signal: controller.signal,
    });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/api/storage/diagnostics', {
      signal: controller.signal,
    });
    expect(globalThis.fetch).toHaveBeenNthCalledWith(3, '/api/trash/books', {
      signal: controller.signal,
    });
  });
});

describe('chapter lazy loading API', () => {
  it('loads only the selected chapter from its scoped endpoint', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chapter-03', body: { versions: ['正文'], cursor: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;

    const chapter = await getChapter('book-1', 'section-02', 'chapter-03');

    expect(chapter.id).toBe('chapter-03');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book-1/sections/section-02/chapters/chapter-03',
    );
  });

  it('forwards cancellation to an obsolete chapter request', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: 'chapter-03', body: { versions: ['正文'], cursor: 0 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const controller = new AbortController();

    await getChapter('book-1', 'section-02', 'chapter-03', controller.signal);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book-1/sections/section-02/chapters/chapter-03',
      { signal: controller.signal },
    );
  });
});

describe('chapter review API', () => {
  it('forwards cancellation so leaving the page stops the model request', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      score: 80, verdict: '可用', issues: [], suggestions: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    const controller = new AbortController();

    await reviewChapter(
      'book-1', 'section-01', 'chapter-02',
      'B'.repeat(43), 'C'.repeat(43), controller.signal,
    );

    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/books/book-1/sections/section-01/chapters/chapter-02/review',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedBodyFingerprint: 'B'.repeat(43),
          expectedContextRevision: 'C'.repeat(43),
        }),
        signal: controller.signal,
      },
    );
  });
});

describe('readableApiError', () => {
  it('turns common upstream failures into actionable messages', () => {
    expect(readableApiError('LLM_HTTP_401')).toContain('API Key 无效');
    expect(readableApiError('LLM_HTTP_429: quota exceeded')).toContain('额度不足');
    expect(readableApiError('LLM_HTTP_429: quota exceeded')).toContain('quota exceeded');
    expect(readableApiError('LLM_HTTP_503')).toContain('暂时不可用');
    expect(readableApiError('LLM_NETWORK_ERROR: getaddrinfo ENOTFOUND')).toContain('检查 Base URL');
    expect(readableApiError('LLM_REDIRECT_NOT_ALLOWED')).toContain('最终接口地址');
    expect(readableApiError('LLM_REDIRECT_NOT_ALLOWED')).toContain('API Key');
    expect(readableApiError('LLM_INSECURE_API_KEY_TRANSPORT')).toContain('HTTPS');
    expect(readableApiError('LLM_INSECURE_API_KEY_TRANSPORT')).toContain('明文 HTTP');
    expect(readableApiError('LLM_MODEL_INVALID')).toContain('控制字符');
    expect(readableApiError('LLM_API_KEY_INVALID')).toContain('控制字符');
  });

  it('explains that truncated or malformed streams were not saved', () => {
    expect(readableApiError('LLM_STREAM_INCOMPLETE')).toContain('残缺内容未保存');
    expect(readableApiError('LLM_FINISH_LENGTH')).toContain('长度上限');
    expect(readableApiError('LLM_STREAM_TOO_LARGE')).toContain('异常过多');
    expect(readableApiError('LLM_STREAM_ERROR: LLM_SSE_INVALID_UTF8')).toContain('编码损坏');
    expect(readableApiError('LLM_STREAM_ERROR: LLM_SSE_INVALID_JSON')).toContain('无法解析');
    expect(readableApiError('LLM_STREAM_ERROR: LLM_SSE_INVALID_EVENT')).toContain('字段格式异常');
  });

  it('turns local resource limits into actionable messages', () => {
    expect(readableApiError('REQUEST_TOO_LARGE')).toContain('2 MB');
    expect(readableApiError('PREMISE_TOO_LARGE')).toContain('2 万');
    expect(readableApiError('TEXT_TOO_LARGE')).toContain('20 万');
    expect(readableApiError('BAD_CHAPTER_WORD_TARGET')).toContain('50000');
    expect(readableApiError('LLM_INPUT_TOO_LARGE')).toContain('精简');
    expect(readableApiError('LLM_BUSY')).toContain('等待');
    expect(readableApiError('STORAGE_FULL')).toContain('磁盘空间');
    expect(readableApiError('STORAGE_PERMISSION_DENIED')).toContain('目录不可写');
    expect(readableApiError('STORAGE_PATH_UNSAFE')).toContain('符号链接');
    expect(readableApiError('STORAGE_DIRECTORY_LIMIT_EXCEEDED')).toContain('子项数量');
    expect(readableApiError('STORAGE_JSON_INVALID')).toContain('深度检查');
    expect(readableApiError('STORAGE_DATA_INVALID')).toContain('索引结构异常');
    expect(readableApiError('STORAGE_FILE_TOO_LARGE')).toContain('保护内存');
    expect(readableApiError('BOOK_CHAPTER_LIMIT')).toContain('总章节数');
    expect(readableApiError('BOOK_LIBRARY_LIMIT')).toContain('书架作品数');
    expect(readableApiError('TRASH_BOOK_LIMIT')).toContain('data/trash/books');
    expect(readableApiError('BOOK_TITLE_CONFLICT')).toContain('另一页面');
    expect(readableApiError('BOOK_DELETE_CONFLICT')).toContain('旧书架删除未执行');
    expect(readableApiError('BAD_BOOK_DELETE_ANCHOR')).toContain('更新时间标识');
    expect(readableApiError('BAD_REVIEW_ANCHOR')).toContain('审稿正文或上下文标识');
    expect(readableApiError('BAD_GENERATION_CONTEXT_REVISION')).toContain('生成上下文标识');
    expect(readableApiError('NEXT_SECTION_CONFLICT')).toContain('另一页面');
    expect(readableApiError('NEXT_CHAPTER_CONFLICT')).toContain('另一页面');
    expect(readableApiError('GENERATION_CONTEXT_CONFLICT')).toContain('旧上下文结果未保存');
    expect(readableApiError('STRUCTURE_TRANSACTION_RECOVERED')).toContain('本次操作未执行');
    expect(readableApiError('REVIEW_CONTEXT_STALE')).toContain('重新审稿');
    expect(readableApiError('CONFIG_CONFLICT')).toContain('另一页面');
    expect(readableApiError('BAD_CONFIG_REVISION')).toContain('重新读取设置');
    expect(readableApiError('TRASH_BOOK_INVALID')).toContain('原文件未被修改');
    expect(readableApiError('BOOK_ALREADY_EXISTS')).toContain('未覆盖');
    expect(readableApiError('INTERNAL_ERROR')).not.toContain('INTERNAL_ERROR');
  });

  it('turns reachable validation and review failures into actionable messages', () => {
    const codes = [
      'LLM_EMPTY_BODY',
      'CHAPTER_EMPTY',
      'REVIEW_FAILED',
      'API_KEY_REQUIRED_FOR_BASE_URL_CHANGE',
      'BAD_REQUEST_TIMEOUT',
      'BAD_WHIP',
      'BAD_PATH',
      'BAD_ID',
      'BAD_CONFIG_PATCH',
    ];
    for (const code of codes) expect(readableApiError(code)).not.toBe(code);
    expect(readableApiError('REVIEW_FAILED')).toContain('审稿结果格式不完整');
    expect(readableApiError('CHAPTER_EMPTY')).toContain('正文为空');
    expect(readableApiError('API_KEY_REQUIRED_FOR_BASE_URL_CHANGE')).toContain('重新输入 API Key');
    expect(readableApiError('BAD_REQUEST_TIMEOUT')).toContain('3600000');
  });
});
